# Architecture: 12 AWS service types, 3 independently deployed business Lambdas

```
 Browser ──> CloudFront (optional CDN for large-scale design) ──> S3 static site
   │
   │ Cognito password+EMAIL_OTP MFA: browser talks to our auth endpoints (vehicles Lambda)
   ▼
 API Gateway (single HTTP API with explicit routes)
   ├─→ Lambda A: Vehicle, maintenance, VIN, admin, auth  ─┐
   ├─→ Lambda B: Fuel and expenses                       ├─→ DynamoDB (7 tables, scoped GSIs)
   └─→ Lambda C: Reminders and analytics                 ─┘
                      ▲   │
 EventBridge Scheduler ┘   └─→ SQS queued reminders ─→ Lambda C SQS event ─→ SES email

 Supporting: IAM execution roles, CloudWatch Logs, Cognito user pool
 Optional ALB branch: ALB → IP target group → two stateless Motorlog Express processes;
                 it is an additional application-serving ingress, not ALB → API Gateway → Lambda.
```

## 12 service inventory
1. S3 website
2. API Gateway HTTP API
3. Lambda (3 independent deployment artifacts)
4. DynamoDB (7 owned tables/indexes)
5. Cognito (email-OTP second factor)
6. IAM (service-specific execution roles)
7. CloudWatch Logs
8. EventBridge Scheduler (daily reminders)
9. SES (MFA emails via Cognito mail plumbing; reminder notifications via Lambda)
10. SQS (decoupled reminders; Lambda event source mapping)
11. CloudFront (front-end CDN layer, simulated/configured later)
12. Elastic Load Balancing v2 (ALB alternate ingress demonstration, configured later)

ALB and CloudFront are *not necessary* to scale a serverless API Gateway / Lambda system. They are included to demonstrate production architecture trade-offs. An ALB attached to Lambda does not create extra compute replicas you control; Lambda concurrency is managed by the platform. Do not claim that Floci reproduces real AWS global CDN edge distribution or real million-user capacity.

## Data and service boundaries
- `CMLUsers`, `CMLVehicles`, `CMLMaintenance`, `CMLFuel`, `CMLExpenses`, `CMLReminders`, `CMLAudit`.
- All owned records carry `ownerId` from verified Cognito access JWT's `sub`. Incoming `ownerId` is never accepted.
- Global secondary indexes: `owner-index` on owned tables, `vehicle-index` on dependent records, `owner-date-index` and `vehicle-date-index` (date sort key) on maintenance/fuel/expenses, and `due-index` (status + dueDate) on reminders.
- Vehicle Lambda writes users, vehicles, maintenance and audit. Fuel Lambda writes fuel and expenses, and updates odometer when a later fuel entry is recorded. Reminder Lambda writes reminders and reads owner-scoped aggregates across the other tables.
- Fuel and reminder services confirm vehicle ownership with a conditional record read before operations; record-by-ID updates verify ownerId. IAM policies should limit permissions to specific tables/actions in deployment.
- A user can only delete a vehicle after deleting its child records, preventing orphan data.
- Analytics queries are owner-scoped and calculate totals from stored data. They do not use placeholder trend figures.

## Scale assumptions and honest limitations
- Query GSIs instead of full-table scans for owner data. History and monthly-cost endpoints use date-bounded GSIs; all-time per-owner analytics retain a 2,500-record safety cap.
- A daily scheduler queries the `due-index`; mileage-only reminders surface in the UI but do not generate automated emails unless a calendar date is set. This is a documented limitation.
- SQS delivery is at least once: email duplicates are possible around worker failure. `lastEmailSentOn` reduces common duplicates; production-grade exactly-once effects would require more design.
- Backend is stateless, making it horizontally scalable on AWS Lambda, but Floci runs on a single local Docker host and cannot establish million-user availability or real CDN/ALB throughput.
- IAM policy simulation is not equivalent to deployed AWS IAM enforcement. JWT/ownership checks happen in application code.
- Cognito+SES and ALB capabilities vary across Floci versions; validate live behavior during setup. No credentials are committed.

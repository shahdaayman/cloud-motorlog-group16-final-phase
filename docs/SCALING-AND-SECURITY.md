# Scaling and Security Implementation

## Status legend

- **Configured**: represented in code or an AWS-compatible control-plane resource.
- **Deployed**: accepted by the running Floci API.
- **Tested**: behavior was exercised and evidence was produced.

This implementation extends Motorlog; it does not replace the Lambda/API Gateway deployment, EventBridge Scheduler, SES/SQS reminder flow, DynamoDB tables, or existing ALB.

## Architecture and services

The local ALB forwards round-robin traffic to three independent Node.js processes on ports 3101, 3102, and 3103. Those processes remain the executable load-balancing/failover test environment. `motorlog-cluster` also records a Fargate-compatible task definition (`motorlog-backend-task`, 256 CPU, 512 MB), service (`motorlog-backend-service`, desired count 1), health check, log configuration, and least-privilege task roles. Floci may record ECS state without launching a container, so `desiredCount` is not proof of a running task; inspect `runningCount` and `list-tasks`.

Application Auto Scaling registers `service/motorlog-cluster/motorlog-backend-service` at 1–4 tasks with a 50% ECS average CPU target. SNS extends notifications without replacing SES/SQS. The custom EventBridge bus is separate from the existing Scheduler. Its audit rule invokes `motorlog-audit-logger`, which writes a bounded, non-sensitive record to `/motorlog/events/audit`; this Lambda bridge replaces direct EventBridge-to-Logs delivery because Floci does not support that target type. Secrets Manager supplies non-public runtime configuration while local development retains `.env`; production startup fails if an explicitly configured secret cannot be read.

Existing services reused: S3, DynamoDB, SQS, Lambda, API Gateway, Cognito, SES, CloudWatch, IAM, CloudFront, EventBridge Scheduler, ALB, target group, ECS cluster. New scaling and security resources: ECS task/service/roles, scalable target/policy, third ALB target, SNS topic, EventBridge bus/rule/log target, Secrets Manager secret, general API rate limiting, audit event publishing, Docker image definition, and k6 experiments.

## Deploy

Prerequisites: Floci at `http://localhost:4566`, AWS CLI profile `floci` (or local test credentials), Docker, Node.js 22, and dependencies installed.

```powershell
$env:AWS_PROFILE='floci'
$env:AWS_REGION='us-east-1'
$env:AWS_ENDPOINT_URL='http://localhost:4566'
npm install
docker build -t motorlog-backend:scale-security .
npm run cloud-services:deploy
npm run alb:deploy
```

`scripts/deploy-scale-security.ps1` is idempotent where Floci permits. It writes generated CLI JSON only under ignored `dist/`. An alternate image can be supplied as `MOTORLOG_ECS_IMAGE`. Because Floci may not implement ECS data-plane networking, the ECS service deliberately records a valid task/service without claiming task execution or replacing the local targets. If the emulator supports service load-balancer attachment, add it only after confirming its `awsvpc`/IP target implementation; the existing target group is preserved.

Optional SNS subscribers are environment-specific. For a supported local HTTP endpoint:

```powershell
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 sns subscribe --topic-arn arn:aws:sns:us-east-1:000000000000:motorlog-notifications-topic --protocol http --notification-endpoint http://host.docker.internal:PORT/sns
```

Do not add a real email subscription merely for local verification.

## Verification

```powershell
npm run cloud-services:verify
npm run alb:verify
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 ecs describe-task-definition --task-definition motorlog-backend-task
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 ecs describe-services --cluster motorlog-cluster --services motorlog-backend-service
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 ecs list-tasks --cluster motorlog-cluster --service-name motorlog-backend-service
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 application-autoscaling describe-scalable-targets --service-namespace ecs
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 application-autoscaling describe-scaling-policies --service-namespace ecs
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 elbv2 describe-target-health --target-group-arn TARGET_GROUP_ARN
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 sns list-topics
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 events describe-rule --event-bus-name motorlog-event-bus --name motorlog-audit-rule
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 secretsmanager describe-secret --secret-id motorlog-app/config
```

Test EventBridge delivery without personal data:

```powershell
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 events put-events --entries '[{"Source":"motorlog.application","DetailType":"VehicleCreated","Detail":"{\"vehicleId\":\"eventbridge-test\"}","EventBusName":"motorlog-event-bus"}]'
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 logs filter-log-events --log-group-name /motorlog/events/audit
```

Direct EventBridge-to-CloudWatch Logs routing is not used because it is unsupported by Floci 2.5.0. Deployment removes only the obsolete `motorlog-audit-logs` rule target and preserves the log group and stored records. The supported path is `motorlog-event-bus` → `motorlog-audit-rule` → `motorlog-audit-logger` → `/motorlog/events/audit`. Verification publishes a unique synthetic event, captures the EventBridge-generated event ID, and polls the dedicated log stream until that same ID appears; resource existence or a successful `PutEvents` response alone is not considered delivery proof.

## ALB distribution and failover

`npm run alb:targets` safely starts missing targets and retains existing live PIDs. `npm run alb:restart` stops only manifest-listed Node processes and restarts all three. `npm run alb:verify` checks health, observes all three instance headers, stops `motorlog-b`, waits for it to become unhealthy, verifies continued responses from `motorlog-a` and `motorlog-c`, then restores `motorlog-b` in `finally`.

Manual stop/restart:

```powershell
$m=Get-Content dist/alb-targets.json -Raw|ConvertFrom-Json
$t=$m.targets|Where-Object id -eq 'motorlog-b'
Get-Process -Id $t.pid # verify Node before stopping
Stop-Process -Id $t.pid
npm run alb:targets
```

## Security controls

- Helmet emits CSP, frame denial, content-type protection, and other defaults. The frontend CSP remains compatible with self-hosted scripts and the documented API/NHTSA/font endpoints.
- JSON is strict and capped at 64 KiB. Route schemas reject unknown fields and bound strings, numbers, dates, VINs, pagination, and enum values. JSON rendering provides context-appropriate output escaping; no destructive blanket sanitization is applied to valid vehicle data.
- General per-process API throttling defaults to 120 requests/minute and returns 429. Health checks are excluded. Express does not trust forwarded headers by default, preventing client `X-Forwarded-For` spoofing. Set `TRUST_PROXY_HOPS=1` only when exactly one trusted proxy is in front.
- Security logs are structured and omit bodies, tokens, OTPs, passwords, and secret values. Failed authorization, invalid input, rate-limit violations, notification/event failures, and existing admin audit records are covered.
- The Secrets Manager IAM policy is scoped to `motorlog-app/config*`; values are never logged. `.env` remains ignored and supported locally.

## k6 experiments

Install Grafana k6, then use the same staged profile and thresholds for all runs:

```powershell
npm run load-tests:run -- -Run A # direct :3101, keep one target for the experiment
npm run load-tests:run -- -Run B # three targets through ALB
npm run load-tests:run -- -Run C # automatically stop and recover motorlog-b during sustained load
```

The script exports `dist/k6-run-A.json`, `B`, and `C`. Thresholds are p95 under 500 ms and failures under 5%; they are targets, not promised results. The test hits only `/api/health`, avoiding mutation of user data. No performance result is recorded here until k6 actually runs.

## Actual results and limitations

Control-plane verification on 2026-11-23 (Africa/Cairo) observed: ECS service ACTIVE with desired 1, running 0, pending 0; task definition revision 2; three target-group registrations healthy; and SNS test publishing returned a MessageId. The manually verified audit pipeline accepted EventBridge event ID `2d921296-f461-4db1-a1a8-d69363230dfc`, and the same ID appeared in `/motorlog/events/audit`. `npm run cloud-services:verify` now repeats this as a genuine end-to-end assertion with a new unique synthetic event on every run. k6 availability and results remain reported separately.

Populate this table only from command output:

| Run | Endpoint | Throughput | p95 | Failure rate | Evidence |
|---|---|---:|---:|---:|---|
| A | single instance | Not executed | Not executed | Not executed | `dist/k6-run-A.json` |
| B | three-instance ALB | Not executed | Not executed | Not executed | `dist/k6-run-B.json` |
| C | ALB failover | Not executed | Not executed | Not executed | `dist/k6-run-C.json` |

Floci limitations can include recorded-only ECS services, no real CPU metric loop, unsupported direct EventBridge-to-Logs targets, and partial SNS subscription protocols. The supported audit Lambda bridge is used instead. No CPU-triggered scaling or managed container execution is claimed unless `runningCount`, task state, CloudWatch metrics, and scaling activity prove it.

## Screenshot evidence checklist

- ECS task definition CPU/memory, health check, roles, revision
- ECS service desired/running count and task list
- scalable target and target-tracking policy
- three healthy target group entries and distribution output
- unhealthy target during failover plus successful survivor requests
- SNS topic and a non-sensitive published test
- EventBridge bus, rule pattern, Lambda target, invocation permission, and matching end-to-end log event
- secret metadata only (never its value)
- 429 response, validation 400, CSP/security headers, structured security log
- k6 A/B/C summaries with timestamp and endpoint

## Architecture comparison

The required scaling architecture is represented faithfully in the control plane, while Motorlog uses three local Node processes for observable round-robin/failover because the emulator may not launch ECS tasks. Target tracking is configured but not described as real scaling without evidence. SNS and a custom event bus extend the existing SES/SQS/Scheduler design. Security controls are application-aware and preserve authentication, frontend behavior, existing data, and APIs.

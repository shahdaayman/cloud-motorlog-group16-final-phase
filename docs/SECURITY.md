# Threat model, authorization and security verification

## Roles
- Anonymous: signup/confirm/login/verify-otp/reset requests only; every vehicle, expense, reminder and admin route rejects anonymous users.
- User: authorized only for their own `ownerId` records. No incoming client `ownerId` is used; backend uses the verified Cognito access token's `sub` claim.
- Admin: may read a limited list of accounts and change account Active/Disabled status, with audit events. Admin does **not** automatically receive access to private vehicle/fuel/maintenance details; account operations are separate.

## Implemented controls
- Cognito password + mandatory email OTP second factor; backend forwards challenge/session to Cognito and never returns tokens before successful challenge completion.
- JWT RS256 verification via Cognito JWKS, exact issuer, token-use and app-client checks; expired tokens rejected. Default local issuer is `http://localhost:4566/<USER_POOL_ID>`.
- Express route middleware checks JWT and account status for all protected APIs; privileged actions require group `Admin`.
- Auth rate limiting; JSON body 64-KB limit; explicit allowed input fields; strict dates, numbers, VIN formats, enum values and mileage validation.
- DynamoDB data is always filtered by authenticated `ownerId`; records fetched by ID check owner before editing/deleting. Vehicle ownership is checked in other services before creating child records.
- Audit actions record actor/action/target/result, not tokens, OTPs or passwords; structured access logs include method, path, status, timing.
- CORS allow-list and `helmet` browser headers; CORS alone is not an access-control boundary.
- No `.env` values in Git. Secret values are separate from source and absent from frontend.

## Threats and mitigations
| Threat | Mitigation |
|---|---|
| Stolen/forged or expired JWT | RS256 signature, issuer, token use, client ID and expiry checks; MFA at login |
| Bypassing OTP with password only | Backend `REQUIRE_MFA=true` fails closed if Cognito returns tokens without a challenge |
| Horizontal broken object-level authorization | Ownership check from JWT `sub` before each object read/write |
| Admin privilege escalation | Backend checks signed Cognito group, not a client-provided role |
| Malformed input / extreme numeric amounts | Explicit allow-lists, finite-range validation, safe JSON errors |
| Arbitrary VIN output / public API outage | Bounded timeout, limit returned attributes, safe failure and manual input |
| Credential or token exposure | .env ignored, no request-body or token logging, frontend doesn't persist tokens |
| Repeated auth guessing | Per-IP auth rate limiting; production add gateway/WAF limits |
| Accidental data loss / orphan records | Block parent deletion while child rows exist; scripts can recreate schema |
| Overload / slow massive queries | GSI owner and due queries, 2,500 record guard, bounded load test; pagination needed for production |

## Controlled security-test table (perform on running Floci before final demo)
1. GET /api/vehicles without Bearer → 401.
2. GET /api/admin/users without Bearer → 401.
3. Login with correct password while email MFA required → OTP challenge, **no access token**.
4. Wrong MFA OTP → denied, no access token; expired/reused code denied by Cognito.
5. GET /api/vehicles with fabricated JWT → 401.
6. User A reads/edits User B vehicle ID → 404 and no mutation.
7. User A edits User B fuel/expense/reminder ID → 404 and no mutation.
8. User (not Admin) calls PATCH /api/admin/users/{id}/status → 403.
9. POST a fuel record with negative cost or litres → 400.
10. POST a maintenance record with ownerId in JSON → 400.
11. POST NHTSA decode for malformed VIN → 400.
12. Search browser code and Git repository for `.env`, credentials, tokens and passwords → none committed.
13. Retry repeated bad login; verify rate limit response 429.
14. Verify CloudWatch logs show no password, access token or OTP values.
15. For disabled account, existing token call → backend 403.

## Failure recovery
- Export DynamoDB table data on a scheduled or pre-release basis. Re-run `npm run db:prepare` for lost schema; **this does not restore records**.
- Keep deployment manifest (`infra/api-routes.json`) and built ZIPs source reproducible.
- Restore from backups for record loss; mark missing backups as residual risk rather than pretending schema recreation restores data.
- Queue worker is idempotent for common duplicates using `lastEmailSentOn`, but concurrent retries can still cause duplicate delivery.

## Cloud responsibility differences
Floci stores IAM policies but the emulator does not necessarily enforce them by default. Service-specific roles should still be created for AWS-correct design; runtime security tests must prove the application-layer checks. The team, not Floci, is responsible for business authorization, input validation, secure configuration, monitoring and incident response.

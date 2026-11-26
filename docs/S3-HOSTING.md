# Motorlog frontend hosting on Floci S3

## Deployment model

The bucket is `motorlog-frontend` in `us-east-1`. Deployment uploads only allow-listed files under `frontend`: HTML, CSS, JavaScript, supported images, icons and web fonts. Backend files, `.env`, packages, Lambda ZIPs, tests and evidence are never selected. Deployment is additive and does not delete existing objects.

The source `frontend/js/config.js` remains same-origin for `http://localhost:3000`.
During S3 deployment, `Get-MotorlogApiDeployment` discovers the current `motorlog-api`
ID and its deployed stage from Floci. The upload receives a public, non-secret API URL
in the form `http://localhost:4566/restapis/<API_ID>/<STAGE>/_user_request_`. No API ID
or stage is hardcoded.

Authentication remains enforced by Cognito-backed middleware in the Lambda services. Access and MFA tokens stay in browser session storage and are never uploaded to S3.

## Security and website status

All four S3 public-access-block settings remain enabled. The bucket has website index/error
configuration but no public bucket policy. The primary deployed frontend uses the existing
private S3 origin through the `Motorlog Frontend` CloudFront distribution and its origin
access control. S3 website endpoints normally require public read access and cannot use a
private origin access control; that tradeoff is not used for the primary site.

The authenticated object locations are `s3://motorlog-frontend/index.html` and `s3://motorlog-frontend/admin/index.html`. Floci currently serves the controlled emulator website at `http://motorlog-frontend.s3-website.localhost.localstack.cloud:4566/`, including `/admin/`. It also serves path-style objects at `http://localhost:4566/motorlog-frontend/index.html`. Because Floci IAM enforcement is not enabled, anonymous retrieval currently succeeds even though all public-access-block settings are configured. This emulator behavior is not evidence that a real AWS private bucket would be public.

The API permits both the controlled Floci website origin and existing localhost origins, including `Authorization` and `Content-Type` headers and `OPTIONS` handling. Do not use wildcard credentialed CORS.

## Commands

From the repository root in PowerShell or Git Bash:

```cmd
npm run s3:deploy
npm run s3:status
npm run s3:verify
npm run check
aws --region us-east-1 --endpoint-url http://localhost:4566 s3api get-object --bucket motorlog-frontend --key index.html dist\manual-index.html
aws --region us-east-1 --endpoint-url http://localhost:4566 s3api head-object --bucket motorlog-frontend --key admin/index.html
```

If no AWS profile is selected, the project helper uses only the conventional `test` credentials required by the local Floci emulator. No production credentials are written to disk.

Use `./start-motorlog.ps1 --status` or `bash start-motorlog.sh --status` to discover and
verify the current CloudFront and API Gateway URLs. Run a browser-level sign-in, MFA, and
Admin-routing test with authorized test accounts after deployment.

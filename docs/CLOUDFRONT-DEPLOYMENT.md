# Motorlog CloudFront deployment on Floci

## Last verified deployed resource

These identifiers describe the installation verified on 24 November 2026. They are not
portable to a fresh Floci volume. The cloud manager discovers the current distribution by
the comment `Motorlog Frontend` and constructs the verified emulator URL dynamically.

- Comment/name: `Motorlog Frontend`
- Distribution ID: `E9R4PRGCHFESF7`
- ARN: `arn:aws:cloudfront::000000000000:distribution/E9R4PRGCHFESF7`
- Working local URL: `http://e9r4prgchfesf7.cloudfront.localhost.localstack.cloud:4566`
- API-reported domain: `e9r4prgchfesf7.cloudfront.net` (not locally DNS-resolvable)
- Existing origin: `motorlog-frontend.s3.us-east-1.amazonaws.com`, origin ID `motorlog-frontend-s3`
- OAC: `motorlog-frontend-oac`, ID `83418090-eb42-4fd5-a532-19cfec0c075f`, SigV4 signing `always`
- Default root object: `index.html`

No second bucket or API was created. The S3 origin remains `motorlog-frontend`, with all public-access-block flags enabled. Floci's global IAM enforcement remains disabled, so OAC configuration demonstrates the AWS-correct design but local successful reads do not prove IAM enforcement.

The S3 deployment also uploads `admin/index.html` as the exact `admin/` object. S3 REST origins do not apply website directory-index behavior, so this alias makes the requested CloudFront `/admin/` URL work while retaining OAC compatibility. The original S3 website remains unchanged.

## Caching and invalidation

HTML and generated `js/config.js` use `Cache-Control: no-cache, no-store, must-revalidate`. CSS, JavaScript and other static assets use `public, max-age=3600`. The distribution has a zero-TTL `*.html` behavior and a default TTL of 3600 seconds (maximum 86400), while honoring object cache metadata. Compression is enabled.

`npm run cloudfront:invalidate` submits a unique `/*` invalidation. The deployment invokes it after every frontend upload. Deployment invalidation `ISM7Y79WLNIC7B` was accepted by Floci.

## CORS and authorization

The exact working origin was appended to each existing Lambda's `CORS_ORIGINS` without removing:

- `http://localhost:3000`
- `http://localhost:8080`
- `http://localhost:4566`
- `http://motorlog-frontend.s3-website.localhost.localstack.cloud:4566`

Both `/api/vehicles` and `/api/admin/overview` return successful preflights for `GET` with `Authorization, Content-Type`, echoing the exact CloudFront origin. Unauthenticated requests to both return `401` with the same CORS origin. Express still requires exact origins; no wildcard credentialed CORS or `no-cors` mode is used. Browser code continues to send `Authorization: Bearer ...`; Admin group checks and Cognito JWT verification were not changed.

Authenticated DynamoDB retrieval, Admin statistics, and session persistence require an existing user's password plus MFA OTP or an already signed-in browser session. Neither was available during deployment, and changing users/MFA was prohibited. Those three browser assertions are therefore not claimed as passed. Run the manual verification below with an existing regular user and existing Admin account.

## Commands

From the repository root:

```cmd
npm run cloudfront:deploy
npm run cloudfront:status
npm run cloudfront:verify
npm run cloudfront:invalidate
npm run check
```

If the local `floci` profile is unavailable, leave `AWS_PROFILE` unset; the shared helper uses emulator-only `test` credentials and still targets `http://localhost:4566`.

After signing in through the CloudFront URL, verify real dashboard records, refresh the page to prove session storage restoration, and open `/admin/` with an existing Admin account to verify statistics. Developer Tools should show the Bearer header on API calls. A regular account must receive `403` on `/api/admin/overview`.

## Rollback

Rollback disables only the discovered distribution; it does not delete S3 objects, the
API, users, Lambdas, tables, queues, or schedules. In PowerShell, discover the current ID:

```powershell
$distributionId = aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 cloudfront list-distributions --query "DistributionList.Items[?Comment=='Motorlog Frontend'].Id | [0]" --output text
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 cloudfront get-distribution-config --id $distributionId > dist\cloudfront-rollback-config.json
```

Edit the saved JSON to retain only `DistributionConfig`, set `Enabled` to `false`, then update it using the returned ETag:

```powershell
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 cloudfront update-distribution --id $distributionId --if-match ETAG --distribution-config file://dist/cloudfront-rollback-config.json
```

The original development server (`npm run dev`) and S3 website remain independent and operational. Re-running `npm run cloudfront:deploy` reuses the existing named distribution rather than creating a second one. After an intentional rollback, set `Enabled` back to `true` with `update-distribution` before deploying again.

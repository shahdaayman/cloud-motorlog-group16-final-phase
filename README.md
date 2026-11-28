# Motorlog — Setup, Run, and Verify

**Group 16 · Cloud Computing & Cloud Security · BUE · 2026–2027**

Follow these steps **in Windows PowerShell**.

## 1. Install prerequisites and Node modules

Install **Node.js 22+**, **Docker Desktop** (Linux containers), **AWS CLI v2**, **Git for Windows**, and **PowerShell**. Start Docker Desktop.

```powershell
node --version
npm --version
git --version
docker --version
aws --version
docker info
```

```powershell
git clone https://github.com/shahdaayman/cloud-motorlog-group16-final-phase.git
cd cloud-motorlog-group16-final-phase
npm ci
npm ci --prefix smtp-bridge
```

## 2. Configure the local environment

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

```powershell
aws configure set aws_access_key_id test --profile floci
aws configure set aws_secret_access_key test --profile floci
aws configure set region us-east-1 --profile floci
```

**Check (after starting Floci in Step 3):**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 sts get-caller-identity
```

## 3. Start Floci and choose OTP email delivery

### Option A — Local SES capture (no Gmail password)

```powershell
docker compose -f infra/floci/docker-compose.yml up -d --wait
```

**Check:**

```powershell
curl.exe -i http://localhost:4566/_floci/health
docker compose -f infra/floci/docker-compose.yml ps
```

**Expected:** `HTTP/1.1 200 OK` 

### Option B — Gmail SMTP (real OTP emails)

**B1. Enable Google 2-Step Verification:** Sign in to the *sending* Gmail account, visit <https://myaccount.google.com/security>, and enable **2-Step Verification** under **How you sign in to Google**.

**B2. Create an App Password:** Visit <https://myaccount.google.com/apppasswords> with the same account, enter a name such as **Motorlog SMTP**, select **Create**, and copy the generated 16-character App Password.

**B3. Save private configuration:**

```powershell
if (-not (Test-Path smtp.env)) { Copy-Item smtp.env.example smtp.env }
notepad smtp.env
```

Set these entries using your own details (do not publish the values):

```dotenv
SMTP_EMAIL=your-sending-address@gmail.com
SMTP_APP_PASSWORD=your-16-character-app-password
SMTP_ALLOW_ANY_RECIPIENT=true
```
**B4. Start the SMTP bridge and Floci:**

```powershell
docker compose --env-file smtp.env -f infra/floci/docker-compose.yml -f infra/floci/docker-compose.gmail.yml up -d --build --wait
```

**Check:**

```powershell
docker compose --env-file smtp.env -f infra/floci/docker-compose.yml -f infra/floci/docker-compose.gmail.yml ps
curl.exe -i http://localhost:4566/_floci/health
```

**Test an email inbox with:**

```powershell
.\start-motorlog.ps1 --email-mode gmail --test-email your-test-recipient@gmail.com
```

## 4. Initialize DynamoDB and Cognito (fresh Floci only)

```powershell
npm run db:prepare
```

**Check — DynamoDB:**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 dynamodb list-tables
```

**Expected:** `TableNames` includes **all eight**: `CMLUsers`, `CMLVehicles`, `CMLMaintenance`, `CMLFuel`, `CMLExpenses`, `CMLReminders`, `CMLAudit`, `CMLAuthRateLimits`.

```powershell
npm run auth:setup
node scripts/update-otp-email.js
```

**Check — Cognito:**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 cognito-idp list-user-pools --max-results 60
```

**Expected:** `UserPools` contains the Motorlog pool (named `CML-Group16-Users`). 

## 5. Deploy Lambda → IAM → API Gateway (corrected order)

### 5A. Lambda functions

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-lambdas.ps1
```

**Check — Lambda state:**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 lambda list-functions --query "Functions[].[FunctionName,State,Role]" --output table
```

**Expected:** Three entries, all `Active`:

```text
cml-vehicles   Active   arn:aws:iam::000000000000:role/motorlog-vehicles-runtime
cml-fuel       Active   arn:aws:iam::000000000000:role/motorlog-fuel-runtime
cml-reminders  Active   arn:aws:iam::000000000000:role/motorlog-reminders-runtime
```
### 5B. Dedicated IAM roles

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-iam-security.ps1
```

**Check — IAM and Lambda role assignments:**

```powershell
npm run iam:verify
aws --profile floci --endpoint-url http://localhost:4566 lambda list-functions --query "Functions[].[FunctionName,State,Role]" --output table
```

**Expected:** IAM verification passes and all three Lambda functions report `Active` with their matching dedicated `motorlog-*-runtime` roles.

### 5C. API Gateway

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-api.ps1
```

**Check — discover your API ID (it will differ on each machine):**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 apigateway get-rest-apis --query "items[].[name,id]" --output table
$ApiId = aws --profile floci --endpoint-url http://localhost:4566 apigateway get-rest-apis --query "items[?name=='motorlog-api'].id | [0]" --output text
Write-Host "Motorlog API ID: $ApiId"
```

**Expected:** A row containing `motorlog-api` and a generated ID, for example `07be393592`.

**Check — deployed stages:**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 apigateway get-stages --rest-api-id $ApiId
```

**Expected:** An `item` entry with `stageName: "dev"` and a nonempty `deploymentId`.

**Fix if the API exists but the response is `{"item":[]}` or `/api/health` says `{"message":"Stage not found"}`:**

1. First inspect the `deploy-api.ps1` output. A missing Lambda `GetPolicy` resource can be normal at **first-run**, but other errors may mean the routes or permissions were not configured.
2. Confirm that the API resources and methods were created:

```powershell
aws --profile floci --endpoint-url http://localhost:4566 apigateway get-resources --rest-api-id $ApiId
```

**Expected:** Resources for the intended API routes, not just the root `/`. If resources are missing, fix/re-run `scripts/deploy-api.ps1` before creating a stage.

3. If the routes and permissions are configured but `dev` is missing, create its deployment:

```powershell
aws --profile floci --endpoint-url http://localhost:4566 apigateway create-deployment --rest-api-id $ApiId --stage-name dev --description "Motorlog initial API deployment"
aws --profile floci --endpoint-url http://localhost:4566 apigateway get-stages --rest-api-id $ApiId
```

**Expected:** The first command returns a generated deployment `id`; the second shows a `dev` stage referring to that deployment.

**Final API health check:**

```powershell
curl.exe -i "http://${ApiId}.execute-api.localhost.localstack.cloud:4566/dev/api/health"
```

**Expected:** `HTTP/1.1 200 OK` and JSON similar to:

```json
{"status":"ok","service":"vehicles","runtime":"lambda","timestamp":"<generated timestamp>"}
```

This verifies the API Gateway → vehicles Lambda health path. Fuel and reminders require separate route checks.

## 6. Deploy the remaining cloud services and check each one

### 6A. Amazon S3 (frontend hosting)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-s3-frontend.ps1
npm run s3:verify
```

### 6B. Amazon CloudFront

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-cloudfront.ps1
npm run cloudfront:verify
```

### 6C. Automatic reminder confirmation and deadline emails (EventBridge Scheduler, SQS, Lambda, SES)

**Prerequisites:** Deploy the `cml-reminders` Lambda and configure DynamoDB, Cognito, the notification SQS queue and event-source mapping, SES, and the Gmail SMTP bridge (Step 3, Option B) to deliver to a real inbox. The Floci and SMTP bridge containers must remain running for local email delivery.

On a **fresh installation**, deploy the reminder automation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-reminder-automation.ps1
```

On an **existing installation**, inspect and enable the daily schedule as needed:

```powershell
npm run reminders:status
npm run reminders:enable
```
#### How notifications work

1. **Immediately after a reminder is created:** The backend persists the reminder, queues a `REMINDER_CREATED` confirmation through **SQS → Lambda → SES → Gmail SMTP bridge**, and the UI reports that the email was queued. The subject is **Motorlog — Reminder Created Successfully**. Recipient email is resolved and verified through Cognito, not accepted from the browser.
2. **One Cairo calendar day before the due date:** For an eligible **open** reminder, the 9:00 AM scheduled check queues a second email with subject **Motorlog — Maintenance Due Tomorrow**. For example, a reminder due **December 10** is eligible for the scheduled email on **December 9 at 9:00 AM Cairo time**.
3. **Late-created reminders:** If created after the previous day's 9:00 AM window, or when already due/overdue, the confirmation still describes the due date accurately; the application does not promise a pre-deadline notification whose window has already passed. Reminders with no date do not receive date-based deadline emails.

**Inspect or pause/resume automatic reminders:**

```powershell
npm run reminders:status
npm run reminders:disable
npm run reminders:enable
aws --profile floci --endpoint-url http://localhost:4566 sqs list-queues
aws --profile floci --endpoint-url http://localhost:4566 scheduler list-schedules
```
### 6D. Amazon CloudWatch

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-monitoring.ps1
npm run monitoring:status
```
### 6E. Application Load Balancer (ALB)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-alb.ps1
npm run alb:verify
```
### 6F. ECS, Application Auto Scaling, SNS, EventBridge audit bus, and Secrets Manager

```powershell
npm run cloud-services:deploy
```

Now verify the individual services:

**ECS:**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 ecs list-clusters
aws --profile floci --endpoint-url http://localhost:4566 ecs describe-services --cluster motorlog-cluster --services motorlog-backend-service --query "services[].[status,runningCount,desiredCount]" --output table
```

**Application Auto Scaling:**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 application-autoscaling describe-scalable-targets --service-namespace ecs
```

**SNS:**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 sns list-topics
```

**Expected:** `motorlog-notifications-topic` appears among topic ARNs.

**EventBridge (audit pipeline):**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 events list-event-buses
npm run cloud-services:verify
```

**Secrets Manager:**

```powershell
aws --profile floci --endpoint-url http://localhost:4566 secretsmanager list-secrets --query "SecretList[].Name" --output table
```


**Check:**

```powershell
npm run check
npm run smtp:test
```

## 7. Start Motorlog and check deployed links

For local SES mode:

```powershell
.\start-motorlog.ps1 --email-mode local
```

For Gmail mode:

```powershell
.\start-motorlog.ps1 --email-mode gmail
```

Open the deployed frontend automatically:

```powershell
.\start-motorlog.ps1 --open
```

## 8. Create an Admin account (Cognito)

**Prerequisites:** Complete Step 4 (Cognito setup) and deploy the API and frontend. Use a dedicated test account that you control. There is no default admin password and **normal signup does not automatically grant Admin privileges**.

**1. Register and confirm a normal account** through the Motorlog CloudFront website. Complete the signup confirmation email/OTP process before granting administrator access.

**2. Discover the actual Cognito user pool** in your own Floci installation (the pool ID varies):

```powershell
$Endpoint = 'http://localhost:4566'
$Pools = @( (aws --profile floci --endpoint-url $Endpoint cognito-idp list-user-pools --max-results 60 | ConvertFrom-Json).UserPools | Where-Object { $_.Name -eq 'CML-Group16-Users' } )
if ($Pools.Count -ne 1) { throw 'Expected one Motorlog user pool. Run npm run auth:setup, then check cognito-idp list-user-pools.' }
$PoolId = $Pools[0].Id
Write-Host "Motorlog pool ID: $PoolId"
```

**3. Find the confirmed account** by its registration email. Enter the address you actually registered:

```powershell
$AdminEmail = Read-Host 'Email of the confirmed account to promote'
$Users = @((aws --profile floci --endpoint-url $Endpoint cognito-idp list-users --user-pool-id $PoolId --filter ('email = "{0}"' -f $AdminEmail) | ConvertFrom-Json).Users)
if ($Users.Count -ne 1) { throw 'Expected exactly one account with this email. Confirm signup before continuing.' }
$AdminUser = $Users[0]
if ($AdminUser.UserStatus -ne 'CONFIRMED') { throw 'Account is not CONFIRMED. Complete signup confirmation first.' }
Write-Host "Confirmed Cognito username: $($AdminUser.Username)"
```

**4. Verify the Admin group exists, then add this account to it:**

```powershell
$Groups = @((aws --profile floci --endpoint-url $Endpoint cognito-idp list-groups --user-pool-id $PoolId | ConvertFrom-Json).Groups)
if (-not @($Groups | Where-Object GroupName -eq 'Admin').Count) { throw 'Admin group is missing. Verify Cognito setup before proceeding.' }
aws --profile floci --endpoint-url $Endpoint cognito-idp admin-add-user-to-group --user-pool-id $PoolId --username $AdminUser.Username --group-name Admin
if ($LASTEXITCODE -ne 0) { throw 'Failed to assign the Admin group.' }
```

**5. Verify the group membership:**

```powershell
aws --profile floci --endpoint-url $Endpoint cognito-idp admin-list-groups-for-user --user-pool-id $PoolId --username $AdminUser.Username --query 'Groups[].GroupName' --output table
```

**Expected:** The returned groups include `Admin`.

**6. Sign out and sign back in** to Motorlog with the promoted account, including its login OTP, so Cognito issues **new tokens containing the Admin group claim**.

## 9. Final verification commands

Run these after provisioning their corresponding resources:

```powershell
npm run check
npm run smtp:test
npm run smoke
npm run s3:verify
npm run cloudfront:verify
npm run alb:verify
npm run reminders:status
npm run monitoring:status
npm run iam:verify
npm run cloud-services:verify
.\start-motorlog.ps1 --verify
```

## 10. Daily commands (after setup)

```powershell
.\start-motorlog.ps1                   # start and show deployed links
.\start-motorlog.ps1 --open            # start and open CloudFront
.\start-motorlog.ps1 --status          # read-only status
.\start-motorlog.ps1 --verify          # run verification
.\stop-motorlog.ps1                    # stop manager-owned services only
.\stop-motorlog.ps1 --status           # view shutdown/ownership status
```

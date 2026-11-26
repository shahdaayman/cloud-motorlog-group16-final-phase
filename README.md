# Motorlog — Setup, Run and Test

**Group 16 · Cloud Computing & Cloud Security · BUE · 2026–2027**

Motorlog is a vehicle maintenance web application using HTML, CSS, JavaScript, Node.js/Express and AWS-compatible services simulated locally with **Floci**. Follow the commands **in order** in **Windows PowerShell**, from the folder containing `package.json`.

## 1. Requirements (install once)

Install **Node.js 22+**, **Docker Desktop**, **AWS CLI v2**, **Git for Windows**, and **PowerShell**. Start Docker Desktop before continuing.

Check each installation:

```powershell

node --version

npm --version

git --version

docker --version

aws --version

docker info

```

## 2. Get the project and install Node modules

```powershell

git clone https://github.com/shahdaayman/cloud-motorlog-group16-final-phase.git

cd cloud-motorlog-group16-final-phase

npm ci

npm ci --prefix smtp-bridge

```

## 3. Create the local configuration

```powershell

Copy-Item .env.example .env
```

Check the template settings. Floci uses `http://localhost:4566`, region `us-east-1`, and **dummy local AWS credentials** (`test` / `test`). Preserve the other variables provided in the template.

Configure the AWS CLI profile for the emulator:

```powershell

aws configure set aws_access_key_id test --profile floci

aws configure set aws_secret_access_key test --profile floci

aws configure set region us-east-1 --profile floci

```

## 4. Start Floci and choose email mode

**Option A — Local SES:** OTP emails can be viewed in the local SES viewer. Gmail credentials are not required.

```powershell

docker compose -f infra/floci/docker-compose.yml up -d --wait

```

**Option B — Gmail OTP (optional):** Choose this instead of Option A if you want Motorlog to send actual OTP messages to approved Gmail inboxes.

### Step 4B.1 — Enable Google's 2-Step Verification

1. Sign in to the **Google Account that will send Motorlog emails**.
2. Open **https://myaccount.google.com/security**.
3. Under **How you sign in to Google**, open **2-Step Verification**.
4. Follow the instructions to enable 2-Step Verification. If it is already enabled, continue to the next step.

### Step 4B.2 — Generate a Gmail App Password

1. Open **https://myaccount.google.com/apppasswords** while signed in to the same account.
2. If prompted, sign in again.
3. Enter an app name such as **Motorlog SMTP**, then select **Create**.
4. Google will display a **16-character App Password**. Copy it for the next step. This is **not** your normal Gmail login password.
5. Keep this password private. Do not send it to teammates, paste it into reports or screenshots, or commit it to GitHub.

If **App Passwords** is unavailable, Google may restrict it for certain work/school accounts, Advanced Protection accounts, or accounts with 2-Step Verification configured only with security keys. See [Google's App Password help](https://support.google.com/accounts/answer/185833) for details. In that case, use local SES mode or a suitable account that supports App Passwords.

### Step 4B.3 — Add the credentials to Motorlog

From the project root in PowerShell, run:

```powershell
if (-not (Test-Path smtp.env)) { Copy-Item smtp.env.example smtp.env }
notepad smtp.env
```

Only run `Copy-Item` if you have not already created `smtp.env`, so you don't replace a working configuration. In `smtp.env`, fill in these entries and **keep any other template settings unchanged**:

```dotenv
SMTP_EMAIL=your-sending-address@gmail.com
SMTP_APP_PASSWORD=your-16-character-google-app-password
SMTP_ALLOWED_RECIPIENTS=your-test-recipient@gmail.com
SMTP_ALLOW_ANY_RECIPIENT=false
```

- `SMTP_EMAIL`: the Gmail account used to send OTP emails.
- `SMTP_APP_PASSWORD`: the App Password generated in Step 4B.2, **not** your regular Google password. Paste the generated password as a single value, without display spaces.
- `SMTP_ALLOWED_RECIPIENTS`: the email addresses authorized to receive test messages (follow the format in `smtp.env.example` if adding multiple addresses).
- `SMTP_ALLOW_ANY_RECIPIENT=false`: keeps delivery restricted to your approved recipients.

Save and close Notepad. `smtp.env` is private and should remain ignored by Git. Never share its contents.

### Step 4B.4 — Start Floci with Gmail delivery

```powershell
docker compose --env-file smtp.env -f infra/floci/docker-compose.yml -f infra/floci/docker-compose.gmail.yml up -d --build --wait
```

Then continue with **Step 5** (database and authentication initialization) if this is a new Floci environment. Once the application is configured, run:

```powershell
.\start-motorlog.ps1 --email-mode gmail
```

### Step 4B.5 — Test real email delivery

After the application is running, open the deployed Motorlog frontend, register with an allowed test recipient, and confirm that the OTP arrives in its inbox. Also check the Spam folder. Alternatively, for a non-OTP SMTP test to an authorized recipient, use:

```powershell
.\start-motorlog.ps1 --email-mode gmail --test-email your-test-recipient@gmail.com
```

The bridge uses the internal Docker hostname `motorlog-smtp-bridge` on port `1025`, then Gmail's SMTP submission with TLS. If delivery fails, inspect bridge status/logs without printing `smtp.env` or OTP values.

## 5. Initialize the database and authentication

Run these **once on a new, empty Floci environment**:

```powershell

npm run db:prepare

npm run auth:setup

node scripts/update-otp-email.js

```

Verify DynamoDB tables:

```powershell

aws --profile floci --endpoint-url http://localhost:4566 dynamodb list-tables

```

Expected application tables: `CMLUsers`, `CMLVehicles`, `CMLMaintenance`, `CMLFuel`, `CMLExpenses`, `CMLReminders`, `CMLAudit`, `CMLAuthRateLimits`.

Verify the Cognito user pool:

```powershell

aws --profile floci --endpoint-url http://localhost:4566 cognito-idp list-user-pools --max-results 60

```

## 6. Deploy the full cloud architecture

Deploy the project resources in dependency order.

### 6A. IAM, Lambda and API Gateway

```powershell

powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-iam-security.ps1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-lambdas.ps1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-api.ps1

```

### 6B. S3 and CloudFront frontend

```powershell

powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-s3-frontend.ps1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-cloudfront.ps1

```

### 6C. Reminders, queues and monitoring

```powershell

powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-reminder-automation.ps1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-monitoring.ps1

```

### 6D. Load balancer, ECS, scaling and additional services

**The ALB must be deployed before the scaling/security stack.** The scaling script also sets up SNS, EventBridge audit integration and Secrets Manager.

```powershell

powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-alb.ps1

npm run cloud-services:deploy

```

> Some scripts depend on locally built images, running target processes, available networking, and resources produced by earlier steps. If a deployment fails, resolve that prerequisite before moving on.

## 7. Start Motorlog with one command

Once the environment is configured:

```powershell

.\start-motorlog.ps1 --email-mode local

```

Or, if you configured `smtp.env` for Gmail:

```powershell

.\start-motorlog.ps1 --email-mode gmail

```

To open the deployed CloudFront frontend automatically:

```powershell

.\start-motorlog.ps1 --open

```

## 8. Test each cloud component

Run these commands after deploying the corresponding resources:

\| Service or component | Verification command | What to look for |

\|---|---|---|

\| Floci | `curl.exe http://localhost:4566/\_floci/health` | Healthy response |

\| DynamoDB | `aws --profile floci --endpoint-url http://localhost:4566 dynamodb list-tables` | Eight Motorlog tables |

\| Cognito | `aws --profile floci --endpoint-url http://localhost:4566 cognito-idp list-user-pools --max-results 60` | Motorlog user pool |

\| SES | Open `http://localhost:4566/\_aws/ses` | Captured email after a test sign-up/login |

\| Lambda | `aws --profile floci --endpoint-url http://localhost:4566 lambda list-functions` | Deployed application functions |

\| API Gateway | `aws --profile floci --endpoint-url http://localhost:4566 apigateway get-rest-apis` | Motorlog REST API; manager checks its health route |

\| S3 | `npm run s3:verify` | Frontend bucket/assets verified |

\| CloudFront | `npm run cloudfront:verify` | Deployed distribution serves Motorlog |

\| ALB | `npm run alb:verify` | Targets and ALB checks pass |

\| ECS | `aws --profile floci --endpoint-url http://localhost:4566 ecs list-clusters` | Motorlog cluster; manager checks running vs desired tasks |

\| Application Auto Scaling | `aws --profile floci --endpoint-url http://localhost:4566 application-autoscaling describe-scalable-targets --service-namespace ecs` | Configured ECS scalable target |

\| EventBridge Scheduler / SQS | `npm run reminders:status` | Reminder scheduler/queue configuration |

\| CloudWatch | `npm run monitoring:status` | Logs, metrics and alarms checks |

\| IAM | `npm run iam:verify` | Role/policy checks (emulator enforcement may be limited) |

\| EventBridge, SNS, Secrets Manager | `npm run cloud-services:verify` | Additional cloud resource and event-flow checks |

For extra visibility, use these read-only CLI checks:

```powershell

aws --profile floci --endpoint-url http://localhost:4566 sqs list-queues

aws --profile floci --endpoint-url http://localhost:4566 events list-event-buses

aws --profile floci --endpoint-url http://localhost:4566 sns list-topics

aws --profile floci --endpoint-url http://localhost:4566 secretsmanager list-secrets

aws --profile floci --endpoint-url http://localhost:4566 cloudfront list-distributions

```

## 9. Run all tests and verify the complete project

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

## 10. Test the application in your browser

1\. Open the **CloudFront frontend URL printed by** `.\start-motorlog.ps1`.

2\. Register a new test account, confirm it with the emailed code (SES viewer in local mode; Gmail inbox in Gmail mode), then log in using the sign-in OTP.

3\. Add a vehicle and test VIN decoding (requires internet), maintenance, fuel, expenses, reminders and analytics.

4\. Refresh and check whether the signed-in session persists as expected.

5\. With a separate test account, confirm it cannot see another user's data; a regular user should receive `403` from protected Admin APIs.

6\. Test the Admin Console with a confirmed test account assigned the `Admin` role through your local Cognito setup.

## 11. Daily commands (after setup)

```powershell

.\start-motorlog.ps1                 # start required services and show deployed URLs

.\start-motorlog.ps1 --open          # start and open deployed CloudFront frontend

.\start-motorlog.ps1 --status        # show statuses without changes

.\start-motorlog.ps1 --verify        # run project verification

.\stop-motorlog.ps1                  # stop only manager-owned services

.\stop-motorlog.ps1 --status         # read-only shutdown/ownership status

```

**Note:** If a service was already running before the manager started, the stop command deliberately treats it as shared and may leave it running. It never deletes DynamoDB records, users, Docker volumes or cloud resources.

## 12. Quick fixes

\| Problem | What to do |

\|---|---|

\| Docker unavailable | Start Docker Desktop; rerun `docker info` |

\| Node/AWS not detected when using `bash` in PowerShell | Use `.\start-motorlog.ps1`, not WSL's `bash` |

\| Gmail mode says `smtp.env` missing | Copy `smtp.env.example` to ignored `smtp.env`, configure your own credentials, and rerun Gmail mode |

\| OTP isn't received | Check SES viewer, bridge health, the approved recipients and SMTP networking |

\| CloudFront URL missing | Deploy S3 and CloudFront (Step 6B), then rerun manager |

\| API Gateway unavailable | Check Lambda and API deployment (Step 6A) |

\| ECS not running | Check ALB and scaling deployment (Step 6D), task counts and container health |

\| Test script fails on fresh clone | Confirm the corresponding service was actually deployed; see Steps 6–9 |

For troubleshooting commands and architectural details, see `docs/`, the deployment scripts and `infra/architecture.md`.

**---**
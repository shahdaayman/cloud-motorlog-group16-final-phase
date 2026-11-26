# Motorlog deployment and first-time provisioning

This file was originally a pre-deployment plan. Motorlog now has working, idempotent
deployment scripts for the local Floci environment. The daily manager reuses those
resources; it does not redeploy healthy infrastructure.

## Daily startup

From PowerShell:

```powershell
.\start-motorlog.ps1
.\start-motorlog.ps1 --status
.\stop-motorlog.ps1
```

From Git Bash:

```bash
bash start-motorlog.sh
bash start-motorlog.sh --status
bash stop-motorlog.sh
```

The manager discovers the current CloudFront distribution, API Gateway ID, and deployed
stage. CloudFront is the primary application URL; `http://localhost:3000` is an optional
secondary development server.

## First-time setup

Only use setup on a new or incomplete Floci volume:

```powershell
.\start-motorlog.ps1 --setup
```

The setup option calls the repository's existing scripts in dependency order to create or
reuse DynamoDB, Cognito, IAM, Lambda, API Gateway, reminder automation, monitoring, S3,
CloudFront, ALB, ECS, scaling, SNS, EventBridge, and Secrets Manager resources. The scripts
are additive/idempotent and do not reset tables, Cognito users, or Docker volumes.

Normal startup reports missing infrastructure with the exact `--setup` instruction rather
than provisioning silently.

## Email mode

Local SES capture requires no Gmail credential:

```powershell
.\start-motorlog.ps1 --email-mode local
```

For Gmail delivery, copy `smtp.env.example` to ignored `smtp.env`, configure a Gmail App
Password and authorized recipients, then run:

```powershell
.\start-motorlog.ps1 --email-mode gmail
```

Routine startup checks configuration, the bridge container, Docker DNS alias, and TCP port
1025 but does not send mail. An operator can explicitly send one non-OTP delivery test to
an authorized address:

```powershell
.\start-motorlog.ps1 --email-mode gmail --test-email you@example.com
```

Never commit `smtp.env`, paste credentials into evidence, or include OTPs in logs.

## Verification

```powershell
.\start-motorlog.ps1 --verify
```

The verification path runs application tests, SMTP bridge tests, local API smoke checks,
S3 verification, CloudFront verification, and the existing 14-check cloud-services
verification. Cloud verification requires the corresponding resources to exist.

The most recent validation on 24 November 2026 passed 121/121 application tests, 2/2 SMTP
bridge tests, dynamic S3/CloudFront verification, and 14/14 cloud-service checks.

## Scope and limitations

Floci is a local emulator. It does not demonstrate real AWS global edge distribution,
production IAM enforcement, production TLS, or million-user capacity. ECS control-plane
state is not sufficient evidence of execution; the manager requires running tasks and
separate HTTP health checks before reporting the deployed environment ready.

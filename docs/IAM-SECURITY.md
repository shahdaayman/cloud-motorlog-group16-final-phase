# Motorlog IAM security

## Audit result

The original deployment used `motorlog-lambda-execution` for both `cml-vehicles` and `cml-fuel`. Its wildcard Cognito policy and access to every Motorlog table, SQS and SES created unnecessary privilege sharing. `cml-reminders` already used a dedicated role. The Scheduler target uses `motorlog-scheduler-reminders` and is intentionally separate from Lambda runtime access.

`npm run iam:deploy` creates or updates three Lambda service roles and assigns them to their matching functions. Policies are scoped by service, table/index ARN, queue ARN and CloudWatch namespace. CloudWatch Logs access is limited to Motorlog Lambda log groups. The Scheduler role and schedule state are never changed by this script.

Run:

```powershell
npm run iam:audit
npm run iam:deploy
npm run iam:verify
```

## Floci enforcement boundary

Floci IAM enforcement is a container-level setting and is commonly disabled by default. These scripts do not enable or restart it. When enforcement is disabled, attached policy documents accurately describe the intended least-privilege model, but successful or denied API calls do not prove authorization enforcement. Enable enforcement only after explicit approval, then rerun the application smoke suite and positive/negative policy tests.

The expected negative boundaries are: fuel cannot send SES mail or administer Cognito users; reminders cannot administer Cognito users; vehicles cannot send reminder email. The expected positive paths are the normal CRUD operations, reminder queue publishing/consumption, SES reminder sending, logging and metrics.

Do not place access keys, tokens, passwords, OTPs or SMTP secrets in policies, commands, evidence, logs or screenshots.

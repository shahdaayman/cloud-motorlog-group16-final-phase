# Automatic reminder deployment on Floci

Motorlog uses `cml-reminders` for three event types: API Gateway HTTP requests, EventBridge Scheduler checks, and SQS notification delivery. The daily schedule is created disabled until a controlled email test is approved.

## Resources

- Schedule group: `motorlog`
- Schedule: `motorlog-daily-reminder-check`
- Expression: `cron(0 9 * * ? *)`
- Time zone: `Africa/Cairo`
- Target: `cml-reminders`
- Scheduler role: `motorlog-scheduler-reminders` (invoke permission only for `cml-reminders`)
- Lambda role: `motorlog-reminders-runtime` (logs, required DynamoDB tables, notification queues, and SES send only)
- Queue: `cml-reminder-notifications`
- Dead-letter queue: `cml-reminder-notifications-dlq`
- SQS mapping: batch size 1 with `ReportBatchItemFailures`

## Windows CMD commands

```cmd
npm run lambda:deploy
npm run reminders:deploy
npm run reminders:status
npm run reminders:test
npm run reminders:test-email -- --reminder-id REMINDER_ID --approved-email APPROVED_EMAIL --approve-send
npm run reminders:enable
npm run reminders:disable
```

`reminders:test` is safe: it creates a one-time Scheduler dry run and sends a nonexistent reminder through SQS. It does not send email or alter application records.

`reminders:test-email` is intentionally guarded and sends one real email. It requires the exact reminder ID, its owner's explicitly approved email, and `--approve-send`. It aborts unless the account is active, the reminder is open and date-overdue, the production schedule is disabled, the queue is empty, and the reminder has not been notified during the current Cairo notification day. Sanitized evidence is written to `dist/targeted-reminder-email-evidence.json`.

Enable the daily schedule only after creating a disposable account and overdue reminder for an approved test email, invoking one controlled non-dry run, and verifying SQS, Lambda, SES, and the Gmail delivery bridge exactly once.

## Logs

```cmd
aws --profile floci --endpoint-url http://localhost:4566 logs filter-log-events --log-group-name /aws/lambda/cml-reminders --limit 100
```

## Recovery and rollback

Disable scheduling without removing data or queue processing:

```cmd
npm run reminders:disable
```

Disable the SQS trigger temporarily only during a supervised recovery:

```cmd
aws --profile floci --endpoint-url http://localhost:4566 lambda update-event-source-mapping --uuid UUID_FROM_REMINDERS_STATUS --no-enabled
```

Re-running `npm run reminders:deploy` safely reconciles the role, schedule, redrive policy, and mapping. Never delete Floci volumes or purge the notification queue as part of recovery.

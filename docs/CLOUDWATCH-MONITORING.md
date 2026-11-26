# Motorlog CloudWatch monitoring

Motorlog emits structured JSON request logs containing only service, HTTP method, path, status and duration. Reminder failure logs contain an event type, message ID and error class; email addresses, message bodies, tokens and secrets are excluded.

Application metrics use `Motorlog/Application`:

- `API5xxErrors`: aggregate HTTP 5xx responses, dimensioned by environment.
- `ReminderChecks` and `ReminderCheckFailures`: scheduled check outcomes.
- `RemindersQueued`: SQS messages successfully queued.
- `NotificationsProcessed`: SES accepted the request and the reminder marker was persisted. This does not claim Gmail delivery.
- `NotificationFailures`: SQS worker notification failures.

Dimensions are bounded to environment, service and operation. User IDs, reminder IDs and email addresses are never dimensions.

Deploy and inspect:

```powershell
npm run monitoring:deploy
npm run monitoring:status
npm run monitoring:test
```

Alarms:

- `motorlog-api-errors`: any application 5xx in one minute.
- `motorlog-reminder-failures`: notification failures in two consecutive five-minute periods.
- `motorlog-notification-dlq`: one or more visible messages in `cml-reminder-notifications-dlq`.

The test publishes only `Motorlog/Test/MonitoringHeartbeat`; it never fabricates production failures, changes the production schedule, or sends email. If Floci does not publish the standard `AWS/SQS` queue metric, the DLQ alarm remains configured but cannot transition until that emulator capability is available; verify this with `monitoring:status`.

Useful diagnostics:

```powershell
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 logs filter-log-events --log-group-name /aws/lambda/cml-reminders --limit 50
aws --profile floci --region us-east-1 --endpoint-url http://localhost:4566 cloudwatch describe-alarms
```

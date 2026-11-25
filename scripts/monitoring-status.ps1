. (Join-Path $PSScriptRoot 'cloud-common.ps1')
Invoke-Aws logs describe-log-groups --log-group-name-prefix /aws/lambda/cml-
Invoke-Aws cloudwatch describe-alarms --alarm-names motorlog-api-errors motorlog-reminder-failures motorlog-notification-dlq
Invoke-Aws cloudwatch list-metrics --namespace Motorlog/Application

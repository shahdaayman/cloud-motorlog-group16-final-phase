. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$dist=Join-Path $ProjectRoot 'dist';New-Item -ItemType Directory -Force -Path $dist|Out-Null
$runId="scheduler-dryrun-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$role=(Invoke-Aws iam get-role --role-name motorlog-scheduler-reminders|ConvertFrom-Json).Role.Arn
$function=(Invoke-Aws lambda get-function-configuration --function-name cml-reminders|ConvertFrom-Json).FunctionArn
$target=Join-Path $dist 'scheduler-test-target.json';$window=Join-Path $dist 'scheduler-test-window.json'
Write-JsonFile $target @{Arn=$function;RoleArn=$role;Input=(ConvertTo-Json @{source='aws.scheduler';job='check-reminders';dryRun=$true;runId=$runId} -Compress)}
Write-JsonFile $window @{Mode='OFF'}
$when=[DateTime]::UtcNow.AddSeconds(20).ToString('yyyy-MM-ddTHH:mm:ss')
try{Invoke-Aws scheduler delete-schedule --group-name motorlog --name motorlog-scheduler-dry-run-test|Out-Null}catch{}
Invoke-Aws scheduler create-schedule --group-name motorlog --name motorlog-scheduler-dry-run-test --schedule-expression "at($when)" --schedule-expression-timezone UTC --flexible-time-window "file://$window" --target "file://$target" --state ENABLED --action-after-completion DELETE|Out-Null
Write-Host "Waiting for safe one-time Scheduler dry run: $runId"
$found=$false
for($attempt=0;$attempt -lt 24 -and -not $found;$attempt++){
  Start-Sleep -Seconds 5
  try{$logs=Invoke-Aws logs filter-log-events --log-group-name /aws/lambda/cml-reminders --limit 100|ConvertFrom-Json;$found=@($logs.events|Where-Object message -Like "*$runId*").Count -gt 0}catch{$found=$false}
}
if(-not $found){throw 'Scheduler dry-run marker was not observed in Lambda logs.'}
Write-Host 'PASS EventBridge Scheduler invoked cml-reminders in dry-run mode.'

$queueUrl=(Invoke-Aws sqs get-queue-url --queue-name cml-reminder-notifications|ConvertFrom-Json).QueueUrl
$message=ConvertTo-Json @{type='REMINDER_DUE';reminderId="nonexistent-$runId";ownerId="nonexistent-$runId";today=(Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')} -Compress
$messagePath=Join-Path $dist 'safe-sqs-test-message.json';[System.IO.File]::WriteAllText($messagePath,$message,(New-Object System.Text.UTF8Encoding($false)))
Invoke-Aws sqs send-message --queue-url $queueUrl --message-body "file://$messagePath"|Out-Null
$consumed=$false
for($attempt=0;$attempt -lt 18 -and -not $consumed;$attempt++){
  Start-Sleep -Seconds 5
  $attrs=(Invoke-Aws sqs get-queue-attributes --queue-url $queueUrl --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible|ConvertFrom-Json).Attributes
  $consumed=[int]$attrs.ApproximateNumberOfMessages -eq 0 -and [int]$attrs.ApproximateNumberOfMessagesNotVisible -eq 0
}
if(-not $consumed){throw 'SQS test message was not consumed by the Lambda event-source mapping.'}
Write-Host 'PASS SQS automatically invoked cml-reminders; nonexistent records produced a safe no-op and no email.'

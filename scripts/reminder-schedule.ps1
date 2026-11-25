param([ValidateSet('status','enable','disable')][string]$Action='status')
. (Join-Path $PSScriptRoot 'cloud-common.ps1')
if($Action -eq 'status'){Invoke-Aws scheduler get-schedule --group-name motorlog --name motorlog-daily-reminder-check;Invoke-Aws lambda list-event-source-mappings --function-name cml-reminders;exit}
$schedule=Invoke-Aws scheduler get-schedule --group-name motorlog --name motorlog-daily-reminder-check|ConvertFrom-Json
$target=Join-Path $ProjectRoot 'dist\scheduler-current-target.json';$window=Join-Path $ProjectRoot 'dist\scheduler-current-window.json'
Write-JsonFile $target $schedule.Target;Write-JsonFile $window $schedule.FlexibleTimeWindow
$state=if($Action -eq 'enable'){'ENABLED'}else{'DISABLED'}
Invoke-Aws scheduler update-schedule --group-name motorlog --name motorlog-daily-reminder-check --schedule-expression $schedule.ScheduleExpression --schedule-expression-timezone $schedule.ScheduleExpressionTimezone --flexible-time-window "file://$window" --target "file://$target" --state $state|Out-Null
Write-Host "motorlog-daily-reminder-check is $state"

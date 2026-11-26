. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$before=(Invoke-Aws scheduler get-schedule --group-name motorlog --name motorlog-daily-reminder-check|ConvertFrom-Json).State
$metricPath=Join-Path $ProjectRoot 'dist\monitoring-test-metric.json'
Write-JsonFile $metricPath @{Namespace='Motorlog/Test';MetricData=@(@{MetricName='MonitoringHeartbeat';Value=1;Unit='Count'})}
Invoke-Aws cloudwatch put-metric-data --cli-input-json "file://$metricPath"|Out-Null
$metrics=Invoke-Aws cloudwatch list-metrics --namespace Motorlog/Test|ConvertFrom-Json
if(-not ($metrics.Metrics|Where-Object MetricName -eq MonitoringHeartbeat)){throw 'Test metric was not queryable'}
$after=(Invoke-Aws scheduler get-schedule --group-name motorlog --name motorlog-daily-reminder-check|ConvertFrom-Json).State
if($before -ne $after){throw 'Schedule state changed unexpectedly'}
Write-Host "PASS controlled test metric published and queried; schedule remained $after; no email was sent."

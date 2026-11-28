. (Join-Path $PSScriptRoot 'cloud-common.ps1')
function Write-Status([string]$Status,[string]$Message){Write-Host (("[$Status]").PadRight(10)+$Message)}
function Get-DimensionSignature($Dimensions){(@($Dimensions|ForEach-Object{"$($_.Name)=$($_.Value)"}|Sort-Object)-join '|')}
function Test-AlarmMatches($Actual,$Expected){
  if(-not $Actual){return $false}
  foreach($property in 'Namespace','MetricName','Statistic','ComparisonOperator','TreatMissingData'){
    if([string]$Actual.$property -cne [string]$Expected[$property]){return $false}
  }
  foreach($property in 'Period','EvaluationPeriods','Threshold'){
    if([decimal]$Actual.$property -ne [decimal]$Expected[$property]){return $false}
  }
  if($Expected.ContainsKey('DatapointsToAlarm') -and [int]$Actual.DatapointsToAlarm -ne [int]$Expected.DatapointsToAlarm){return $false}
  if(-not $Expected.ContainsKey('DatapointsToAlarm') -and $null -ne $Actual.DatapointsToAlarm -and [int]$Actual.DatapointsToAlarm -ne [int]$Expected.EvaluationPeriods){return $false}
  (Get-DimensionSignature $Actual.Dimensions) -eq (Get-DimensionSignature $Expected.Dimensions)
}
function Ensure-Alarm([hashtable]$Expected,[string[]]$Arguments){
  $name=$Expected.AlarmName
  $check=Invoke-AwsExistenceCheck -Arguments @('cloudwatch','describe-alarms','--alarm-names',$name) -NotFoundErrorCodes @('ResourceNotFoundException')
  $alarm=@(($check.Output|ConvertFrom-Json).MetricAlarms|Where-Object AlarmName -eq $name|Select-Object -First 1)
  if($alarm.Count -and (Test-AlarmMatches $alarm[0] $Expected)){Write-Status EXISTS "CloudWatch alarm $name"}
  else{Write-Status $(if($alarm.Count){'UPDATE'}else{'CREATE'}) "CloudWatch alarm $name";Invoke-Aws @Arguments|Out-Null}
  $verified=Invoke-Aws cloudwatch describe-alarms --alarm-names $name|ConvertFrom-Json;$match=@($verified.MetricAlarms|Where-Object AlarmName -eq $name|Select-Object -First 1)
  if(-not $match.Count -or -not (Test-AlarmMatches $match[0] $Expected)){throw "CloudWatch alarm $name verification failed."}
}

Write-Host "`n===============================================`n       MOTORLOG CLOUD MONITORING`n===============================================`n"
Write-Status INFO 'Checking CloudWatch log groups...'
$logGroups=@('/aws/lambda/cml-vehicles','/aws/lambda/cml-fuel','/aws/lambda/cml-reminders')
foreach($name in $logGroups){
  $check=Invoke-AwsExistenceCheck -Arguments @('logs','describe-log-groups','--log-group-name-prefix',$name) -NotFoundErrorCodes @('ResourceNotFoundException')
  $found=@(($check.Output|ConvertFrom-Json).logGroups|Where-Object logGroupName -eq $name|Select-Object -First 1)
  if($found.Count){Write-Status EXISTS $name}else{Write-Status CREATE $name;Invoke-Aws logs create-log-group --log-group-name $name|Out-Null}
  $verified=Invoke-Aws logs describe-log-groups --log-group-name-prefix $name|ConvertFrom-Json
  if(-not @($verified.logGroups|Where-Object logGroupName -eq $name).Count){throw "CloudWatch log group $name verification failed."}
}
Write-Status OK 'Log groups verified; existing retention settings preserved'

Write-Host '';Write-Status INFO 'Checking CloudWatch alarms...'
$alarms=@(
  @{Expected=@{AlarmName='motorlog-api-errors';Namespace='Motorlog/Application';MetricName='API5xxErrors';Dimensions=@(@{Name='Environment';Value='floci'});Statistic='Sum';Period=60;EvaluationPeriods=1;Threshold=1;ComparisonOperator='GreaterThanOrEqualToThreshold';TreatMissingData='notBreaching'};Arguments=@('cloudwatch','put-metric-alarm','--alarm-name','motorlog-api-errors','--namespace','Motorlog/Application','--metric-name','API5xxErrors','--dimensions','Name=Environment,Value=floci','--statistic','Sum','--period','60','--evaluation-periods','1','--threshold','1','--comparison-operator','GreaterThanOrEqualToThreshold','--treat-missing-data','notBreaching')},
  @{Expected=@{AlarmName='motorlog-reminder-failures';Namespace='Motorlog/Application';MetricName='NotificationFailures';Dimensions=@(@{Name='Environment';Value='floci'},@{Name='Service';Value='reminders'},@{Name='Operation';Value='notification'});Statistic='Sum';Period=300;EvaluationPeriods=2;DatapointsToAlarm=2;Threshold=1;ComparisonOperator='GreaterThanOrEqualToThreshold';TreatMissingData='notBreaching'};Arguments=@('cloudwatch','put-metric-alarm','--alarm-name','motorlog-reminder-failures','--namespace','Motorlog/Application','--metric-name','NotificationFailures','--dimensions','Name=Environment,Value=floci','Name=Service,Value=reminders','Name=Operation,Value=notification','--statistic','Sum','--period','300','--evaluation-periods','2','--datapoints-to-alarm','2','--threshold','1','--comparison-operator','GreaterThanOrEqualToThreshold','--treat-missing-data','notBreaching')},
  @{Expected=@{AlarmName='motorlog-notification-dlq';Namespace='AWS/SQS';MetricName='ApproximateNumberOfMessagesVisible';Dimensions=@(@{Name='QueueName';Value='cml-reminder-notifications-dlq'});Statistic='Maximum';Period=60;EvaluationPeriods=1;Threshold=1;ComparisonOperator='GreaterThanOrEqualToThreshold';TreatMissingData='notBreaching'};Arguments=@('cloudwatch','put-metric-alarm','--alarm-name','motorlog-notification-dlq','--namespace','AWS/SQS','--metric-name','ApproximateNumberOfMessagesVisible','--dimensions','Name=QueueName,Value=cml-reminder-notifications-dlq','--statistic','Maximum','--period','60','--evaluation-periods','1','--threshold','1','--comparison-operator','GreaterThanOrEqualToThreshold','--treat-missing-data','notBreaching')}
)
foreach($alarm in $alarms){Ensure-Alarm $alarm.Expected $alarm.Arguments}
Write-Status OK 'CloudWatch alarms verified'
Write-Host 'No schedule, queue, email, Cognito, or retention settings were changed.'
Write-Host "`n-----------------------------------------------`nMonitoring deployment: SUCCESS`n-----------------------------------------------"

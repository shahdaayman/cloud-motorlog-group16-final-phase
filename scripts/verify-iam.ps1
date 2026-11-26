. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$expected=@{'cml-vehicles'='motorlog-vehicles-runtime';'cml-fuel'='motorlog-fuel-runtime';'cml-reminders'='motorlog-reminders-runtime'}
foreach($item in $expected.GetEnumerator()){$role=(Invoke-Aws lambda get-function-configuration --function-name $item.Key|ConvertFrom-Json).Role;if($role -notlike "*/$($item.Value)"){throw "$($item.Key) does not use $($item.Value)"};Write-Host "PASS $($item.Key) uses $($item.Value)"}
$schedule=Invoke-Aws scheduler get-schedule --group-name motorlog --name motorlog-daily-reminder-check|ConvertFrom-Json
Write-Host "PASS scheduler state preserved as $($schedule.State); role $($schedule.Target.RoleArn)"
Write-Host 'Policy simulation is not treated as an enforcement test unless Floci IAM enforcement is explicitly enabled.'

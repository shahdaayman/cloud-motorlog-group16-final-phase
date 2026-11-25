. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$functions=Invoke-Aws lambda list-functions|ConvertFrom-Json
$functions.Functions|Where-Object FunctionName -like 'cml-*'|Select-Object FunctionName,Role|Format-Table
foreach($name in 'motorlog-vehicles-runtime','motorlog-fuel-runtime','motorlog-reminders-runtime','motorlog-scheduler-reminders'){
  try{$role=Invoke-Aws iam get-role --role-name $name|ConvertFrom-Json;Write-Host "ROLE $name";Write-Host (($role.Role.AssumeRolePolicyDocument|ConvertTo-Json -Depth 10));Invoke-Aws iam list-role-policies --role-name $name}catch{Write-Warning "Missing role: $name"}
}
Write-Host 'IAM enforcement is controlled by the Floci container configuration; this audit does not enable it.'

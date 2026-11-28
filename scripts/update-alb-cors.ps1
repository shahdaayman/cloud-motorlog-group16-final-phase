. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$infoPath=Join-Path $ProjectRoot 'dist\alb-deployment.json';if(-not(Test-Path -LiteralPath $infoPath)){throw 'ALB deployment metadata was not found.'}
$origin=(Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json).url.TrimEnd('/');if(-not $origin){throw 'ALB deployment metadata has no URL.'}
foreach($name in 'cml-vehicles','cml-fuel','cml-reminders'){
  $config=Invoke-Aws lambda get-function-configuration --function-name $name|ConvertFrom-Json;$variables=@{};$config.Environment.Variables.psobject.Properties|ForEach-Object{$variables[$_.Name]=$_.Value}
  $origins=@($variables.CORS_ORIGINS.Split(',')|ForEach-Object{$_.Trim()}|Where-Object{$_})
  if($origins -contains $origin){Write-Host "[EXISTS] Exact ALB CORS origin on $name";continue}
  $variables.CORS_ORIGINS=(@($origins)+$origin)-join ',';$path=Join-Path $ProjectRoot "dist\$name-alb-cors.json";Write-JsonFile $path @{Variables=$variables}
  Write-Host "[UPDATE] Exact ALB CORS origin on $name";Invoke-Aws lambda update-function-configuration --function-name $name --environment "file://$path"|Out-Null
  $verified=Wait-MotorlogLambdaActive -FunctionName $name;if(@($verified.Environment.Variables.CORS_ORIGINS.Split(',')|ForEach-Object{$_.Trim()}) -notcontains $origin){throw "ALB CORS origin verification failed for $name."}
}

. (Join-Path $PSScriptRoot 'alb-processes.ps1')
function Pass([string]$Message){Write-Host "[PASS] $Message"}
Write-Host "`n===============================================`n          MOTORLOG ALB VERIFICATION`n===============================================`n"
$infoPath=Join-Path $ProjectRoot 'dist\alb-deployment.json'
if(-not(Test-Path -LiteralPath $infoPath)){throw 'Run npm run alb:deploy first.'}
$info=Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json
function Get-Health{@((Invoke-Aws elbv2 describe-target-health --target-group-arn $info.targetGroupArn|ConvertFrom-Json).TargetHealthDescriptions)}
function Wait-Health([int]$port,[string]$state,[int]$seconds=45){for($i=0;$i -lt $seconds;$i++){if(@(Get-Health|Where-Object{$_.Target.Port -eq $port -and $_.TargetHealth.State -eq $state}).Count){return};Start-Sleep -Seconds 1};throw "Target port $port did not reach $state"}
$lb=(Invoke-Aws elbv2 describe-load-balancers --load-balancer-arns $info.loadBalancerArn|ConvertFrom-Json).LoadBalancers[0]
if($lb.State.Code -ne 'active'){throw "ALB is $($lb.State.Code)"}
Pass 'ALB active'
foreach($port in 3101,3102,3103){Wait-Health $port healthy}
Pass 'Three backend targets healthy'
$assets=@(@('/','text/html'),@('/css/styles.css','text/css'),@('/css/confirm-dialog.css','text/css'),@('/css/auth.css','text/css'),@('/css/auth-remember.css','text/css'),@('/css/account-delete.css','text/css'),@('/js/config.js','javascript'),@('/js/hash-router.js?v=20261118-nav2','javascript'),@('/js/app.js?v=20261118-nav2','javascript'),@('/admin/','text/html'),@('/css/admin.css','text/css'),@('/css/admin-fixes.css','text/css'),@('/js/admin.js?v=20261118-nav2','javascript'))
foreach($asset in $assets){$albResponse=Invoke-WebRequest -UseBasicParsing -Uri "$($info.url)$($asset[0])" -TimeoutSec 5;$type=$albResponse.Headers['Content-Type'];$typeOk=if($asset[1] -eq 'javascript'){$type -match '^(application|text)/javascript'}else{$type -like "$($asset[1])*"};if($albResponse.StatusCode -ne 200 -or -not $typeOk){throw "Asset failed: $($asset[0]) $($albResponse.StatusCode) $type"};$content=@(3101,3102,3103|ForEach-Object{(Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$_$($asset[0])" -TimeoutSec 5).Content});if(@($content|Select-Object -Unique).Count -ne 1){throw "Targets serve different content for $($asset[0])"}}
$root=Invoke-WebRequest -UseBasicParsing -Uri "$($info.url)/" -TimeoutSec 5;if($root.Headers['Content-Security-Policy'] -match 'upgrade-insecure-requests'){throw 'CSP still upgrades HTTP ALB assets to unsupported HTTPS'}
Pass 'complete frontend asset manifest, MIME types, target equality, and HTTP CSP'
$backendPreflight=Invoke-WebRequest -UseBasicParsing -Method OPTIONS -Uri "$($info.url)/api/vehicles" -Headers @{Origin=$info.url;'Access-Control-Request-Method'='GET';'Access-Control-Request-Headers'='authorization,content-type,idempotency-key'} -TimeoutSec 5
if($backendPreflight.StatusCode -notin 200,204 -or $backendPreflight.Headers['Access-Control-Allow-Origin'] -ne $info.url -or $backendPreflight.Headers['Access-Control-Allow-Methods'] -notmatch 'GET' -or $backendPreflight.Headers['Access-Control-Allow-Headers'] -notmatch '(?i)idempotency-key'){throw 'Backend CORS preflight failed.'}
Pass 'Backend CORS preflight'
$apiBase=(Get-MotorlogApiDeployment).url;$config=(Invoke-WebRequest -UseBasicParsing -Uri "$($info.url)/js/config.js").Content;if($config -notmatch [regex]::Escape($apiBase)){throw 'ALB frontend is not configured to use API Gateway'}
foreach($path in '/api/vehicles','/api/admin/overview','/api/vehicles/probe/fuel','/api/reminders'){$preflight=Invoke-WebRequest -UseBasicParsing -Method OPTIONS -Uri "$apiBase$path" -Headers @{Origin=$info.url;'Access-Control-Request-Method'='GET';'Access-Control-Request-Headers'='authorization,content-type,idempotency-key'};if($preflight.StatusCode -notin 200,204 -or $preflight.Headers['Access-Control-Allow-Origin'] -ne $info.url -or $preflight.Headers['Access-Control-Allow-Methods'] -notmatch 'GET' -or $preflight.Headers['Access-Control-Allow-Headers'] -notmatch '(?i)idempotency-key'){throw "API Gateway CORS preflight failed for $path"}}
Pass 'API Gateway CORS preflight without authentication'
$counts=@{};for($i=0;$i -lt 30;$i++){$response=Invoke-WebRequest -UseBasicParsing -Uri "$($info.url)/api/health" -TimeoutSec 5;$id=$response.Headers['X-Motorlog-Instance'];if($id -notin 'motorlog-a','motorlog-b','motorlog-c'){throw 'ALB response did not include a safe known instance ID'};$counts[$id]=1+($counts[$id]-as [int])}
foreach($id in 'motorlog-a','motorlog-b','motorlog-c'){if(-not $counts[$id]){throw "Traffic was not observed on all targets: $($counts|ConvertTo-Json -Compress)"}}
Pass "Load balancing across three instances: $($counts|ConvertTo-Json -Compress)"
try{$null=Invoke-WebRequest -UseBasicParsing -Uri "$apiBase/api/vehicles" -Headers @{Origin=$info.url} -TimeoutSec 5;throw 'Protected API unexpectedly allowed an anonymous request'}catch{if(-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401 -or $_.Exception.Response.Headers['Access-Control-Allow-Origin'] -ne $info.url){throw}}
Pass 'Protected API returns HTTP 401 with exact-origin CORS'
$failoverPassed=$false
try{
  $targetB=Get-AlbTargetProcess 'motorlog-b' 3102
  Stop-AlbTarget 'motorlog-b' 3102
  Wait-Health 3102 unhealthy
  $survivors=@();for($i=0;$i -lt 8;$i++){$response=Invoke-WebRequest -UseBasicParsing -Uri "$($info.url)/api/health" -TimeoutSec 5;$survivors+=$response.Headers['X-Motorlog-Instance']}
  if(@($survivors|Where-Object{$_ -notin 'motorlog-a','motorlog-c'}).Count){throw "Unavailable target received failover traffic: $($survivors -join ',')"}
  if(-not @($survivors|Where-Object{$_ -eq 'motorlog-a'}).Count -or -not @($survivors|Where-Object{$_ -eq 'motorlog-c'}).Count){throw 'Both healthy survivors did not receive failover traffic'}
  $failoverPassed=$true
}finally{
  & (Join-Path $PSScriptRoot 'start-alb-targets.ps1')
  foreach($port in 3101,3102,3103){Wait-Health $port healthy}
}
if($failoverPassed){Pass 'Backend failover and recovery'}
$api="$apiBase/api/health";if((Invoke-WebRequest -UseBasicParsing -Uri $api -TimeoutSec 5).StatusCode -ne 200){throw 'Existing API Gateway health failed'}
Pass 'API Gateway health'
$cloudFront=Get-MotorlogCloudFrontDeployment;if((Invoke-WebRequest -UseBasicParsing -Uri "$($cloudFront.url.TrimEnd('/'))/" -TimeoutSec 10).StatusCode -ne 200){throw 'Current Motorlog CloudFront frontend failed'}
Pass "CloudFront frontend ($($cloudFront.id))"
Write-Host "`n-----------------------------------------------`nALB verification: SUCCESS`n-----------------------------------------------"

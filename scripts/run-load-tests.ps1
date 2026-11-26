param([ValidateSet('A','B','C')][string]$Run='A')
. (Join-Path $PSScriptRoot 'alb-processes.ps1')
. (Join-Path $PSScriptRoot 'process-execution.ps1')
$k6Command=Get-Command k6 -CommandType Application -ErrorAction SilentlyContinue
if(-not $k6Command){throw 'k6 is not installed. Install Grafana k6, then rerun.'}
$k6Path=if($k6Command.Source){$k6Command.Source}else{$k6Command.Path}
if(-not([IO.Path]::IsPathRooted($k6Path))){$k6Path=[IO.Path]::GetFullPath($k6Path)}
$infoPath=Join-Path $ProjectRoot 'dist\alb-deployment.json'
$url=if($Run -eq 'A'){'http://localhost:3101'}else{if(-not(Test-Path -LiteralPath $infoPath)){throw 'Run npm run alb:deploy first'};(Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json).url}
$env:BASE_URL=$url;New-Item -ItemType Directory -Force (Join-Path $ProjectRoot 'dist')|Out-Null
$summary="dist/k6-run-$Run.json"
Write-Host "Run $Run against $url. JSON summary: $summary"
if($Run -ne 'C'){
  & $k6Path run --summary-export $summary load-tests/motorlog.js
  exit $LASTEXITCODE
}

$info=Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json
function Get-TargetHealth {@((Invoke-Aws elbv2 describe-target-health --target-group-arn $info.targetGroupArn|ConvertFrom-Json).TargetHealthDescriptions)}
function Wait-TargetHealth([int]$Port,[string]$State,[int]$TimeoutSeconds=45){
  for($i=0;$i -lt $TimeoutSeconds;$i++){if(@(Get-TargetHealth|Where-Object{$_.Target.Port -eq $Port -and $_.TargetHealth.State -eq $State}).Count){return};Start-Sleep -Seconds 1}
  throw "Target port $Port did not reach $State"
}
function Confirm-SurvivorTraffic {
  $seen=@{}
  for($i=0;$i -lt 20;$i++){
    $response=Invoke-WebRequest -UseBasicParsing -Uri "$($info.url)/api/health" -TimeoutSec 5
    $id=$response.Headers['X-Motorlog-Instance']
    if($id -notin 'motorlog-a','motorlog-c'){throw "Failover traffic reached unexpected instance: $id"}
    $seen[$id]=$true
  }
  if(-not $seen['motorlog-a'] -or -not $seen['motorlog-c']){throw "Failover traffic did not reach both survivors: $($seen.Keys -join ', ')"}
  Write-Host 'PASS survivor traffic continued through motorlog-a and motorlog-c.'
}
function Wait-K6FailoverStage($Context,[int]$TriggerVus,[int]$TimeoutSeconds=50){
  $process=$Context.Process
  $deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while([DateTime]::UtcNow -lt $deadline){
    $process.Refresh();if($process.HasExited){$earlyExit=Complete-LoggedNativeProcess $Context 5 'k6';throw "k6 exited before reaching the sustained-load stage (exit $earlyExit)"}
    try{$status=Invoke-RestMethod -Uri 'http://127.0.0.1:6565/v1/status' -TimeoutSec 2;if([int]$status.data.attributes.vus -ge $TriggerVus){Write-Host "k6 sustained-load stage observed at $($status.data.attributes.vus) VUs";return}}catch{}
    Start-Sleep -Milliseconds 250
  }
  throw "k6 did not reach the failover trigger of $TriggerVus active VUs"
}

$k6=$null;$stopped=$false;$failure=$null;$result=0
try {
  & (Join-Path $PSScriptRoot 'start-alb-targets.ps1')
  foreach($port in 3101,3102,3103){Wait-TargetHealth $port healthy}
  Write-Host 'PASS all three ALB targets are healthy before load generation.'
  if(Get-PortListenerPid 6565){throw 'k6 REST API port 6565 is already in use; refusing to interfere with that process'}
  $env:STEADY_VUS='20';$failoverTriggerVus=6
  $stdout=Join-Path $ProjectRoot 'dist\k6-run-C.out.log';$stderr=Join-Path $ProjectRoot 'dist\k6-run-C.err.log'
  $k6=Start-LoggedNativeProcess $k6Path @('run','--address','127.0.0.1:6565','--summary-export',$summary,'load-tests/motorlog.js') $ProjectRoot $stdout $stderr
  # The first stage tops out at 5 VUs. Observing 6 through k6's API proves the
  # workload has entered its 30-second sustained-load stage without a fixed sleep.
  Wait-K6FailoverStage $k6 $failoverTriggerVus
  Stop-AlbTarget 'motorlog-b' 3102;$stopped=$true
  Write-Host 'PASS stopped verified motorlog-b on port 3102.'
  Wait-TargetHealth 3102 unhealthy
  Write-Host 'PASS motorlog-b changed to unhealthy in the ALB target group.'
  Confirm-SurvivorTraffic
  $k6ExitCode=Complete-LoggedNativeProcess $k6 90 'k6'
  if($k6ExitCode -ne 0){throw "k6 failed with exit code $k6ExitCode (workload or performance threshold failure)"}
  Write-Host 'PASS k6 exited with code 0; workload execution and performance thresholds passed.'
  if(-not(Test-Path -LiteralPath (Join-Path $ProjectRoot $summary))){throw "k6 did not write $summary"}
  Write-Host "PASS k6 summary recorded at $summary after successful execution."
  Write-Host 'PASS automated failover load test completed.'
} catch {$failure=$_;$result=1}
finally {
  if($k6 -and -not $k6.Completed){
    try{Stop-LoggedNativeProcess $k6 15 'k6'|Out-Null}catch{if($failure){Write-Warning "k6 log/process cleanup failed: $($_.Exception.Message)"}else{$failure=$_;$result=1}}
  }
  try {
    if($stopped -or -not(Get-AlbTargetProcess 'motorlog-b' 3102 -AllowMissing)){& (Join-Path $PSScriptRoot 'start-alb-targets.ps1')}
    foreach($port in 3101,3102,3103){Wait-TargetHealth $port healthy}
    Sync-AlbTargetManifest|Out-Null
    Write-Host 'PASS all three ALB targets recovered to healthy.'
  } catch {$result=1;if($failure){Write-Warning $failure.Exception.Message};$failure=$_}
}
if($failure){Write-Error $failure.Exception.Message -ErrorAction Continue}
exit $result

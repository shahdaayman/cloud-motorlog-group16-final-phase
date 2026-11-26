. (Join-Path $PSScriptRoot 'alb-processes.ps1')
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'dist')|Out-Null
$started=@()
try {
  foreach($target in Get-AlbExpectedTargets){
    $existing=Get-AlbTargetProcess $target.id $target.port -AllowMissing
    if($existing){Write-Host "$($target.id) already running as verified PID $($existing.pid)";continue}
    if(Get-PortListenerPid $target.port){throw "Port $($target.port) has an unverified listener; refusing to start a duplicate"}
    $stdout=Join-Path $ProjectRoot "dist\$($target.id).out.log";$stderr=Join-Path $ProjectRoot "dist\$($target.id).err.log"
    $process=Start-Process -FilePath 'node' -ArgumentList @('scripts/alb-target.js',$target.id,[string]$target.port) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $started+=@([pscustomobject]@{id=$target.id;port=$target.port;pid=$process.Id})
    $verified=$null
    for($attempt=0;$attempt -lt 40 -and -not $verified;$attempt++){Start-Sleep -Milliseconds 250;try{$verified=Get-AlbTargetProcess $target.id $target.port -AllowMissing}catch{if(Get-PortListenerPid $target.port){throw}}}
    if(-not $verified){throw "$($target.id) did not start a verified listener on port $($target.port)"}
  }
  foreach($target in Get-AlbExpectedTargets){
    $response=Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$($target.port)/api/health" -TimeoutSec 2
    if($response.StatusCode -ne 200 -or $response.Headers['X-Motorlog-Instance'] -ne $target.id){throw "$($target.id) health identity check failed"}
    Write-Host "PASS $($target.id) verified on port $($target.port)"
  }
  Sync-AlbTargetManifest|Out-Null
} catch {
  foreach($item in $started){try{$owned=Get-AlbTargetProcess $item.id $item.port -AllowMissing;if($owned -and $owned.pid -eq $item.pid){Stop-Process -Id $owned.pid -Force}}catch{}}
  try{Sync-AlbTargetManifest -AllowMissing|Out-Null}catch{}
  throw
}

. (Join-Path $PSScriptRoot 'alb-processes.ps1')
try {
  foreach($target in Get-AlbExpectedTargets){
    $existing=Get-AlbTargetProcess $target.id $target.port -AllowMissing
    if($existing){Write-Host "Stopping verified $($target.id) PID $($existing.pid)";Stop-AlbTarget $target.id $target.port}
    elseif(Get-PortListenerPid $target.port){throw "Port $($target.port) has an unverified listener; refusing to terminate it"}
  }
} finally {
  try{Sync-AlbTargetManifest -AllowMissing|Out-Null}catch{}
}
& (Join-Path $PSScriptRoot 'start-alb-targets.ps1')

. (Join-Path $PSScriptRoot 'cloud-common.ps1')

function Get-AlbExpectedTargets {
  @(
    [pscustomobject]@{id='motorlog-a';port=3101}
    [pscustomobject]@{id='motorlog-b';port=3102}
    [pscustomobject]@{id='motorlog-c';port=3103}
  )
}

function Get-PortListenerPid([int]$Port) {
  $ids=@()
  try {$ids=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop|Select-Object -ExpandProperty OwningProcess -Unique)} catch {}
  if(-not $ids.Count){
    $pattern="^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
    $ids=@(& netstat -ano -p TCP|ForEach-Object{if($_ -match $pattern){[int]$matches[1]}}|Select-Object -Unique)
  }
  if($ids.Count -gt 1){throw "Multiple processes listen on backend port $Port"}
  if($ids.Count){return [int]$ids[0]}
  return $null
}

function Test-AlbTargetCommandLine([string]$CommandLine,[string]$Id,[int]$Port) {
  $escapedId=[regex]::Escape($Id);$escapedPort=[regex]::Escape([string]$Port)
  $expected=('(?i)(?:^|[\\/\s"])(?:scripts[\\/])?alb-target\.js"?\s+{0}\s+{1}(?:\s|$)' -f $escapedId,$escapedPort)
  return $CommandLine -match $expected
}

function Get-AlbTargetProcess([string]$Id,[int]$Port,[switch]$AllowMissing) {
  $listenerPid=Get-PortListenerPid $Port
  if(-not $listenerPid){if($AllowMissing){return $null};throw "$Id is not listening on port $Port"}
  $process=Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
  $details=Get-CimInstance Win32_Process -Filter "ProcessId = $listenerPid" -ErrorAction SilentlyContinue
  if(-not $process -or -not $details){throw "Cannot inspect the process listening on port $Port; refusing to use PID $listenerPid"}
  if($process.ProcessName -notin 'node','node.exe' -and $details.Name -notin 'node','node.exe'){throw "Port $Port is owned by $($details.Name), not node.exe; refusing to manage PID $listenerPid"}
  $command=[string]$details.CommandLine
  if(-not(Test-AlbTargetCommandLine $command $Id $Port)){throw "Port $Port is owned by node.exe but its command line is not the expected $Id target; refusing to manage PID $listenerPid"}
  [pscustomobject]@{id=$Id;port=$Port;pid=$listenerPid;commandLine=$command}
}

function Sync-AlbTargetManifest([switch]$AllowMissing) {
  $records=@()
  foreach($target in Get-AlbExpectedTargets){
    $record=Get-AlbTargetProcess $target.id $target.port -AllowMissing:$AllowMissing
    if($record){$records+=@([pscustomobject]@{id=$record.id;port=$record.port;pid=$record.pid})}
  }
  Write-JsonFile (Join-Path $ProjectRoot 'dist\alb-targets.json') @{targets=$records}
  return $records
}

function Stop-AlbTarget([string]$Id,[int]$Port,[int]$TimeoutSeconds=15) {
  $record=Get-AlbTargetProcess $Id $Port
  Stop-Process -Id $record.pid -Force -ErrorAction Stop
  for($i=0;$i -lt ($TimeoutSeconds*4);$i++){if(-not(Get-PortListenerPid $Port)){Sync-AlbTargetManifest -AllowMissing|Out-Null;return};Start-Sleep -Milliseconds 250}
  throw "$Id PID $($record.pid) did not release port $Port"
}

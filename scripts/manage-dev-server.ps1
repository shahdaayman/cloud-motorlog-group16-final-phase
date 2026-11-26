param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('start','status','stop')]
  [string]$Action
)

$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent $PSScriptRoot
$StateDir=Join-Path $ProjectRoot '.motorlog'
$StatePath=Join-Path $StateDir 'dev-server.json'
$StdoutPath=Join-Path $StateDir 'dev-server.stdout.log'
$StderrPath=Join-Path $StateDir 'dev-server.stderr.log'

function Read-State {
  if(-not(Test-Path -LiteralPath $StatePath)){return $null}
  try{return Get-Content -LiteralPath $StatePath -Raw|ConvertFrom-Json}catch{return $null}
}

function Get-OwnedProcess {
  $state=Read-State
  if(-not $state -or -not $state.pid){return $null}
  $process=Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)" -ErrorAction SilentlyContinue
  if(-not $process){return $null}
  if($process.Name -notin 'node','node.exe'){return $null}
  $command=[string]$process.CommandLine
  if($command -notmatch '(?i)(?:^|[\\/\s"])(?:backend[\\/])dev-server\.js(?:"|\s|$)'){return $null}
  $expected=[datetime]::Parse([string]$state.startedAt).ToUniversalTime()
  $created=[Management.ManagementDateTimeConverter]::ToDateTime([string]$process.CreationDate).ToUniversalTime()
  if([math]::Abs(($created-$expected).TotalSeconds) -gt 15){return $null}
  return $process
}

function Test-Health {
  try{return (Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/api/health' -TimeoutSec 2).StatusCode -eq 200}catch{return $false}
}

switch($Action){
  'status' {
    $owned=Get-OwnedProcess
    if($owned){Write-Output "managed-running pid=$($owned.ProcessId)";exit 0}
    if(Test-Health){Write-Output 'unmanaged-running';exit 0}
    Write-Output 'stopped';exit 1
  }
  'start' {
    $owned=Get-OwnedProcess
    if($owned){Write-Output "managed-running pid=$($owned.ProcessId)";exit 0}
    if(Test-Health){Write-Output 'unmanaged-running';exit 0}
    New-Item -ItemType Directory -Force -Path $StateDir|Out-Null
    $startedAt=(Get-Date).ToUniversalTime()
    $process=Start-Process -FilePath 'node' -ArgumentList @('backend/dev-server.js') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru
    @{pid=$process.Id;startedAt=$startedAt.ToString('o');script='backend/dev-server.js'}|ConvertTo-Json|Set-Content -LiteralPath $StatePath -Encoding utf8
    for($attempt=0;$attempt -lt 60;$attempt++){
      if(Test-Health){Write-Output "started pid=$($process.Id)";exit 0}
      if($process.HasExited){break}
      Start-Sleep -Milliseconds 500
    }
    Write-Error "Motorlog server failed to become healthy. See $StderrPath"
    exit 1
  }
  'stop' {
    $state=Read-State
    if(-not $state){Write-Output 'not-managed';exit 0}
    $owned=Get-OwnedProcess
    if(-not $owned){
      Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
      Write-Output 'stale-record-removed';exit 0
    }
    Stop-Process -Id $owned.ProcessId -ErrorAction Stop
    for($attempt=0;$attempt -lt 40;$attempt++){
      if(-not(Get-Process -Id $owned.ProcessId -ErrorAction SilentlyContinue)){
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        Write-Output "stopped pid=$($owned.ProcessId)";exit 0
      }
      Start-Sleep -Milliseconds 250
    }
    Write-Error "Managed Motorlog process $($owned.ProcessId) did not stop in time."
    exit 1
  }
}

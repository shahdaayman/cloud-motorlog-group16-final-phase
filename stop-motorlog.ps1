param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ManagerArgs)
$ErrorActionPreference='Stop'; $root=Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates=@(@((Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),(Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),(Join-Path $env:LocalAppData 'Programs\Git\bin\bash.exe'))|Where-Object{$_ -and(Test-Path -LiteralPath $_)})
if(-not $candidates.Count){Write-Error 'Git Bash was not found. Install Git for Windows.';exit 127}
& $candidates[0] (Join-Path $root 'stop-motorlog.sh') @ManagerArgs
exit $LASTEXITCODE

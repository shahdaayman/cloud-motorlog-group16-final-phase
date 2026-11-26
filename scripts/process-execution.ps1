function ConvertTo-NativeProcessArgument([string]$Value) {
  if($Value -notmatch '[\s"]'){return $Value}
  $escaped=[regex]::Replace($Value,'(\\*)"','$1$1\"')
  $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
  return '"'+$escaped+'"'
}

function Start-LoggedNativeProcess([string]$FilePath,[string[]]$ArgumentList,[string]$WorkingDirectory,[string]$StandardOutputPath,[string]$StandardErrorPath) {
  if(-not([IO.Path]::IsPathRooted($FilePath))){throw 'Native process executable path must be absolute'}
  $startInfo=New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName=$FilePath
  $quotedArguments=foreach($argument in $ArgumentList){ConvertTo-NativeProcessArgument ([string]$argument)}
  $startInfo.Arguments=$quotedArguments -join ' '
  $startInfo.WorkingDirectory=$WorkingDirectory
  $startInfo.UseShellExecute=$false
  $startInfo.CreateNoWindow=$true
  $startInfo.RedirectStandardOutput=$true
  $startInfo.RedirectStandardError=$true
  $process=New-Object System.Diagnostics.Process
  $process.StartInfo=$startInfo
  if(-not $process.Start()){throw "Failed to start $FilePath"}
  # Drain both pipes immediately and concurrently. Waiting before reading either
  # redirected stream can deadlock when its OS pipe buffer fills.
  $outputTask=$process.StandardOutput.ReadToEndAsync()
  $errorTask=$process.StandardError.ReadToEndAsync()
  [pscustomobject]@{Process=$process;OutputTask=$outputTask;ErrorTask=$errorTask;OutputPath=$StandardOutputPath;ErrorPath=$StandardErrorPath;Completed=$false;ExitCode=$null}
}

function Complete-LoggedNativeProcess($Context,[int]$TimeoutSeconds=90,[string]$Name='Process') {
  if(-not $Context -or -not $Context.Process){throw "$Name process context is missing"}
  if($Context.Completed){return [int]$Context.ExitCode}
  $milliseconds=[Math]::Max(0,$TimeoutSeconds*1000)
  if(-not $Context.Process.WaitForExit($milliseconds)){throw "$Name did not finish within $TimeoutSeconds seconds"}
  # The parameterless call is required after the timed overload on .NET Framework
  # to finalize redirected stream handling and the retained native process handle.
  $Context.Process.WaitForExit()
  $stdout=$Context.OutputTask.Result
  $stderr=$Context.ErrorTask.Result
  $encoding=New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Context.OutputPath,[string]$stdout,$encoding)
  [IO.File]::WriteAllText($Context.ErrorPath,[string]$stderr,$encoding)
  $exitCode=[int]$Context.Process.ExitCode
  $Context.ExitCode=$exitCode;$Context.Completed=$true
  return $exitCode
}

function Stop-LoggedNativeProcess($Context,[int]$TimeoutSeconds=15,[string]$Name='Process') {
  if(-not $Context -or -not $Context.Process){return}
  $Context.Process.Refresh()
  if(-not $Context.Process.HasExited){$Context.Process.Kill()}
  Complete-LoggedNativeProcess $Context $TimeoutSeconds $Name
}

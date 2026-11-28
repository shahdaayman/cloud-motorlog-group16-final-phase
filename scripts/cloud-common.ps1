$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AwsProfile = $env:AWS_PROFILE
$FlociUrl = if ($env:AWS_ENDPOINT_URL) { $env:AWS_ENDPOINT_URL } else { 'http://localhost:4566' }
$Region = if ($env:AWS_REGION) { $env:AWS_REGION } else { 'us-east-1' }

function Invoke-Aws {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  if ($AwsProfile) { & aws --profile $AwsProfile --region $Region --endpoint-url $FlociUrl @Arguments }
  else {
    if (-not $env:AWS_ACCESS_KEY_ID) { $env:AWS_ACCESS_KEY_ID='test' }
    if (-not $env:AWS_SECRET_ACCESS_KEY) { $env:AWS_SECRET_ACCESS_KEY='test' }
    & aws --region $Region --endpoint-url $FlociUrl @Arguments
  }
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI failed: aws $($Arguments -join ' ')" }
}

function Invoke-AwsExistenceCheck {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string[]]$NotFoundErrorCodes
  )

  # Discovery calls are the only AWS calls whose stderr is captured. A recognized
  # not-found response is returned as data; every other CLI failure is re-emitted.
  $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "motorlog-aws-check-$([guid]::NewGuid().ToString('N')).stderr"
  try {
    # Windows PowerShell promotes redirected native stderr to ErrorRecord objects
    # under Stop. Continue is scoped to this one captured discovery invocation.
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      if ($AwsProfile) {
        $output = @(& aws --profile $AwsProfile --region $Region --endpoint-url $FlociUrl @Arguments 2> $stderrPath)
      } else {
        if (-not $env:AWS_ACCESS_KEY_ID) { $env:AWS_ACCESS_KEY_ID='test' }
        if (-not $env:AWS_SECRET_ACCESS_KEY) { $env:AWS_SECRET_ACCESS_KEY='test' }
        $output = @(& aws --region $Region --endpoint-url $FlociUrl @Arguments 2> $stderrPath)
      }
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $stderrText = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }

    if ($exitCode -eq 0) {
      return [pscustomobject]@{ Exists = $true; Output = ($output -join [Environment]::NewLine) }
    }

    $isNotFound = $false
    foreach ($code in $NotFoundErrorCodes) {
      if ($stderrText -match "(?<![A-Za-z0-9_])$([regex]::Escape($code))(?![A-Za-z0-9_])") { $isNotFound = $true; break }
    }
    if ($isNotFound) {
      return [pscustomobject]@{ Exists = $false; Output = $null }
    }

    if ($stderrText) { [Console]::Error.Write($stderrText) }
    throw "AWS CLI discovery check failed with exit code $exitCode`: aws $($Arguments -join ' ')"
  } finally {
    if (Test-Path -LiteralPath $stderrPath) { Remove-Item -LiteralPath $stderrPath -Force }
  }
}

function Wait-MotorlogLambdaActive {
  param([Parameter(Mandatory = $true)][string]$FunctionName)
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    $configuration = Invoke-Aws lambda get-function-configuration --function-name $FunctionName | ConvertFrom-Json
    if ($configuration.State -eq 'Active' -and $configuration.LastUpdateStatus -notin @('InProgress','Failed')) { return $configuration }
    if ($configuration.State -eq 'Failed' -or $configuration.LastUpdateStatus -eq 'Failed') {
      throw "Lambda $FunctionName failed to become Active: $($configuration.StateReason)$($configuration.LastUpdateStatusReason)"
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for Lambda $FunctionName to become Active."
}

function Get-DotEnv {
  $values = @{}
  $path = Join-Path $ProjectRoot '.env'
  if (-not (Test-Path -LiteralPath $path)) { throw '.env is required. Run npm run auth:setup first.' }
  foreach ($line in Get-Content -LiteralPath $path) {
    if ($line -match '^\s*([^#=\s]+)=(.*)$') {
      $value=$matches[2].Trim()
      if ($value -match '^(.*?)\s+#.*$') { $value=$matches[1].Trim() }
      $values[$matches[1]] = $value.Trim('"').Trim("'").TrimEnd('#').Trim()
    }
  }
  return $values
}

function Write-JsonFile {
  param([string]$Path, $Value)
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($Path,$json,(New-Object System.Text.UTF8Encoding($false)))
}

function Get-DeploymentInfoPath { Join-Path $ProjectRoot 'dist\floci-deployment.json' }

function Get-MotorlogApiDeployment {
  $apis=Invoke-Aws apigateway get-rest-apis --limit 500|ConvertFrom-Json
  $api=@($apis.items|Where-Object name -eq 'motorlog-api')[0]
  if(-not $api){throw 'motorlog-api was not found. Run npm run api:deploy.'}
  $stages=Invoke-Aws apigateway get-stages --rest-api-id $api.id|ConvertFrom-Json
  $stage=@($stages.item)[0]
  if(-not $stage -or -not $stage.stageName){throw 'motorlog-api has no deployed stage. Run npm run api:deploy.'}
  $endpoint=[Uri]$FlociUrl
  $url="$($endpoint.Scheme)://$($api.id).execute-api.localhost.localstack.cloud:$($endpoint.Port)/$($stage.stageName)"
  [pscustomobject]@{id=$api.id;stage=$stage.stageName;url=$url}
}

function Get-MotorlogCloudFrontDeployment {
  $path=Join-Path $ProjectRoot 'dist\cloudfront-deployment.json';$metadata=if(Test-Path -LiteralPath $path){Get-Content -LiteralPath $path -Raw|ConvertFrom-Json}else{$null}
  if($metadata -and $metadata.id){$distribution=(Invoke-Aws cloudfront get-distribution --id $metadata.id|ConvertFrom-Json).Distribution;if($distribution.DistributionConfig.Comment -ne 'Motorlog Frontend'){throw 'Saved CloudFront distribution is not the Motorlog frontend.'};return [pscustomobject]@{id=$metadata.id;url=$metadata.url;distribution=$distribution}}
  $listed=Invoke-Aws cloudfront list-distributions|ConvertFrom-Json;$matches=@($listed.DistributionList.Items|Where-Object{$_.Comment -eq 'Motorlog Frontend'})
  if($matches.Count -ne 1){throw "Expected one Motorlog Frontend CloudFront distribution, found $($matches.Count)."}
  $endpoint=[Uri]$FlociUrl;$url="$($endpoint.Scheme)://$($matches[0].Id.ToLowerInvariant()).cloudfront.localhost.localstack.cloud:$($endpoint.Port)"
  [pscustomobject]@{id=$matches[0].Id;url=$url;distribution=$matches[0]}
}

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
  [pscustomobject]@{id=$api.id;stage=$stage.stageName;url="$FlociUrl/restapis/$($api.id)/$($stage.stageName)/_user_request_"}
}

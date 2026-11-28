. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$infoPath=Join-Path $ProjectRoot 'dist\cloudfront-deployment.json'
if(-not(Test-Path -LiteralPath $infoPath)){throw 'Run npm run cloudfront:deploy first.'}
$info=Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json
$distribution=(Invoke-Aws cloudfront get-distribution --id $info.id|ConvertFrom-Json).Distribution
if(-not $distribution.DistributionConfig.Enabled){throw 'CloudFront distribution is disabled.'}
if($distribution.DistributionConfig.Origins.Items[0].DomainName -ne $info.originDomain){throw 'CloudFront origin is not the expected existing S3 bucket.'}
function Assert-Http([string]$path,[string]$type){
  $response=Invoke-WebRequest -UseBasicParsing -Uri "$($info.url)$path" -TimeoutSec 20
  if($response.StatusCode -ne 200){throw "$path returned $($response.StatusCode)"}
  if($response.Headers['Content-Type'] -notlike "$type*"){throw "$path has wrong Content-Type: $($response.Headers['Content-Type'])"}
  Write-Host "PASS $path -> 200 $($response.Headers['Content-Type'])"
}
Assert-Http '/' 'text/html';Assert-Http '/css/styles.css' 'text/css';Assert-Http '/js/app.js' 'application/javascript';Assert-Http '/admin/' 'text/html';Assert-Http '/css/admin.css' 'text/css';Assert-Http '/js/admin.js' 'application/javascript'
$api=(Get-MotorlogApiDeployment).url;$origin=$info.url.TrimEnd('/')
foreach($path in '/api/vehicles','/api/admin/overview'){
  $preflight=Invoke-WebRequest -UseBasicParsing -Method OPTIONS -Uri "$api$path" -Headers @{Origin=$origin;'Access-Control-Request-Method'='GET';'Access-Control-Request-Headers'='authorization,content-type,idempotency-key'}
  if($preflight.StatusCode -notin 200,204 -or $preflight.Headers['Access-Control-Allow-Origin'] -ne $origin -or $preflight.Headers['Access-Control-Allow-Headers'] -notmatch '(?i)idempotency-key'){throw "CORS preflight failed for $path"}
  try{$null=Invoke-WebRequest -UseBasicParsing -Uri "$api$path" -Headers @{Origin=$origin};throw "Unauthenticated $path unexpectedly succeeded"}catch{
    $errorResponse=$_.Exception.Response
    if(-not $errorResponse -or [int]$errorResponse.StatusCode -ne 401 -or $errorResponse.Headers['Access-Control-Allow-Origin'] -ne $origin){throw "Protected unauthenticated check failed for $path"}
  }
  Write-Host "PASS OPTIONS and unauthenticated 401 CORS for $path"
}
$reminderPreflight=Invoke-WebRequest -UseBasicParsing -Method OPTIONS -Uri "$api/api/vehicles/cors-probe/reminders" -Headers @{Origin=$origin;'Access-Control-Request-Method'='POST';'Access-Control-Request-Headers'='authorization,content-type,idempotency-key'}
if($reminderPreflight.StatusCode -notin 200,204 -or $reminderPreflight.Headers['Access-Control-Allow-Origin'] -ne $origin -or $reminderPreflight.Headers['Access-Control-Allow-Methods'] -notmatch 'POST' -or $reminderPreflight.Headers['Access-Control-Allow-Headers'] -notmatch '(?i)idempotency-key'){throw 'Reminder creation CORS preflight failed.'}
Write-Host 'PASS reminder creation OPTIONS allows Authorization, Content-Type, and Idempotency-Key'
$config=Invoke-WebRequest -UseBasicParsing -Uri "$($info.url)/js/config.js"
if($config.Content -notmatch [regex]::Escape($api)){throw 'CloudFront frontend API configuration is incorrect.'}
Write-Host "PASS CloudFront distribution $($info.id) is enabled, serves the existing S3 origin, and has API CORS."

. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$infoPath = Get-DeploymentInfoPath
if (-not (Test-Path -LiteralPath $infoPath)) { throw 'Deployment information is missing.' }
$info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
$apiDeployment=Get-MotorlogApiDeployment
$info|Add-Member -Force NoteProperty invokeUrl $apiDeployment.url
$payloadPath = Join-Path $ProjectRoot 'dist\lambda-health-event.json'
$responsePath = Join-Path $ProjectRoot 'dist\lambda-response.json'
Write-JsonFile $payloadPath @{version='2.0';routeKey='GET /api/health';rawPath='/api/health';rawQueryString='';headers=@{host='localhost'};requestContext=@{http=@{method='GET';path='/api/health';sourceIp='127.0.0.1';protocol='HTTP/1.1'}};isBase64Encoded=$false}
foreach ($property in $info.functions.PSObject.Properties) {
  Invoke-Aws lambda invoke --function-name $property.Value --cli-binary-format raw-in-base64-out --payload "fileb://$payloadPath" $responsePath | Out-Null
  $body=Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json
  if ($body.statusCode -ne 200) { throw "$($property.Value) direct health invocation failed: $($body.statusCode)" }
  Write-Host "PASS direct Lambda: $($property.Value)"
}
$health=Invoke-WebRequest -UseBasicParsing -Uri "$($info.invokeUrl.TrimEnd('/'))/api/health" -Method GET
if ($health.StatusCode -ne 200) { throw 'API Gateway health check failed' }
Write-Host 'PASS API Gateway health'
try { Invoke-WebRequest -UseBasicParsing -Uri "$($info.invokeUrl.TrimEnd('/'))/api/vehicles" -Method GET | Out-Null; throw 'Anonymous protected request unexpectedly succeeded' } catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 401) { throw }
}
Write-Host 'PASS anonymous request denied with 401'

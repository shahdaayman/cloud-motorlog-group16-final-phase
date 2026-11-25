. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$manifest = Get-Content -LiteralPath (Join-Path $ProjectRoot 'infra\api-routes.json') -Raw | ConvertFrom-Json
$infoPath = Get-DeploymentInfoPath
if (-not (Test-Path -LiteralPath $infoPath)) { throw 'Run npm run lambda:deploy first.' }
$info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json

$apis = Invoke-Aws apigateway get-rest-apis --limit 500 | ConvertFrom-Json
$api = @($apis.items | Where-Object name -eq 'motorlog-api')[0]
if (-not $api) { $api = (Invoke-Aws apigateway create-rest-api --name motorlog-api --description 'Motorlog REST API on Floci' --endpoint-configuration types=REGIONAL | ConvertFrom-Json) }
$apiId = $api.id
$resources = Invoke-Aws apigateway get-resources --rest-api-id $apiId --limit 500 | ConvertFrom-Json
$root = @($resources.items | Where-Object path -eq '/')[0]
$resourceByPath = @{'/'=$root.id}
foreach ($resource in $resources.items) { $resourceByPath[$resource.path] = $resource.id }

function Ensure-Resource([string]$path) {
  if ($resourceByPath[$path]) { return $resourceByPath[$path] }
  $parentPath = $path.Substring(0,$path.LastIndexOf('/')); if (-not $parentPath) { $parentPath='/' }
  $part = $path.Substring($path.LastIndexOf('/')+1)
  $parentId = Ensure-Resource $parentPath
  $created = Invoke-Aws apigateway create-resource --rest-api-id $apiId --parent-id $parentId --path-part $part | ConvertFrom-Json
  $resourceByPath[$path]=$created.id
  return $created.id
}
$permissionSids=@{}
function Ensure-LambdaPermission([string]$functionName,[string]$statementId,[string]$sourceArn) {
  if(-not $permissionSids.ContainsKey($functionName)){$known=@{};try{$policy=Invoke-Aws lambda get-policy --function-name $functionName|ConvertFrom-Json;$document=$policy.Policy|ConvertFrom-Json;@($document.Statement)|ForEach-Object{$known[$_.Sid]=$true}}catch{};$permissionSids[$functionName]=$known}
  if(-not $permissionSids[$functionName].ContainsKey($statementId)){Invoke-Aws lambda add-permission --function-name $functionName --statement-id $statementId --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn $sourceArn|Out-Null;$permissionSids[$functionName][$statementId]=$true}
}

$routes = @()
$corsConfigured = @{}
foreach ($service in 'vehicles','fuel','reminders') {
  foreach ($route in $manifest.$service) {
    if ($route -notmatch '^(GET|POST|PATCH|DELETE|PUT|OPTIONS)\s+(.+)$') { throw "Invalid route: $route" }
    $method=$matches[1];$path=$matches[2];$resourceId=Ensure-Resource $path
    try { Invoke-Aws apigateway put-method --rest-api-id $apiId --resource-id $resourceId --http-method $method --authorization-type NONE | Out-Null } catch {
      if ($_.Exception.Message -notmatch 'Conflict') { throw }
    }
    $functionName = $info.functions.$service
    $functionArn = "arn:aws:lambda:$Region`:000000000000:function:$functionName"
    $uri = "arn:aws:apigateway:$Region`:lambda:path/2015-03-31/functions/$functionArn/invocations"
    Invoke-Aws apigateway put-integration --rest-api-id $apiId --resource-id $resourceId --http-method $method --type AWS_PROXY --integration-http-method POST --uri $uri | Out-Null
    $sourceArn="arn:aws:execute-api:$Region`:000000000000:$apiId/*/$method$path"
    Ensure-LambdaPermission $functionName "apigw-$($method.ToLower())-$([Math]::Abs($path.GetHashCode()))" $sourceArn
    if (-not $corsConfigured[$path]) {
      try { Invoke-Aws apigateway put-method --rest-api-id $apiId --resource-id $resourceId --http-method OPTIONS --authorization-type NONE | Out-Null } catch { if ($_.Exception.Message -notmatch 'Conflict') { throw } }
      Invoke-Aws apigateway put-integration --rest-api-id $apiId --resource-id $resourceId --http-method OPTIONS --type AWS_PROXY --integration-http-method POST --uri $uri | Out-Null
      $optionsArn="arn:aws:execute-api:$Region`:000000000000:$apiId/*/OPTIONS$path"
      Ensure-LambdaPermission $functionName "apigw-options-$([Math]::Abs($path.GetHashCode()))" $optionsArn
      $corsConfigured[$path]=$true
    }
    $routes += @{method=$method;path=$path;service=$service;function=$functionName}
  }
}

$s3Origin='http://motorlog-frontend.s3-website.localhost.localstack.cloud:4566'
foreach($responseType in 'DEFAULT_4XX','DEFAULT_5XX'){
  $gatewayResponsePath=Join-Path $ProjectRoot "dist\gateway-response-$responseType.json"
  Write-JsonFile $gatewayResponsePath @{restApiId=$apiId;responseType=$responseType;responseParameters=@{
    'gatewayresponse.header.Access-Control-Allow-Origin'="'$s3Origin'"
    'gatewayresponse.header.Access-Control-Allow-Headers'="'Content-Type,Authorization'"
    'gatewayresponse.header.Access-Control-Allow-Methods'="'GET,POST,PATCH,DELETE,OPTIONS'"
  }}
  Invoke-Aws apigateway put-gateway-response --cli-input-json "file://$gatewayResponsePath"|Out-Null
}

Invoke-Aws apigateway create-deployment --rest-api-id $apiId --stage-name dev --description "Motorlog deployment $(Get-Date -Format s)" | Out-Null
$invokeUrl="$FlociUrl/restapis/$apiId/dev/_user_request_"
$info | Add-Member -Force NoteProperty apiId $apiId
$info | Add-Member -Force NoteProperty stage 'dev'
$info | Add-Member -Force NoteProperty invokeUrl $invokeUrl
$info | Add-Member -Force NoteProperty routes $routes
Write-JsonFile $infoPath $info
Write-Host "API Gateway deployed: $apiId"
Write-Host "Invoke URL: $invokeUrl"

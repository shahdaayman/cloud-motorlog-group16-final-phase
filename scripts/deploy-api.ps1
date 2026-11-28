param([string]$Stage)
. (Join-Path $PSScriptRoot 'cloud-common.ps1')

$manifest=Get-Content -LiteralPath (Join-Path $ProjectRoot 'infra\api-routes.json') -Raw|ConvertFrom-Json
$infoPath=Get-DeploymentInfoPath
if(-not(Test-Path -LiteralPath $infoPath)){throw 'Run npm run lambda:deploy first.'}
$info=Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json
if(-not $Stage){$Stage=$env:MOTORLOG_API_STAGE};if(-not $Stage -and $info.stage){$Stage=[string]$info.stage};if(-not $Stage){$Stage='dev'}
if($Stage -notmatch '^[A-Za-z0-9_-]+$'){throw "Invalid API Gateway stage name: $Stage"}

function Status([string]$Kind,[string]$Message){Write-Host ('[{0,-7}] {1}' -f $Kind,$Message)}
function Stable-Hash([string]$Value){$h=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Value));([BitConverter]::ToString($h)-replace '-','').ToLowerInvariant()}
function Policy-Matches($Statement,[string]$SourceArn){
  $principal=if($Statement.Principal -is [string]){$Statement.Principal}else{$Statement.Principal.Service};$arn=$null
  foreach($op in 'ArnLike','ArnEquals'){$c=$Statement.Condition.$op;if($c){$p=$c.psobject.Properties|Where-Object{$_.Name -in 'AWS:SourceArn','aws:SourceArn'}|Select-Object -First 1;if($p){$arn=[string]$p.Value;break}}}
  $Statement.Effect -eq 'Allow' -and @($Statement.Action) -contains 'lambda:InvokeFunction' -and $principal -eq 'apigateway.amazonaws.com' -and $arn -eq $SourceArn
}
function Ensure-Permission([string]$Function,[string]$Sid,[string]$SourceArn){
  $check=Invoke-AwsExistenceCheck -Arguments @('lambda','get-policy','--function-name',$Function) -NotFoundErrorCodes @('ResourceNotFoundException');$statements=@()
  if($check.Exists){$envelope=$check.Output|ConvertFrom-Json;$statements=@(($envelope.Policy|ConvertFrom-Json).Statement)}else{Status INFO "Lambda permission not found; creating for $Function..."}
  $sameSid=@($statements|Where-Object Sid -eq $Sid|Select-Object -First 1)
  if($sameSid.Count -and (Policy-Matches $sameSid[0] $SourceArn)){Status EXISTS "Lambda permission $Sid";return $false}
  if(@($statements|Where-Object{Policy-Matches $_ $SourceArn}).Count){Status EXISTS "Lambda permission for $SourceArn";return $false}
  if($sameSid.Count){Status UPDATE "Incorrect Lambda permission $Sid";Invoke-Aws lambda remove-permission --function-name $Function --statement-id $Sid|Out-Null}else{Status CREATE "Lambda permission $Sid"}
  Invoke-Aws lambda add-permission --function-name $Function --statement-id $Sid --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn $SourceArn|Out-Null
  $verify=Invoke-Aws lambda get-policy --function-name $Function|ConvertFrom-Json;$statements=@(($verify.Policy|ConvertFrom-Json).Statement)
  if(-not @($statements|Where-Object Sid -eq $Sid|Where-Object{Policy-Matches $_ $SourceArn}).Count){throw "Lambda permission verification failed for $Function ($Sid)."}
  $true
}

Write-Host "`n===============================================`n          MOTORLOG API GATEWAY DEPLOYMENT`n===============================================`n"
$functions=[ordered]@{}
foreach($service in 'vehicles','fuel','reminders'){$name=[string]$info.functions.$service;if(-not $name){throw "Missing functions.$service deployment metadata."};$c=Invoke-AwsExistenceCheck -Arguments @('lambda','get-function-configuration','--function-name',$name) -NotFoundErrorCodes @('ResourceNotFoundException');if(-not $c.Exists){throw "Required Lambda $name was not found. Run npm run lambda:deploy."};$functions[$service]=$name;Status OK "Lambda $name found"}

$changed=$false;$apis=Invoke-Aws apigateway get-rest-apis --limit 500|ConvertFrom-Json;$found=@($apis.items|Where-Object name -eq 'motorlog-api')
if($found.Count -gt 1){throw 'Multiple REST APIs named motorlog-api were found.'};$api=$found|Select-Object -First 1
if(-not $api){Status CREATE 'Motorlog REST API';$api=Invoke-Aws apigateway create-rest-api --name motorlog-api --description 'Motorlog REST API on Floci' --endpoint-configuration types=REGIONAL|ConvertFrom-Json;$changed=$true}else{Status EXISTS 'Motorlog REST API'};$apiId=$api.id
$resources=Invoke-Aws apigateway get-resources --rest-api-id $apiId --limit 500|ConvertFrom-Json;$root=@($resources.items|Where-Object path -eq '/')[0];if(-not $root){throw "REST API $apiId has no root resource."};$resourceByPath=@{'/'=$root.id};foreach($r in $resources.items){$resourceByPath[$r.path]=$r.id}
function Ensure-Resource([string]$Path){if($resourceByPath[$Path]){return $resourceByPath[$Path]};$parent=$Path.Substring(0,$Path.LastIndexOf('/'));if(-not $parent){$parent='/'};$parentId=Ensure-Resource $parent;$part=$Path.Substring($Path.LastIndexOf('/')+1);Status CREATE "API resource $Path";$r=Invoke-Aws apigateway create-resource --rest-api-id $apiId --parent-id $parentId --path-part $part|ConvertFrom-Json;$resourceByPath[$Path]=$r.id;$script:changed=$true;$r.id}
function Ensure-Integration([string]$ResourceId,[string]$Method,[string]$Path,[string]$Uri){
  $m=Invoke-AwsExistenceCheck -Arguments @('apigateway','get-method','--rest-api-id',$apiId,'--resource-id',$ResourceId,'--http-method',$Method) -NotFoundErrorCodes @('NotFoundException')
  if(-not $m.Exists){Status CREATE "$Method $Path method";Invoke-Aws apigateway put-method --rest-api-id $apiId --resource-id $ResourceId --http-method $Method --authorization-type NONE|Out-Null;$script:changed=$true}
  $c=Invoke-AwsExistenceCheck -Arguments @('apigateway','get-integration','--rest-api-id',$apiId,'--resource-id',$ResourceId,'--http-method',$Method) -NotFoundErrorCodes @('NotFoundException');$current=$false
  if($c.Exists){$i=$c.Output|ConvertFrom-Json;$current=$i.type -eq 'AWS_PROXY' -and $i.httpMethod -eq 'POST' -and $i.uri -eq $Uri}
  if(-not $current){Status $(if($c.Exists){'UPDATE'}else{'CREATE'}) "$Method $Path integration";Invoke-Aws apigateway put-integration --rest-api-id $apiId --resource-id $ResourceId --http-method $Method --type AWS_PROXY --integration-http-method POST --uri $Uri|Out-Null;$script:changed=$true}
}

$routes=@();$cors=@{}
# Ensure-Integration performs the equivalent idempotent `put-method --http-method OPTIONS`
# operation after first checking whether the preflight method already exists.
foreach($service in 'vehicles','fuel','reminders'){foreach($route in $manifest.$service){if($route -notmatch '^(GET|POST|PATCH|DELETE|PUT|OPTIONS)\s+(.+)$'){throw "Invalid route: $route"};$method=$matches[1];$path=$matches[2];$rid=Ensure-Resource $path;$fn=$functions[$service];$fnArn="arn:aws:lambda:$Region`:000000000000:function:$fn";$uri="arn:aws:apigateway:$Region`:lambda:path/2015-03-31/functions/$fnArn/invocations";Ensure-Integration $rid $method $path $uri;$source="arn:aws:execute-api:$Region`:000000000000:$apiId/*/$method$path";$sid="apigw-$($method.ToLowerInvariant())-$((Stable-Hash $path).Substring(0,16))";Ensure-Permission $fn $sid $source|Out-Null;if(-not $cors[$path]){Ensure-Integration $rid OPTIONS $path $uri;$source="arn:aws:execute-api:$Region`:000000000000:$apiId/*/OPTIONS$path";$sid="apigw-options-$((Stable-Hash $path).Substring(0,16))";Ensure-Permission $fn $sid $source|Out-Null;$cors[$path]=$true};$routes+=[ordered]@{method=$method;path=$path;service=$service;function=$fn}}}
foreach($route in $routes){$i=Invoke-Aws apigateway get-integration --rest-api-id $apiId --resource-id $resourceByPath[$route.path] --http-method $route.method|ConvertFrom-Json;if($i.type -ne 'AWS_PROXY' -or $i.httpMethod -ne 'POST'){throw "Invalid integration for $($route.method) $($route.path)."}}
Status OK 'API routes and integrations verified'

$origin='http://motorlog-frontend.s3-website.localhost.localstack.cloud:4566';$cloudFrontMetadata=Join-Path $ProjectRoot 'dist\cloudfront-deployment.json';if(Test-Path -LiteralPath $cloudFrontMetadata){$origin=(Get-MotorlogCloudFrontDeployment).url.TrimEnd('/')}
foreach($type in 'DEFAULT_4XX','DEFAULT_5XX'){$path=Join-Path $ProjectRoot "dist\gateway-response-$type.json";$desired=[ordered]@{'gatewayresponse.header.Access-Control-Allow-Origin'="'$origin'";'gatewayresponse.header.Access-Control-Allow-Headers'="'Authorization,Content-Type,Idempotency-Key'";'gatewayresponse.header.Access-Control-Allow-Methods'="'GET,POST,PATCH,DELETE,OPTIONS'"};$c=Invoke-AwsExistenceCheck -Arguments @('apigateway','get-gateway-response','--rest-api-id',$apiId,'--response-type',$type) -NotFoundErrorCodes @('NotFoundException');$current=$false;if($c.Exists){$e=$c.Output|ConvertFrom-Json;$current=$true;foreach($key in $desired.Keys){if([string]$e.responseParameters.$key -cne [string]$desired[$key]){$current=$false;break}}};if(-not $current){Write-JsonFile $path @{restApiId=$apiId;responseType=$type;responseParameters=$desired};Status $(if($c.Exists){'UPDATE'}else{'CREATE'}) "Gateway response $type";Invoke-Aws apigateway put-gateway-response --cli-input-json "file://$path"|Out-Null;$changed=$true}}

$fingerprintInput=($routes|ConvertTo-Json -Depth 5 -Compress)+"|$origin";$fingerprint=(Stable-Hash $fingerprintInput).Substring(0,24);$deploymentDescription="Motorlog API config $fingerprint"
$stages=Invoke-Aws apigateway get-stages --rest-api-id $apiId|ConvertFrom-Json;$existing=@($stages.item|Where-Object stageName -eq $Stage|Select-Object -First 1);$deploymentCurrent=$false
if($existing.Count -and $existing[0].deploymentId){$currentDeployment=Invoke-Aws apigateway get-deployment --rest-api-id $apiId --deployment-id $existing[0].deploymentId|ConvertFrom-Json;$deploymentCurrent=$currentDeployment.description -eq $deploymentDescription}
if(-not $existing.Count){Status CREATE "API Gateway $Stage stage";$deployment=Invoke-Aws apigateway create-deployment --rest-api-id $apiId --stage-name $Stage --description $deploymentDescription|ConvertFrom-Json}elseif($changed -or -not $deploymentCurrent){Status UPDATE "API Gateway $Stage deployment";$deployment=Invoke-Aws apigateway create-deployment --rest-api-id $apiId --stage-name $Stage --description $deploymentDescription|ConvertFrom-Json}else{Status EXISTS "API Gateway $Stage stage is current";$deployment=[pscustomobject]@{id=$existing[0].deploymentId}}
$stageInfo=Invoke-Aws apigateway get-stage --rest-api-id $apiId --stage-name $Stage|ConvertFrom-Json;if($stageInfo.stageName -ne $Stage -or -not $stageInfo.deploymentId){throw "Stage $Stage verification failed."};if($deployment.id -and $stageInfo.deploymentId -ne $deployment.id){throw "Stage $Stage does not reference deployment $($deployment.id)."};Status OK 'Lambda permissions verified';Status OK "Stage $Stage deployed successfully"

$endpoint=[Uri]$FlociUrl;$invokeUrl="$($endpoint.Scheme)://$apiId.execute-api.localhost.localstack.cloud:$($endpoint.Port)/$Stage";Status CHECK 'GET /api/health'
try{$response=Invoke-WebRequest -UseBasicParsing -Uri "$invokeUrl/api/health" -Method GET -TimeoutSec 15}catch{throw "API Gateway health request failed: $($_.Exception.Message)"}
if($response.StatusCode -ne 200){throw "Health returned HTTP $($response.StatusCode)."};try{$health=$response.Content|ConvertFrom-Json}catch{throw 'Health response was not valid JSON.'};if($health.status -ne 'ok' -or $health.service -ne 'vehicles' -or $health.runtime -ne 'lambda'){throw "Unexpected health response: $($response.Content)"};Status OK 'HTTP 200 - Lambda integration healthy'
foreach($probe in @(@{name='Fuel';path='/api/vehicles/probe/fuel'},@{name='Reminders';path='/api/reminders'})){$r=Invoke-WebRequest -UseBasicParsing -Uri "$invokeUrl$($probe.path)" -Method OPTIONS -Headers @{Origin='http://localhost:3000';'Access-Control-Request-Method'='GET'} -TimeoutSec 15;if($r.StatusCode -lt 200 -or $r.StatusCode -ge 300){throw "$($probe.name) probe returned HTTP $($r.StatusCode)."};Status OK "$($probe.name) integration reachable"}

$info|Add-Member -Force NoteProperty apiId $apiId;$info|Add-Member -Force NoteProperty stage $Stage;$info|Add-Member -Force NoteProperty invokeUrl $invokeUrl;$info|Add-Member -Force NoteProperty routes $routes;$info|Add-Member -Force NoteProperty apiDeploymentId $stageInfo.deploymentId;Write-JsonFile $infoPath $info
Write-Host "`n-----------------------------------------------`nAPI Gateway deployment: SUCCESS`n-----------------------------------------------`nInvoke URL: $invokeUrl"

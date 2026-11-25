param([string[]]$Services=@('vehicles','fuel','reminders'))
. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$envFile = Get-DotEnv
$dist = Join-Path $ProjectRoot 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

foreach ($required in 'COGNITO_USER_POOL_ID','COGNITO_APP_CLIENT_ID','COGNITO_ISSUER') {
  if (-not $envFile[$required]) { throw "$required is missing from .env" }
}

Push-Location $ProjectRoot
try { & npm run build; if ($LASTEXITCODE -ne 0) { throw 'Lambda packaging failed' } } finally { Pop-Location }

$roleName = 'motorlog-lambda-execution'
$trustPath = Join-Path $dist 'lambda-trust.json'
$policyPath = Join-Path $dist 'lambda-policy.json'
Write-JsonFile $trustPath @{Version='2012-10-17';Statement=@(@{Effect='Allow';Principal=@{Service='lambda.amazonaws.com'};Action='sts:AssumeRole'})}
$tablePrefix = if ($envFile.TABLE_PREFIX) { $envFile.TABLE_PREFIX } else { 'CML' }
$tableArns = @('Users','Vehicles','Maintenance','Fuel','Expenses','Reminders','Audit','AuthRateLimits') | ForEach-Object { "arn:aws:dynamodb:$Region`:000000000000:table/$tablePrefix$_*" }
Write-JsonFile $policyPath @{Version='2012-10-17';Statement=@(
  @{Effect='Allow';Action=@('logs:CreateLogGroup','logs:CreateLogStream','logs:PutLogEvents');Resource='*'},
  @{Effect='Allow';Action=@('dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:BatchWriteItem','dynamodb:Query','dynamodb:Scan','dynamodb:DescribeTable');Resource=$tableArns},
  @{Effect='Allow';Action=@('cognito-idp:*');Resource='*'},
  @{Effect='Allow';Action=@('sqs:SendMessage','sqs:GetQueueAttributes');Resource='*'},
  @{Effect='Allow';Action=@('ses:SendEmail','ses:GetAccount');Resource='*'},
  @{Effect='Allow';Action=@('s3:ListBucket','apigateway:GET','lambda:GetFunction','iam:GetRole','cloudwatch:DescribeAlarms','scheduler:GetSchedule','cloudfront:ListDistributions','elasticloadbalancing:DescribeLoadBalancers');Resource='*'}
)}

$role = $null
try { $role = Invoke-Aws iam get-role --role-name $roleName | ConvertFrom-Json } catch {
  $role = Invoke-Aws iam create-role --role-name $roleName --assume-role-policy-document "file://$trustPath" | ConvertFrom-Json
}
Invoke-Aws iam put-role-policy --role-name $roleName --policy-name motorlog-runtime --policy-document "file://$policyPath" | Out-Null
$roleArn = $role.Role.Arn

$internalEndpoint = 'http://host.docker.internal:4566'
$jwksPath = "/$($envFile.COGNITO_USER_POOL_ID)/.well-known/jwks.json"
$configuredOrigins=if($envFile.CORS_ORIGINS){$envFile.CORS_ORIGINS}else{'http://localhost:3000,http://localhost:4566'}
$s3FrontendOrigin='http://motorlog-frontend.s3-website.localhost.localstack.cloud:4566'
if(@($configuredOrigins.Split(',')|ForEach-Object{$_.Trim()}) -notcontains $s3FrontendOrigin){$configuredOrigins="$configuredOrigins,$s3FrontendOrigin"}
$cloudFrontInfoPath=Join-Path $ProjectRoot 'dist\cloudfront-deployment.json'
if(Test-Path -LiteralPath $cloudFrontInfoPath){
  $cloudFrontOrigin=(Get-Content -LiteralPath $cloudFrontInfoPath -Raw|ConvertFrom-Json).url.TrimEnd('/')
  if($cloudFrontOrigin -and @($configuredOrigins.Split(',')|ForEach-Object{$_.Trim()}) -notcontains $cloudFrontOrigin){$configuredOrigins="$configuredOrigins,$cloudFrontOrigin"}
}
$rateLimitSecret=$envFile.SERVICE_INTERNAL_SECRET
if(-not $rateLimitSecret){try{$rateLimitSecret=(Invoke-Aws lambda get-function-configuration --function-name cml-vehicles|ConvertFrom-Json).Environment.Variables.RATE_LIMIT_KEY_SECRET}catch{}}
if(-not $rateLimitSecret){$bytes=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes);$rateLimitSecret=[Convert]::ToBase64String($bytes)}
$commonEnvironment = @{
  NODE_ENV='production';AWS_REGION=$Region;AWS_ENDPOINT_URL=$internalEndpoint;AWS_ACCESS_KEY_ID='test';AWS_SECRET_ACCESS_KEY='test';TABLE_PREFIX=$tablePrefix
  COGNITO_USER_POOL_ID=$envFile.COGNITO_USER_POOL_ID;COGNITO_APP_CLIENT_ID=$envFile.COGNITO_APP_CLIENT_ID;COGNITO_ISSUER=$envFile.COGNITO_ISSUER
  COGNITO_JWKS_URL="$internalEndpoint$jwksPath";REQUIRE_MFA=if($envFile.REQUIRE_MFA){$envFile.REQUIRE_MFA}else{'true'}
  CORS_ORIGINS=$configuredOrigins
  RATE_LIMIT_KEY_SECRET=$rateLimitSecret
  SES_FROM_EMAIL=if($envFile.SES_FROM_EMAIL){$envFile.SES_FROM_EMAIL}else{'no-reply@car-maintenance.local'}
  NOTIFICATION_QUEUE_URL=if($envFile.NOTIFICATION_QUEUE_URL){$envFile.NOTIFICATION_QUEUE_URL -replace '^http://localhost:4566',$internalEndpoint}else{''}
}

$functions = [ordered]@{vehicles='cml-vehicles';fuel='cml-fuel';reminders='cml-reminders'}
foreach ($service in $functions.Keys) {
  if($Services -notcontains $service){continue}
  $name = $functions[$service]
  $zip = Join-Path $dist "$service.zip"
  $environmentPath = Join-Path $dist "$service-environment.json"
  Write-JsonFile $environmentPath @{Variables=$commonEnvironment}
  $exists = $true
  try { Invoke-Aws lambda get-function --function-name $name | Out-Null } catch { $exists = $false }
  $serviceRoleName="motorlog-$service-runtime";$serviceRoleArn=$roleArn
  try{$serviceRoleArn=(Invoke-Aws iam get-role --role-name $serviceRoleName|ConvertFrom-Json).Role.Arn}catch{Write-Warning "$serviceRoleName is not deployed; using the legacy shared role. Run npm run iam:deploy."}
  if ($exists) {
    Invoke-Aws lambda update-function-code --function-name $name --zip-file "fileb://$zip" | Out-Null
    Invoke-Aws lambda update-function-configuration --function-name $name --runtime nodejs22.x --handler index.handler --role $serviceRoleArn --timeout 30 --memory-size 512 --environment "file://$environmentPath" | Out-Null
  } else {
    Invoke-Aws lambda create-function --function-name $name --runtime nodejs22.x --handler index.handler --role $serviceRoleArn --zip-file "fileb://$zip" --timeout 30 --memory-size 512 --environment "file://$environmentPath" | Out-Null
  }
  Write-Host "Deployed $name"
}

$infoPath=Get-DeploymentInfoPath
$info=if(Test-Path -LiteralPath $infoPath){Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json}else{[pscustomobject]@{}}
$info|Add-Member -Force NoteProperty region $Region;$info|Add-Member -Force NoteProperty endpoint $FlociUrl;$info|Add-Member -Force NoteProperty functions $functions;$info|Add-Member -Force NoteProperty deployedAt ((Get-Date).ToUniversalTime().ToString('o'))
Write-JsonFile (Get-DeploymentInfoPath) $info
Write-Host "Deployed selected Motorlog Lambda services: $($Services -join ', ')."

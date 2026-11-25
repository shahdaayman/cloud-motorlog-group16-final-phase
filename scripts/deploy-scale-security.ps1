. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$account='000000000000';$cluster='motorlog-cluster';$service='motorlog-backend-service';$taskFamily='motorlog-backend-task'
$executionRole='motorlog-ecs-task-execution-role';$taskRole='motorlog-ecs-task-role'
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'dist')|Out-Null
function Set-SecretValueFromFile([string]$secretId,[string]$secretValue,[bool]$create){
  $secretPath=Join-Path ([System.IO.Path]::GetTempPath()) "motorlog-secret-$([guid]::NewGuid().ToString('N')).txt"
  try{
    [System.IO.File]::WriteAllText($secretPath,$secretValue,(New-Object System.Text.UTF8Encoding($false)))
    $secretUri="file://$($secretPath -replace '\\','/')"
    if($create){return Invoke-Aws secretsmanager create-secret --name $secretId --secret-string $secretUri|ConvertFrom-Json}
    Invoke-Aws secretsmanager put-secret-value --secret-id $secretId --secret-string $secretUri|Out-Null
  }finally{if(Test-Path -LiteralPath $secretPath){Remove-Item -LiteralPath $secretPath -Force}}
}
function Ensure-AppConfigSecret {
  $secretId='motorlog-app/config';$defaultValue='{"environment":"local-floci","rateLimitMax":120,"rateLimitWindowMs":60000}'
  $exists=$true
  try{Invoke-Aws secretsmanager describe-secret --secret-id $secretId|Out-Null}catch{$exists=$false}
  if(-not $exists){Set-SecretValueFromFile $secretId $defaultValue $true|Out-Null;return}
  $existing=(Invoke-Aws secretsmanager get-secret-value --secret-id $secretId|ConvertFrom-Json).SecretString
  try{$null=$existing|ConvertFrom-Json -ErrorAction Stop}catch{Set-SecretValueFromFile $secretId $defaultValue $false}
}
function Ensure-RateLimitSecret {
  $secretId='motorlog-auth/rate-limit-key'
  try{return (Invoke-Aws secretsmanager describe-secret --secret-id $secretId|ConvertFrom-Json).ARN}catch{
    $bytes=New-Object byte[] 32
    $generator=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$generator.GetBytes($bytes)}finally{$generator.Dispose()}
    $created=Set-SecretValueFromFile $secretId ([Convert]::ToBase64String($bytes)) $true
    return $created.ARN
  }
}
Ensure-AppConfigSecret
$rateLimitSecretArn=Ensure-RateLimitSecret
$image=if($env:MOTORLOG_ECS_IMAGE){$env:MOTORLOG_ECS_IMAGE}else{'motorlog-backend:scale-security'}
& docker image inspect $image *> $null
if($LASTEXITCODE -ne 0){
  Write-Host "Building missing local ECS image $image..."
  & docker build --tag $image $ProjectRoot
  if($LASTEXITCODE -ne 0){throw "Docker image build failed for $image"}
}
function Ensure-Role([string]$name,[string]$policy){
  $trustUri="file://$($trustPath -replace '\\','/')";$policyUri="file://$($policy -replace '\\','/')"
  try{Invoke-Aws iam get-role --role-name $name|Out-Null}catch{Invoke-Aws iam create-role --role-name $name --assume-role-policy-document $trustUri|Out-Null}
  Invoke-Aws iam put-role-policy --role-name $name --policy-name "$name-policy" --policy-document $policyUri|Out-Null
}
$trustPath=Join-Path $ProjectRoot 'dist\ecs-trust.json';Write-JsonFile $trustPath @{Version='2012-10-17';Statement=@(@{Effect='Allow';Principal=@{Service='ecs-tasks.amazonaws.com'};Action='sts:AssumeRole'})}
$executionPolicy=Join-Path $ProjectRoot 'dist\ecs-execution-policy.json';Write-JsonFile $executionPolicy @{Version='2012-10-17';Statement=@(@{Effect='Allow';Action=@('logs:CreateLogStream','logs:PutLogEvents');Resource="arn:aws:logs:${Region}:${account}:log-group:/motorlog/ecs:*"},@{Effect='Allow';Action='secretsmanager:GetSecretValue';Resource=$rateLimitSecretArn})}
$taskPolicy=Join-Path $ProjectRoot 'dist\ecs-task-policy.json';Write-JsonFile $taskPolicy @{Version='2012-10-17';Statement=@(@{Effect='Allow';Action=@('events:PutEvents');Resource="arn:aws:events:${Region}:${account}:event-bus/motorlog-event-bus"},@{Effect='Allow';Action='sns:Publish';Resource="arn:aws:sns:${Region}:${account}:motorlog-notifications-topic"},@{Effect='Allow';Action='secretsmanager:GetSecretValue';Resource="arn:aws:secretsmanager:${Region}:${account}:secret:motorlog-app/config*"})}
Ensure-Role $executionRole $executionPolicy;Ensure-Role $taskRole $taskPolicy
try{Invoke-Aws logs create-log-group --log-group-name /motorlog/ecs|Out-Null}catch{}
$taskPath=Join-Path $ProjectRoot 'dist\ecs-task-definition.json';Write-JsonFile $taskPath @{family=$taskFamily;networkMode='awsvpc';requiresCompatibilities=@('FARGATE');cpu='256';memory='512';executionRoleArn="arn:aws:iam::${account}:role/${executionRole}";taskRoleArn="arn:aws:iam::${account}:role/${taskRole}";containerDefinitions=@(@{name='motorlog-backend';image=$image;essential=$true;portMappings=@(@{containerPort=3000;protocol='tcp'});environment=@(@{name='AWS_ENDPOINT_URL';value='http://floci:4566'},@{name='EVENT_BUS_NAME';value='motorlog-event-bus'},@{name='SNS_TOPIC_ARN';value="arn:aws:sns:${Region}:${account}:motorlog-notifications-topic"},@{name='APP_CONFIG_SECRET_NAME';value='motorlog-app/config'});secrets=@(@{name='RATE_LIMIT_KEY_SECRET';valueFrom=$rateLimitSecretArn});healthCheck=@{command=@('CMD-SHELL','wget -qO- http://127.0.0.1:3000/api/health || exit 1');interval=30;timeout=5;retries=3;startPeriod=10};logConfiguration=@{logDriver='awslogs';options=@{'awslogs-group'='/motorlog/ecs';'awslogs-region'=$Region;'awslogs-stream-prefix'='backend'}}})}
$task=(Invoke-Aws ecs register-task-definition --cli-input-json "file://$($taskPath -replace '\\','/')"|ConvertFrom-Json).taskDefinition
$vpc=@((Invoke-Aws ec2 describe-vpcs|ConvertFrom-Json).Vpcs|Where-Object{@($_.Tags|Where-Object{$_.Key -eq 'Name' -and $_.Value -eq 'motorlog-alb-vpc'}).Count})[0]
if(-not $vpc){throw 'The existing motorlog-alb-vpc is required. Run npm run alb:deploy first.'}
$subnets=@((Invoke-Aws ec2 describe-subnets|ConvertFrom-Json).Subnets|Where-Object VpcId -eq $vpc.VpcId|Select-Object -ExpandProperty SubnetId)
$securityGroup=@((Invoke-Aws ec2 describe-security-groups|ConvertFrom-Json).SecurityGroups|Where-Object{$_.VpcId -eq $vpc.VpcId -and $_.GroupName -eq 'motorlog-alb-sg'})[0]
if($subnets.Count -lt 2 -or -not $securityGroup){throw 'Existing ALB subnets/security group were not found.'}
$network="awsvpcConfiguration={subnets=[$($subnets -join ',')],securityGroups=[$($securityGroup.GroupId)],assignPublicIp=DISABLED}"
$targetGroup=@((Invoke-Aws elbv2 describe-target-groups --names motorlog-http-targets|ConvertFrom-Json).TargetGroups)[0]
$existing=@((Invoke-Aws ecs describe-services --cluster $cluster --services $service|ConvertFrom-Json).services)[0]
if($existing -and $existing.status -ne 'INACTIVE'){Invoke-Aws ecs update-service --cluster $cluster --service $service --task-definition $task.taskDefinitionArn --desired-count 1 --network-configuration $network|Out-Null}else{Invoke-Aws ecs create-service --cluster $cluster --service-name $service --task-definition $task.taskDefinitionArn --desired-count 1 --launch-type FARGATE --network-configuration $network --load-balancers "targetGroupArn=$($targetGroup.TargetGroupArn),containerName=motorlog-backend,containerPort=3000"|Out-Null}
Invoke-Aws application-autoscaling register-scalable-target --service-namespace ecs --resource-id "service/$cluster/$service" --scalable-dimension ecs:service:DesiredCount --min-capacity 1 --max-capacity 4|Out-Null
$scalingPath=Join-Path $ProjectRoot 'dist\ecs-scaling.json';Write-JsonFile $scalingPath @{TargetValue=50.0;PredefinedMetricSpecification=@{PredefinedMetricType='ECSServiceAverageCPUUtilization'};ScaleOutCooldown=60;ScaleInCooldown=60}
Invoke-Aws application-autoscaling put-scaling-policy --policy-name motorlog-cpu-target-tracking --service-namespace ecs --resource-id "service/$cluster/$service" --scalable-dimension ecs:service:DesiredCount --policy-type TargetTrackingScaling --target-tracking-scaling-policy-configuration "file://$($scalingPath -replace '\\','/')"|Out-Null
try{Invoke-Aws sns create-topic --name motorlog-notifications-topic|Out-Null}catch{}
try{Invoke-Aws events create-event-bus --name motorlog-event-bus|Out-Null}catch{}
$patternPath=Join-Path $ProjectRoot 'dist\audit-event-pattern.json';Write-JsonFile $patternPath @{source=@('motorlog.application');'detail-type'=@('VehicleCreated','MaintenanceAdded','ReminderCompleted')}
Invoke-Aws events put-rule --name motorlog-audit-rule --event-bus-name motorlog-event-bus --event-pattern "file://$($patternPath -replace '\\','/')" --state ENABLED|Out-Null
try{Invoke-Aws logs create-log-group --log-group-name /motorlog/events/audit|Out-Null}catch{}
$auditTrustPath=Join-Path $ProjectRoot 'dist\motorlog-audit-trust.json';Write-JsonFile $auditTrustPath @{Version='2012-10-17';Statement=@(@{Effect='Allow';Principal=@{Service='lambda.amazonaws.com'};Action='sts:AssumeRole'})}
$auditPolicyPath=Join-Path $ProjectRoot 'dist\motorlog-audit-policy.json';Write-JsonFile $auditPolicyPath @{Version='2012-10-17';Statement=@(@{Effect='Allow';Action=@('logs:CreateLogStream','logs:PutLogEvents');Resource="arn:aws:logs:${Region}:${account}:log-group:/motorlog/events/audit:*"})}
$auditRoleName='motorlog-audit-runtime';$auditRole=$null
try{$auditRole=Invoke-Aws iam get-role --role-name $auditRoleName|ConvertFrom-Json}catch{$auditRole=Invoke-Aws iam create-role --role-name $auditRoleName --assume-role-policy-document "file://$($auditTrustPath -replace '\\','/')"|ConvertFrom-Json}
Invoke-Aws iam put-role-policy --role-name $auditRoleName --policy-name motorlog-audit-least-privilege --policy-document "file://$($auditPolicyPath -replace '\\','/')"|Out-Null
Push-Location $ProjectRoot
try{& node scripts/build-audit-logger.js;if($LASTEXITCODE -ne 0){throw 'Audit Lambda packaging failed'}}finally{Pop-Location}
$auditFunction='motorlog-audit-logger';$auditZip=Join-Path $ProjectRoot 'dist\motorlog-audit-logger.zip';$auditEnvironment=Join-Path $ProjectRoot 'dist\motorlog-audit-environment.json'
Write-JsonFile $auditEnvironment @{Variables=@{AWS_ENDPOINT_URL='http://floci:4566';AUDIT_LOG_GROUP='/motorlog/events/audit';AUDIT_LOG_STREAM='motorlog-eventbridge-audit'}}
$auditExists=$true;try{Invoke-Aws lambda get-function --function-name $auditFunction|Out-Null}catch{$auditExists=$false}
if($auditExists){
  Invoke-Aws lambda update-function-code --function-name $auditFunction --zip-file "fileb://$($auditZip -replace '\\','/')"|Out-Null
  Invoke-Aws lambda update-function-configuration --function-name $auditFunction --runtime nodejs22.x --handler index.handler --role $auditRole.Role.Arn --timeout 15 --memory-size 256 --environment "file://$($auditEnvironment -replace '\\','/')"|Out-Null
}else{
  Invoke-Aws lambda create-function --function-name $auditFunction --runtime nodejs22.x --handler index.handler --role $auditRole.Role.Arn --zip-file "fileb://$($auditZip -replace '\\','/')" --timeout 15 --memory-size 256 --environment "file://$($auditEnvironment -replace '\\','/')"|Out-Null
}
$ruleArn="arn:aws:events:${Region}:${account}:rule/motorlog-event-bus/motorlog-audit-rule";$functionArn="arn:aws:lambda:${Region}:${account}:function:$auditFunction"
$permissionExists=$false
try{$lambdaPolicy=((Invoke-Aws lambda get-policy --function-name $auditFunction|ConvertFrom-Json).Policy|ConvertFrom-Json);$permissionExists=@($lambdaPolicy.Statement|Where-Object Sid -eq 'motorlog-eventbridge-audit-invoke').Count -gt 0}catch{}
if(-not $permissionExists){Invoke-Aws lambda add-permission --function-name $auditFunction --statement-id motorlog-eventbridge-audit-invoke --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn $ruleArn|Out-Null}
$targets=@((Invoke-Aws events list-targets-by-rule --event-bus-name motorlog-event-bus --rule motorlog-audit-rule|ConvertFrom-Json).Targets)
if(@($targets|Where-Object Id -eq 'motorlog-audit-logs').Count){Invoke-Aws events remove-targets --event-bus-name motorlog-event-bus --rule motorlog-audit-rule --ids motorlog-audit-logs|Out-Null}
Invoke-Aws events put-targets --event-bus-name motorlog-event-bus --rule motorlog-audit-rule --targets "Id=motorlog-audit-lambda,Arn=$functionArn"|Out-Null
Write-Host 'Scaling and security resources configured. Floci may record the ECS service without launching tasks; verify runningCount before claiming execution.'

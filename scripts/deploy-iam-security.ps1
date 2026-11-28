param([switch]$SkipFunctionUpdate)
. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$dist=Join-Path $ProjectRoot 'dist\iam';New-Item -ItemType Directory -Force -Path $dist|Out-Null
$account='000000000000';$prefix=(Get-DotEnv).TABLE_PREFIX;if(-not $prefix){$prefix='CML'}
$trust=Join-Path $dist 'lambda-trust.json';Write-JsonFile $trust @{Version='2012-10-17';Statement=@(@{Effect='Allow';Principal=@{Service='lambda.amazonaws.com'};Action='sts:AssumeRole'})}
$logs=@{Effect='Allow';Action=@('logs:CreateLogGroup','logs:CreateLogStream','logs:PutLogEvents');Resource="arn:aws:logs:$Region`:$account`:log-group:/aws/lambda/cml-*:*"}
$metrics=@{Effect='Allow';Action='cloudwatch:PutMetricData';Resource='*';Condition=@{StringEquals=@{'cloudwatch:namespace'='Motorlog/Application'}}}
function Table-Arns([string[]]$names){@($names|ForEach-Object{"arn:aws:dynamodb:$Region`:$account`:table/$prefix$_";"arn:aws:dynamodb:$Region`:$account`:table/$prefix$_/index/*"})}
function Put-Role($roleName,$policyName,$statements){
  $path=Join-Path $dist "$roleName.json";Write-JsonFile $path @{Version='2012-10-17';Statement=$statements}
  $check=Invoke-AwsExistenceCheck -Arguments @('iam','get-role','--role-name',$roleName) -NotFoundErrorCodes @('NoSuchEntity')
  if($check.Exists){Write-Host "[EXISTS] IAM role $roleName"}else{Write-Host "[INFO] IAM role $roleName not found; creating...";Write-Host "[CREATE] IAM role $roleName";Invoke-Aws iam create-role --role-name $roleName --assume-role-policy-document "file://$trust"|Out-Null;Write-Host "[OK] IAM role $roleName created"}
  Invoke-Aws iam update-assume-role-policy --role-name $roleName --policy-document "file://$trust"|Out-Null
  Invoke-Aws iam put-role-policy --role-name $roleName --policy-name $policyName --policy-document "file://$path"|Out-Null
  (Invoke-Aws iam get-role --role-name $roleName|ConvertFrom-Json).Role.Arn
}
$ddbAll=@{Effect='Allow';Action=@('dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:BatchWriteItem','dynamodb:Query','dynamodb:Scan','dynamodb:DescribeTable');Resource=(Table-Arns @('Users','Vehicles','Maintenance','Fuel','Expenses','Reminders','Audit'))}
$healthReads=@{Effect='Allow';Action=@('s3:ListBucket','apigateway:GET','lambda:GetFunction','iam:GetRole','cloudwatch:DescribeAlarms','scheduler:GetSchedule','cloudfront:ListDistributions','elasticloadbalancing:DescribeLoadBalancers');Resource='*'}
$vehicles=Put-Role 'motorlog-vehicles-runtime' 'motorlog-vehicles-least-privilege' @($logs,$metrics,$ddbAll,$healthReads,@{Effect='Allow';Action=@('cognito-idp:SignUp','cognito-idp:ConfirmSignUp','cognito-idp:ResendConfirmationCode','cognito-idp:InitiateAuth','cognito-idp:RespondToAuthChallenge','cognito-idp:ForgotPassword','cognito-idp:ConfirmForgotPassword','cognito-idp:GlobalSignOut','cognito-idp:GetUser','cognito-idp:ListUsers','cognito-idp:ListUsersInGroup','cognito-idp:AdminListGroupsForUser','cognito-idp:AdminEnableUser','cognito-idp:AdminDisableUser','cognito-idp:AdminAddUserToGroup','cognito-idp:AdminRemoveUserFromGroup','cognito-idp:AdminDeleteUser','cognito-idp:DescribeUserPool');Resource='*'},@{Effect='Allow';Action='sqs:GetQueueAttributes';Resource="arn:aws:sqs:$Region`:$account`:cml-reminder-notifications"},@{Effect='Allow';Action='ses:GetAccount';Resource='*'})
$fuel=Put-Role 'motorlog-fuel-runtime' 'motorlog-fuel-least-privilege' @($logs,$metrics,@{Effect='Allow';Action=@('dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query');Resource=(Table-Arns @('Users','Vehicles','Fuel','Expenses','Maintenance'))},@{Effect='Allow';Action='cognito-idp:GetUser';Resource='*'})
$reminders=Put-Role 'motorlog-reminders-runtime' 'motorlog-reminders-least-privilege' @($logs,$metrics,@{Effect='Allow';Action=@('dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query');Resource=(Table-Arns @('Users','Vehicles','Fuel','Expenses','Maintenance','Reminders'))},@{Effect='Allow';Action=@('sqs:SendMessage','sqs:ReceiveMessage','sqs:DeleteMessage','sqs:GetQueueAttributes','sqs:ChangeMessageVisibility');Resource="arn:aws:sqs:$Region`:$account`:cml-reminder-notifications"},@{Effect='Allow';Action='ses:SendEmail';Resource='*'},@{Effect='Allow';Action='cognito-idp:GetUser';Resource='*'})
if(-not $SkipFunctionUpdate){
  @{'cml-vehicles'=$vehicles;'cml-fuel'=$fuel;'cml-reminders'=$reminders}.GetEnumerator()|ForEach-Object{
    $functionCheck=Invoke-AwsExistenceCheck -Arguments @('lambda','get-function-configuration','--function-name',$_.Key) -NotFoundErrorCodes @('ResourceNotFoundException')
    if(-not $functionCheck.Exists){throw "Lambda $($_.Key) was not found. Run npm run lambda:deploy before npm run iam:deploy."}
    $configuration=$functionCheck.Output|ConvertFrom-Json
    if($configuration.Role -eq $_.Value){Write-Host "[EXISTS] Lambda $($_.Key) already uses $($_.Value)"}else{Write-Host "[UPDATE] Lambda $($_.Key) execution role";Invoke-Aws lambda update-function-configuration --function-name $_.Key --role $_.Value|Out-Null;$configuration=Wait-MotorlogLambdaActive -FunctionName $_.Key}
    if($configuration.State -ne 'Active' -or $configuration.Role -ne $_.Value){throw "Lambda $($_.Key) role/state verification failed."}
    Write-Host "[OK] Lambda $($_.Key) is Active with the correct execution role"
  }
}
Write-Host 'Dedicated least-privilege Lambda roles deployed. Scheduler role and schedule state were not changed.'

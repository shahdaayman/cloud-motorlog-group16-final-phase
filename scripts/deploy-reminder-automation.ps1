. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$dist=Join-Path $ProjectRoot 'dist';New-Item -ItemType Directory -Force -Path $dist|Out-Null
function Write-Status([string]$Status,[string]$Message){Write-Host (("[$Status]").PadRight(10)+$Message)}
function Ensure-Queue([string]$Name){
  Write-Status INFO "Checking SQS queue $Name..."
  $check=Invoke-AwsExistenceCheck -Arguments @('sqs','get-queue-url','--queue-name',$Name) -NotFoundErrorCodes @('AWS.SimpleQueueService.NonExistentQueue','QueueDoesNotExist')
  if($check.Exists){$url=($check.Output|ConvertFrom-Json).QueueUrl;Write-Status EXISTS "SQS queue $Name"}else{Write-Status CREATE "SQS queue $Name";$url=(Invoke-Aws sqs create-queue --queue-name $Name|ConvertFrom-Json).QueueUrl}
  if(-not $url){throw "SQS queue $Name did not return a queue URL."}
  $attributes=Invoke-Aws sqs get-queue-attributes --queue-url $url --attribute-names QueueArn|ConvertFrom-Json;$arn=$attributes.Attributes.QueueArn
  if(-not $arn -or $arn -notmatch ":$([regex]::Escape($Name))$"){throw "SQS queue $Name ARN verification failed."}
  Write-Status OK "SQS queue $Name verified";[pscustomobject]@{Name=$Name;Url=$url;Arn=$arn}
}
function Ensure-Role([string]$Name,[string]$TrustPath){
  $check=Invoke-AwsExistenceCheck -Arguments @('iam','get-role','--role-name',$Name) -NotFoundErrorCodes @('NoSuchEntity')
  if($check.Exists){Write-Status EXISTS "IAM role $Name";return ($check.Output|ConvertFrom-Json)}
  Write-Status CREATE "IAM role $Name";Invoke-Aws iam create-role --role-name $Name --assume-role-policy-document "file://$TrustPath"|ConvertFrom-Json
}

Write-Host "`n===============================================`n       MOTORLOG REMINDER AUTOMATION`n===============================================`n"
$queue=Ensure-Queue 'cml-reminder-notifications';$dlq=Ensure-Queue 'cml-reminder-notifications-dlq';Write-Status OK 'Floci SQS service reachable'
$queueAttributes=Join-Path $dist 'reminder-queue-attributes.json';Write-JsonFile $queueAttributes @{RedrivePolicy=(ConvertTo-Json @{deadLetterTargetArn=$dlq.Arn;maxReceiveCount='3'} -Compress)}
Invoke-Aws sqs set-queue-attributes --queue-url $queue.Url --attributes "file://$queueAttributes"|Out-Null
$redrive=(Invoke-Aws sqs get-queue-attributes --queue-url $queue.Url --attribute-names RedrivePolicy|ConvertFrom-Json).Attributes.RedrivePolicy|ConvertFrom-Json
if($redrive.deadLetterTargetArn -ne $dlq.Arn -or [int]$redrive.maxReceiveCount -ne 3){throw 'SQS dead-letter policy verification failed.'};Write-Status OK 'SQS dead-letter policy configured'

$functionCheck=Invoke-AwsExistenceCheck -Arguments @('lambda','get-function-configuration','--function-name','cml-reminders') -NotFoundErrorCodes @('ResourceNotFoundException')
if(-not $functionCheck.Exists){throw 'Lambda cml-reminders was not found. Run scripts/deploy-lambdas.ps1 first.'};$function=$functionCheck.Output|ConvertFrom-Json;Write-Status EXISTS 'Lambda cml-reminders'
$internalQueueUrl=$queue.Url -replace '^http://(?:localhost|127\.0\.0\.1):4566','http://floci:4566';$environment=[ordered]@{}
if($function.Environment.Variables){foreach($property in $function.Environment.Variables.psobject.Properties){$environment[$property.Name]=[string]$property.Value}}
if($environment.NOTIFICATION_QUEUE_URL -ne $internalQueueUrl){$environment.NOTIFICATION_QUEUE_URL=$internalQueueUrl;$environmentPath=Join-Path $dist 'reminders-environment.json';Write-JsonFile $environmentPath @{Variables=$environment};Write-Status UPDATE 'Reminder Lambda notification queue configuration';Invoke-Aws lambda update-function-configuration --function-name cml-reminders --environment "file://$environmentPath"|Out-Null;$function=Wait-MotorlogLambdaActive -FunctionName 'cml-reminders'}
if($function.Environment.Variables.NOTIFICATION_QUEUE_URL -ne $internalQueueUrl){throw 'Reminder Lambda notification queue URL verification failed.'}
$runtimeRole='motorlog-reminders-runtime';$runtimeTrust=Join-Path $dist 'reminders-runtime-trust.json';$runtimePolicy=Join-Path $dist 'reminders-runtime-policy.json'
Write-JsonFile $runtimeTrust @{Version='2012-10-17';Statement=@(@{Effect='Allow';Principal=@{Service='lambda.amazonaws.com'};Action='sts:AssumeRole'})}
$prefix=(Get-DotEnv).TABLE_PREFIX;if(-not $prefix){$prefix='CML'}
Write-JsonFile $runtimePolicy @{Version='2012-10-17';Statement=@(
  @{Effect='Allow';Action=@('logs:CreateLogGroup','logs:CreateLogStream','logs:PutLogEvents');Resource='*'},
  @{Effect='Allow';Action=@('dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query');Resource=@("arn:aws:dynamodb:$Region`:000000000000:table/$($prefix)Users","arn:aws:dynamodb:$Region`:000000000000:table/$($prefix)Reminders","arn:aws:dynamodb:$Region`:000000000000:table/$($prefix)Reminders/index/*","arn:aws:dynamodb:$Region`:000000000000:table/$($prefix)Vehicles")},
  @{Effect='Allow';Action=@('sqs:SendMessage','sqs:ReceiveMessage','sqs:DeleteMessage','sqs:ChangeMessageVisibility','sqs:GetQueueAttributes');Resource=@($queue.Arn,$dlq.Arn)},@{Effect='Allow';Action='ses:SendEmail';Resource='*'},@{Effect='Allow';Action='cognito-idp:GetUser';Resource='*'}
)}
$runtime=Ensure-Role $runtimeRole $runtimeTrust;Invoke-Aws iam put-role-policy --role-name $runtimeRole --policy-name reminders-runtime --policy-document "file://$runtimePolicy"|Out-Null;Invoke-Aws iam get-role-policy --role-name $runtimeRole --policy-name reminders-runtime|Out-Null
if($function.Role -ne $runtime.Role.Arn){Write-Status UPDATE 'Lambda cml-reminders runtime role';Invoke-Aws lambda update-function-configuration --function-name cml-reminders --role $runtime.Role.Arn|Out-Null;$function=Wait-MotorlogLambdaActive -FunctionName 'cml-reminders'}
if($function.Role -ne $runtime.Role.Arn){throw 'Lambda cml-reminders runtime role verification failed.'};Write-Status OK 'Lambda runtime permissions configured'

$schedulerRole='motorlog-scheduler-reminders';$trust=Join-Path $dist 'scheduler-trust.json';$policy=Join-Path $dist 'scheduler-policy.json'
Write-JsonFile $trust @{Version='2012-10-17';Statement=@(@{Effect='Allow';Principal=@{Service='scheduler.amazonaws.com'};Action='sts:AssumeRole'})};Write-JsonFile $policy @{Version='2012-10-17';Statement=@(@{Effect='Allow';Action='lambda:InvokeFunction';Resource=$function.FunctionArn})}
$role=Ensure-Role $schedulerRole $trust;Invoke-Aws iam put-role-policy --role-name $schedulerRole --policy-name invoke-cml-reminders --policy-document "file://$policy"|Out-Null;Invoke-Aws iam get-role-policy --role-name $schedulerRole --policy-name invoke-cml-reminders|Out-Null;Write-Status OK 'Scheduler IAM permissions configured'

$groupCheck=Invoke-AwsExistenceCheck -Arguments @('scheduler','get-schedule-group','--name','motorlog') -NotFoundErrorCodes @('ResourceNotFoundException')
if($groupCheck.Exists){Write-Status EXISTS 'Scheduler group motorlog'}else{Write-Status CREATE 'Scheduler group motorlog';Invoke-Aws scheduler create-schedule-group --name motorlog|Out-Null}
$group=Invoke-Aws scheduler get-schedule-group --name motorlog|ConvertFrom-Json;if($group.Name -ne 'motorlog'){throw 'Scheduler group verification failed.'}
$target=Join-Path $dist 'scheduler-target.json';$window=Join-Path $dist 'scheduler-window.json';$input='{"source":"aws.scheduler","job":"check-reminders"}'
Write-JsonFile $target @{Arn=$function.FunctionArn;RoleArn=$role.Role.Arn;Input=$input};Write-JsonFile $window @{Mode='OFF'}
$scheduleCheck=Invoke-AwsExistenceCheck -Arguments @('scheduler','get-schedule','--group-name','motorlog','--name','motorlog-daily-reminder-check') -NotFoundErrorCodes @('ResourceNotFoundException')
if($scheduleCheck.Exists){$current=$scheduleCheck.Output|ConvertFrom-Json;$needsUpdate=$current.State -ne 'ENABLED' -or $current.ScheduleExpression -ne 'cron(0 9 * * ? *)' -or $current.ScheduleExpressionTimezone -ne 'Africa/Cairo' -or $current.Target.Arn -ne $function.FunctionArn -or $current.Target.RoleArn -ne $role.Role.Arn -or $current.Target.Input -ne $input;if($needsUpdate){Write-Status UPDATE 'Reminder schedule';Invoke-Aws scheduler update-schedule --group-name motorlog --name motorlog-daily-reminder-check --schedule-expression 'cron(0 9 * * ? *)' --schedule-expression-timezone Africa/Cairo --flexible-time-window "file://$window" --target "file://$target" --state ENABLED|Out-Null}else{Write-Status EXISTS 'Reminder schedule motorlog-daily-reminder-check'}}else{Write-Status CREATE 'Reminder schedule motorlog-daily-reminder-check';Invoke-Aws scheduler create-schedule --group-name motorlog --name motorlog-daily-reminder-check --schedule-expression 'cron(0 9 * * ? *)' --schedule-expression-timezone Africa/Cairo --flexible-time-window "file://$window" --target "file://$target" --state ENABLED|Out-Null}
$schedule=Invoke-Aws scheduler get-schedule --group-name motorlog --name motorlog-daily-reminder-check|ConvertFrom-Json
if($schedule.State -ne 'ENABLED' -or $schedule.Target.Arn -ne $function.FunctionArn -or $schedule.Target.RoleArn -ne $role.Role.Arn -or $schedule.ScheduleExpression -ne 'cron(0 9 * * ? *)'){throw 'Reminder schedule verification failed.'};Write-Status OK 'Reminder automation: ENABLED';Write-Status OK 'EventBridge Scheduler configured'

$mappings=Invoke-Aws lambda list-event-source-mappings --function-name cml-reminders --event-source-arn $queue.Arn|ConvertFrom-Json;$mapping=@($mappings.EventSourceMappings|Select-Object -First 1)
if(-not $mapping.Count){Write-Status CREATE 'SQS Lambda event-source mapping';Invoke-Aws lambda create-event-source-mapping --function-name cml-reminders --event-source-arn $queue.Arn --batch-size 1 --function-response-types ReportBatchItemFailures --enabled|Out-Null}elseif($mapping[0].BatchSize -ne 1 -or $mapping[0].State -ne 'Enabled' -or @($mapping[0].FunctionResponseTypes) -notcontains 'ReportBatchItemFailures'){Write-Status UPDATE 'SQS Lambda event-source mapping';Invoke-Aws lambda update-event-source-mapping --uuid $mapping[0].UUID --batch-size 1 --function-response-types ReportBatchItemFailures --enabled|Out-Null}else{Write-Status EXISTS 'SQS Lambda event-source mapping'}
$verifiedMappings=Invoke-Aws lambda list-event-source-mappings --function-name cml-reminders --event-source-arn $queue.Arn|ConvertFrom-Json;$verified=@($verifiedMappings.EventSourceMappings|Where-Object{$_.EventSourceArn -eq $queue.Arn -and $_.State -eq 'Enabled'})
if($verified.Count -ne 1){throw 'SQS Lambda event-source mapping verification failed.'};Write-Status OK 'SQS notification queue connected';Write-Status OK 'Reminder Lambda configured'
$sender=[string]$function.Environment.Variables.SES_FROM_EMAIL;if(-not $sender){throw 'Reminder Lambda SES_FROM_EMAIL is not configured.'};$identity=Invoke-Aws sesv2 get-email-identity --email-identity $sender|ConvertFrom-Json;if($null -eq $identity){throw 'SES email identity verification failed.'};Write-Status OK 'SES email delivery configured';Write-Status OK 'Reminder automation verified'
Write-Host "`n-----------------------------------------------`nReminder automation deployment: SUCCESS`n-----------------------------------------------"

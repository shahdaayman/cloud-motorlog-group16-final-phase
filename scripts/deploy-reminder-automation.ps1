. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$dist=Join-Path $ProjectRoot 'dist';New-Item -ItemType Directory -Force -Path $dist | Out-Null
$queueUrl=(Invoke-Aws sqs get-queue-url --queue-name cml-reminder-notifications | ConvertFrom-Json).QueueUrl
$queueArn=(Invoke-Aws sqs get-queue-attributes --queue-url $queueUrl --attribute-names QueueArn | ConvertFrom-Json).Attributes.QueueArn
$dlqUrl=$null;try{$dlqUrl=(Invoke-Aws sqs get-queue-url --queue-name cml-reminder-notifications-dlq|ConvertFrom-Json).QueueUrl}catch{$dlqUrl=(Invoke-Aws sqs create-queue --queue-name cml-reminder-notifications-dlq|ConvertFrom-Json).QueueUrl}
$dlqArn=(Invoke-Aws sqs get-queue-attributes --queue-url $dlqUrl --attribute-names QueueArn|ConvertFrom-Json).Attributes.QueueArn
$queueAttributes=Join-Path $dist 'reminder-queue-attributes.json';Write-JsonFile $queueAttributes @{RedrivePolicy=(ConvertTo-Json @{deadLetterTargetArn=$dlqArn;maxReceiveCount='3'} -Compress)}
Invoke-Aws sqs set-queue-attributes --queue-url $queueUrl --attributes "file://$queueAttributes"|Out-Null
$function=(Invoke-Aws lambda get-function-configuration --function-name cml-reminders | ConvertFrom-Json)
$runtimeRole='motorlog-reminders-runtime';$runtimeTrust=Join-Path $dist 'reminders-runtime-trust.json';$runtimePolicy=Join-Path $dist 'reminders-runtime-policy.json'
Write-JsonFile $runtimeTrust @{Version='2012-10-17';Statement=@(@{Effect='Allow';Principal=@{Service='lambda.amazonaws.com'};Action='sts:AssumeRole'})}
$prefix=(Get-DotEnv).TABLE_PREFIX;if(-not $prefix){$prefix='CML'}
Write-JsonFile $runtimePolicy @{Version='2012-10-17';Statement=@(
  @{Effect='Allow';Action=@('logs:CreateLogGroup','logs:CreateLogStream','logs:PutLogEvents');Resource='*'},
  @{Effect='Allow';Action=@('dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query');Resource=@("arn:aws:dynamodb:$Region`:000000000000:table/$($prefix)Users","arn:aws:dynamodb:$Region`:000000000000:table/$($prefix)Reminders","arn:aws:dynamodb:$Region`:000000000000:table/$($prefix)Reminders/index/*","arn:aws:dynamodb:$Region`:000000000000:table/$($prefix)Vehicles")},
  @{Effect='Allow';Action=@('sqs:SendMessage','sqs:ReceiveMessage','sqs:DeleteMessage','sqs:ChangeMessageVisibility','sqs:GetQueueAttributes');Resource=@($queueArn,$dlqArn)},
  @{Effect='Allow';Action=@('ses:SendEmail');Resource='*'}
)}
try{$runtime=(Invoke-Aws iam get-role --role-name $runtimeRole|ConvertFrom-Json)}catch{$runtime=(Invoke-Aws iam create-role --role-name $runtimeRole --assume-role-policy-document "file://$runtimeTrust"|ConvertFrom-Json)}
Invoke-Aws iam put-role-policy --role-name $runtimeRole --policy-name reminders-runtime --policy-document "file://$runtimePolicy"|Out-Null
if($function.Role -ne $runtime.Role.Arn){Invoke-Aws lambda update-function-configuration --function-name cml-reminders --role $runtime.Role.Arn|Out-Null;$function=(Invoke-Aws lambda get-function-configuration --function-name cml-reminders|ConvertFrom-Json)}

$schedulerRole='motorlog-scheduler-reminders'
$trust=Join-Path $dist 'scheduler-trust.json';$policy=Join-Path $dist 'scheduler-policy.json'
Write-JsonFile $trust @{Version='2012-10-17';Statement=@(@{Effect='Allow';Principal=@{Service='scheduler.amazonaws.com'};Action='sts:AssumeRole'})}
Write-JsonFile $policy @{Version='2012-10-17';Statement=@(@{Effect='Allow';Action='lambda:InvokeFunction';Resource=$function.FunctionArn})}
try{$role=(Invoke-Aws iam get-role --role-name $schedulerRole|ConvertFrom-Json)}catch{$role=(Invoke-Aws iam create-role --role-name $schedulerRole --assume-role-policy-document "file://$trust"|ConvertFrom-Json)}
Invoke-Aws iam put-role-policy --role-name $schedulerRole --policy-name invoke-cml-reminders --policy-document "file://$policy"|Out-Null
try{Invoke-Aws scheduler get-schedule-group --name motorlog|Out-Null}catch{Invoke-Aws scheduler create-schedule-group --name motorlog|Out-Null}
$target=Join-Path $dist 'scheduler-target.json';$window=Join-Path $dist 'scheduler-window.json'
Write-JsonFile $target @{Arn=$function.FunctionArn;RoleArn=$role.Role.Arn;Input='{"source":"aws.scheduler","job":"check-reminders"}'}
Write-JsonFile $window @{Mode='OFF'}
$exists=$true;try{Invoke-Aws scheduler get-schedule --group-name motorlog --name motorlog-daily-reminder-check|Out-Null}catch{$exists=$false}
if($exists){Invoke-Aws scheduler update-schedule --group-name motorlog --name motorlog-daily-reminder-check --schedule-expression 'cron(0 9 * * ? *)' --schedule-expression-timezone Africa/Cairo --flexible-time-window "file://$window" --target "file://$target" --state DISABLED|Out-Null}else{Invoke-Aws scheduler create-schedule --group-name motorlog --name motorlog-daily-reminder-check --schedule-expression 'cron(0 9 * * ? *)' --schedule-expression-timezone Africa/Cairo --flexible-time-window "file://$window" --target "file://$target" --state DISABLED|Out-Null}

$mappings=Invoke-Aws lambda list-event-source-mappings --function-name cml-reminders --event-source-arn $queueArn|ConvertFrom-Json
if(-not $mappings.EventSourceMappings){Invoke-Aws lambda create-event-source-mapping --function-name cml-reminders --event-source-arn $queueArn --batch-size 1 --function-response-types ReportBatchItemFailures --enabled|Out-Null}else{$uuid=$mappings.EventSourceMappings[0].UUID;Invoke-Aws lambda update-event-source-mapping --uuid $uuid --batch-size 1 --function-response-types ReportBatchItemFailures --enabled|Out-Null}
Write-Host 'Reminder automation and dead-letter handling deployed. Daily schedule remains DISABLED pending controlled email verification.'

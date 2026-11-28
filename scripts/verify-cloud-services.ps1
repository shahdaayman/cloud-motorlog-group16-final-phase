. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$results=@();function Check([string]$name,[scriptblock]$test){try{& $test|Out-Null;$script:results+=@([pscustomobject]@{Service=$name;Result='PASS';Detail='API check succeeded'})}catch{$script:results+=@([pscustomobject]@{Service=$name;Result=if($_.Exception.Message -match 'not supported|UnknownOperation|not implemented'){'NOT SUPPORTED'}else{'FAIL'};Detail=$_.Exception.Message})}}
Check S3 {Invoke-Aws s3api list-buckets}
Check ELBv2 {Invoke-Aws elbv2 describe-load-balancers --names motorlog-alb}
Check ECS {
  $services=@((Invoke-Aws ecs describe-services --cluster motorlog-cluster --services motorlog-backend-service|ConvertFrom-Json).services|Where-Object{$_.serviceName -eq 'motorlog-backend-service'})
  if($services.Count -ne 1 -or $services[0].status -ne 'ACTIVE' -or $services[0].desiredCount -ne 1){throw 'Motorlog ECS service is not configured as ACTIVE with desired count one'}
  Write-Host "PASS ECS configuration; running tasks $($services[0].runningCount)/$($services[0].desiredCount)."
}
Check AutoScaling {
  $resourceId='service/motorlog-cluster/motorlog-backend-service'
  $targets=@((Invoke-Aws application-autoscaling describe-scalable-targets --service-namespace ecs --resource-ids $resourceId|ConvertFrom-Json).ScalableTargets)
  if($targets.Count -ne 1 -or $targets[0].MinCapacity -ne 1 -or $targets[0].MaxCapacity -ne 4){throw 'ECS scalable target must use min one and max four'}
  $policies=@((Invoke-Aws application-autoscaling describe-scaling-policies --service-namespace ecs --resource-id $resourceId|ConvertFrom-Json).ScalingPolicies)
  if($policies.Count -ne 1 -or $policies[0].TargetTrackingScalingPolicyConfiguration.TargetValue -ne 50){throw 'ECS CPU target tracking must be exactly fifty percent'}
}
Check DynamoDB {Invoke-Aws dynamodb list-tables}
Check SQS {Invoke-Aws sqs list-queues}
Check SNS {Invoke-Aws sns list-topics}
Check EventBridge {Invoke-Aws events describe-event-bus --name motorlog-event-bus}
Check EventBridgeAuditPipeline {
  $account='000000000000';$functionName='motorlog-audit-logger';$ruleName='motorlog-audit-rule';$busName='motorlog-event-bus'
  $role=(Invoke-Aws iam get-role --role-name motorlog-audit-runtime|ConvertFrom-Json).Role
  $inline=(Invoke-Aws iam list-role-policies --role-name motorlog-audit-runtime|ConvertFrom-Json).PolicyNames
  if($inline -notcontains 'motorlog-audit-least-privilege'){throw 'Audit least-privilege policy is missing'}
  $configuration=Invoke-Aws lambda get-function-configuration --function-name $functionName|ConvertFrom-Json
  if($configuration.Runtime -ne 'nodejs22.x' -or $configuration.Handler -ne 'index.handler' -or $configuration.Role -ne $role.Arn){throw 'Audit Lambda configuration does not match the required runtime, handler, and role'}
  if($configuration.Environment.Variables.AWS_ENDPOINT_URL -ne 'http://floci:4566'){throw 'Audit Lambda does not use the Floci internal endpoint'}
  $targets=@((Invoke-Aws events list-targets-by-rule --event-bus-name $busName --rule $ruleName|ConvertFrom-Json).Targets)
  if(@($targets|Where-Object Id -eq 'motorlog-audit-logs').Count){throw 'Unsupported direct CloudWatch Logs target is still configured'}
  $lambdaTarget=@($targets|Where-Object Id -eq 'motorlog-audit-lambda')
  if($lambdaTarget.Count -ne 1 -or $lambdaTarget[0].Arn -ne "arn:aws:lambda:${Region}:${account}:function:$functionName"){throw 'Audit Lambda is not the sole required EventBridge target'}
  $resourcePolicy=((Invoke-Aws lambda get-policy --function-name $functionName|ConvertFrom-Json).Policy|ConvertFrom-Json)
  if(-not @($resourcePolicy.Statement|Where-Object{$_.Sid -eq 'motorlog-eventbridge-audit-invoke' -and $_.Principal.Service -eq 'events.amazonaws.com'}).Count){throw 'EventBridge invocation permission is missing'}
  $verificationId="motorlog-audit-verification-$([guid]::NewGuid().ToString('N'))";$eventPath=Join-Path $ProjectRoot 'dist\audit-verification-event.json'
  try{
    $startedAtMs=[long](((Get-Date).ToUniversalTime()-[datetime]'1970-01-01T00:00:00Z').TotalMilliseconds)
    Write-JsonFile $eventPath @{Entries=@(@{Source='motorlog.application';DetailType='VehicleCreated';Detail=(@{vehicleId=$verificationId}|ConvertTo-Json -Compress);EventBusName=$busName})}
    $put=Invoke-Aws events put-events --cli-input-json "file://$($eventPath -replace '\\','/')"|ConvertFrom-Json
    if($put.FailedEntryCount -ne 0 -or -not $put.Entries[0].EventId){throw 'EventBridge rejected the synthetic audit event'}
    $eventId=$put.Entries[0].EventId;$delivered=$false
    for($attempt=0;$attempt -lt 30 -and -not $delivered;$attempt++){
      # Floci 2.5.0 does not reliably match hyphenated IDs with filter-pattern.
      # Bound the server query by test start time, then match the exact ID locally.
      $events=@((Invoke-Aws logs filter-log-events --log-group-name /motorlog/events/audit --log-stream-names motorlog-eventbridge-audit --start-time $startedAtMs|ConvertFrom-Json).events)
      $delivered=@($events|Where-Object{$_.message -like "*$eventId*"}).Count -gt 0
      if(-not $delivered){Start-Sleep -Seconds 1}
    }
    if(-not $delivered){throw "Audit event $eventId was accepted but did not reach CloudWatch Logs"}
    Write-Host "PASS EventBridge audit delivery: $eventId reached /motorlog/events/audit."
  }finally{if(Test-Path -LiteralPath $eventPath){Remove-Item -LiteralPath $eventPath -Force}}
}
Check SecretsManager {
  Invoke-Aws secretsmanager describe-secret --secret-id motorlog-app/config|Out-Null
  Invoke-Aws secretsmanager describe-secret --secret-id motorlog-auth/rate-limit-key|Out-Null
}
Check IAM {Invoke-Aws iam get-role --role-name motorlog-ecs-task-role}
Check CloudWatchLogs {Invoke-Aws logs describe-log-groups --log-group-name-prefix /motorlog}
Check BackendHealth {if((Invoke-WebRequest -UseBasicParsing http://localhost:3101/api/health -TimeoutSec 3).StatusCode -ne 200){throw 'Health endpoint failed'}}
Check SecurityHeaders {$h=(Invoke-WebRequest -UseBasicParsing http://localhost:3101/api/health -TimeoutSec 3).Headers;if(-not $h['X-Content-Type-Options']-or-not $h['X-Frame-Options']-or-not $h['Content-Security-Policy']){throw 'Required headers missing'}}
$results|Format-Table -AutoSize
if(@($results|Where-Object Result -eq 'FAIL').Count){exit 1}

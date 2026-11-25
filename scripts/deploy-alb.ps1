. (Join-Path $PSScriptRoot 'cloud-common.ps1')
& (Join-Path $PSScriptRoot 'start-alb-targets.ps1')
$lbName='motorlog-alb';$tgName='motorlog-http-targets';$targetIp=$env:MOTORLOG_ALB_TARGET_IP
if(-not $targetIp){try{$targetIp=((& docker exec floci getent hosts host.docker.internal) -split '\s+')[0]}catch{}}
if(-not $targetIp -or $targetIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$'){throw 'Could not resolve Docker-reachable host IP. Set MOTORLOG_ALB_TARGET_IP explicitly.'}
$vpc=@((Invoke-Aws ec2 describe-vpcs|ConvertFrom-Json).Vpcs|Where-Object{@($_.Tags|Where-Object{$_.Key -eq 'Name' -and $_.Value -eq 'motorlog-alb-vpc'}).Count})[0]
if(-not $vpc){$vpc=(Invoke-Aws ec2 create-vpc --cidr-block 10.60.0.0/16|ConvertFrom-Json).Vpc;Invoke-Aws ec2 create-tags --resources $vpc.VpcId --tags Key=Name,Value=motorlog-alb-vpc|Out-Null}
$subnets=@((Invoke-Aws ec2 describe-subnets|ConvertFrom-Json).Subnets|Where-Object VpcId -eq $vpc.VpcId|Select-Object -ExpandProperty SubnetId)
if($subnets.Count -lt 2){$subnets=@((Invoke-Aws ec2 create-subnet --vpc-id $vpc.VpcId --cidr-block 10.60.1.0/24 --availability-zone us-east-1a|ConvertFrom-Json).Subnet.SubnetId,(Invoke-Aws ec2 create-subnet --vpc-id $vpc.VpcId --cidr-block 10.60.2.0/24 --availability-zone us-east-1b|ConvertFrom-Json).Subnet.SubnetId)}
$group=@((Invoke-Aws ec2 describe-security-groups|ConvertFrom-Json).SecurityGroups|Where-Object{$_.VpcId -eq $vpc.VpcId -and $_.GroupName -eq 'motorlog-alb-sg'})[0]
if(-not $group){$groupId=(Invoke-Aws ec2 create-security-group --group-name motorlog-alb-sg --description 'Motorlog local ALB' --vpc-id $vpc.VpcId|ConvertFrom-Json).GroupId;Invoke-Aws ec2 authorize-security-group-ingress --group-id $groupId --protocol tcp --port 80 --cidr 127.0.0.1/32|Out-Null;$group=[pscustomobject]@{GroupId=$groupId}}
$groups=(Invoke-Aws elbv2 describe-target-groups|ConvertFrom-Json).TargetGroups
$tg=@($groups|Where-Object{$_.TargetGroupName -eq $tgName})[0]
if($tg -and $tg.VpcId -ne $vpc.VpcId -and @($tg.LoadBalancerArns).Count -eq 0){Invoke-Aws elbv2 delete-target-group --target-group-arn $tg.TargetGroupArn|Out-Null;$tg=$null}
if(-not $tg){$tg=(Invoke-Aws elbv2 create-target-group --name $tgName --protocol HTTP --port 3101 --vpc-id $vpc.VpcId --target-type ip --health-check-protocol HTTP --health-check-path /api/health --health-check-port traffic-port --health-check-interval-seconds 5 --health-check-timeout-seconds 2 --healthy-threshold-count 2 --unhealthy-threshold-count 2 --matcher HttpCode=200|ConvertFrom-Json).TargetGroups[0]}
Invoke-Aws elbv2 register-targets --target-group-arn $tg.TargetGroupArn --targets "Id=$targetIp,Port=3101" "Id=$targetIp,Port=3102" "Id=$targetIp,Port=3103"|Out-Null
$lbs=(Invoke-Aws elbv2 describe-load-balancers|ConvertFrom-Json).LoadBalancers
$lb=@($lbs|Where-Object{$_.LoadBalancerName -eq $lbName})[0]
if(-not $lb){$lb=(Invoke-Aws elbv2 create-load-balancer --name $lbName --type application --scheme internal --ip-address-type ipv4 --subnets $subnets --security-groups $group.GroupId|ConvertFrom-Json).LoadBalancers[0]}
$listeners=(Invoke-Aws elbv2 describe-listeners --load-balancer-arn $lb.LoadBalancerArn|ConvertFrom-Json).Listeners
$listener=@($listeners|Where-Object{$_.Port -eq 80})[0]
if(-not $listener){$listener=(Invoke-Aws elbv2 create-listener --load-balancer-arn $lb.LoadBalancerArn --protocol HTTP --port 80 --default-actions "Type=forward,TargetGroupArn=$($tg.TargetGroupArn)"|ConvertFrom-Json).Listeners[0]}
$proxyName='motorlog-alb-loopback-proxy';$proxyRunning=& docker ps --filter "name=^/$proxyName$" --format '{{.Names}}'
if(-not $proxyRunning){$proxyExists=& docker ps -a --filter "name=^/$proxyName$" --format '{{.Names}}';if($proxyExists){& docker start $proxyName|Out-Null}else{$proxyScript=(Join-Path $ProjectRoot 'scripts\alb-port-proxy.js');& docker run -d --name $proxyName --network cloud-issue-floci_default -p '127.0.0.1:4510:4510' --mount "type=bind,source=$proxyScript,target=/proxy.js,readonly" --entrypoint /var/lang/bin/node public.ecr.aws/lambda/nodejs:22 /proxy.js floci 80 4510|Out-Null};if($LASTEXITCODE -ne 0){throw 'Could not start the loopback-only ALB listener proxy.'}}
$localHostName="$($lb.DNSName -replace '\.elb\.floci$','').elb.localhost.floci.io"
$localUrl="http://$localHostName`:4510"
$info=[ordered]@{loadBalancerName=$lbName;loadBalancerArn=$lb.LoadBalancerArn;dnsName=$lb.DNSName;url=$localUrl;listenerArn=$listener.ListenerArn;listenerPort=80;targetGroupName=$tgName;targetGroupArn=$tg.TargetGroupArn;targetIp=$targetIp;targets=@(@{id='motorlog-a';port=3101},@{id='motorlog-b';port=3102},@{id='motorlog-c';port=3103})}
Write-JsonFile (Join-Path $ProjectRoot 'dist\alb-deployment.json') $info
Write-Host "ALB URL: $localUrl"
Write-Host "Target group: $($tg.TargetGroupArn)"

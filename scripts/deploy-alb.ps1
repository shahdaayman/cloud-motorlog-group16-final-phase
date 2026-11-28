. (Join-Path $PSScriptRoot 'cloud-common.ps1')
function Write-Status([string]$Status,[string]$Message){Write-Host (("[$Status]").PadRight(10)+$Message)}
function Invoke-Docker([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments){$output=@(& docker @Arguments);if($LASTEXITCODE -ne 0){throw "Docker failed with exit code $LASTEXITCODE`: docker $($Arguments -join ' ')"};$output}
function Get-FlociContainer {
  $composePath=Join-Path $ProjectRoot 'infra\floci\docker-compose.yml';$compose=Get-Content -LiteralPath $composePath -Raw;$configured=$null
  if($compose -match '(?m)^\s*container_name:\s*([^\s#]+)'){$configured=$matches[1]}
  if($env:MOTORLOG_FLOCI_CONTAINER){$names=@(Invoke-Docker ps --filter "name=^/$($env:MOTORLOG_FLOCI_CONTAINER)$" --format '{{.Names}}');if($names.Count -ne 1){throw "MOTORLOG_FLOCI_CONTAINER $($env:MOTORLOG_FLOCI_CONTAINER) is not a running container."};return $names[0]}
  $labelNames=@(Invoke-Docker ps --filter 'label=com.docker.compose.project=motorlog-floci' --filter 'label=com.docker.compose.service=floci' --format '{{.Names}}'|Where-Object{$_})
  $configuredNames=if($configured){@(Invoke-Docker ps --filter "name=^/$configured$" --format '{{.Names}}'|Where-Object{$_})}else{@()}
  if($configuredNames.Count -eq 1 -and ($labelNames.Count -eq 0 -or $labelNames -contains $configured)){return $configured}
  if($labelNames.Count -eq 1){return $labelNames[0]}
  if($labelNames.Count -gt 1){throw "Multiple running Floci containers belong to the motorlog-floci Compose project: $($labelNames -join ', ')."}
  throw "No running Floci container was found for the current Motorlog Compose project. Start infra/floci/docker-compose.yml first."
}
function Get-FlociNetwork([string]$Container){
  $details=(Invoke-Docker inspect $Container|ConvertFrom-Json)[0];$networks=@($details.NetworkSettings.Networks.psobject.Properties)
  if(-not $networks.Count){throw "Floci container $Container has no attached Docker network."}
  $aliased=@($networks|Where-Object{@($_.Value.Aliases) -contains 'floci'})
  if($aliased.Count -eq 1){return $aliased[0].Name}
  $projectNetworks=@()
  foreach($network in $networks){$n=(Invoke-Docker network inspect $network.Name|ConvertFrom-Json)[0];if($n.Labels.'com.docker.compose.project' -eq 'motorlog-floci'){$projectNetworks+=$network.Name}}
  if($projectNetworks.Count -eq 1){return $projectNetworks[0]}
  if($networks.Count -eq 1){return $networks[0].Name}
  throw "Could not uniquely select the Motorlog Floci network for $Container. Attached networks: $($networks.Name -join ', ')."
}
function Test-ProxyConfiguration($Inspect,[string]$Network,[string]$Upstream,[string]$ScriptPath){
  $cmd=@($Inspect.Config.Cmd);$binding=$Inspect.HostConfig.PortBindings.'4510/tcp';$mount=@($Inspect.Mounts|Where-Object Destination -eq '/proxy.js'|Select-Object -First 1)
  $Inspect.HostConfig.NetworkMode -eq $Network -and $cmd.Count -eq 4 -and $cmd[0] -eq '/proxy.js' -and $cmd[1] -eq $Upstream -and $cmd[2] -eq '80' -and $cmd[3] -eq '4510' -and
    $binding.Count -eq 1 -and $binding[0].HostIp -eq '127.0.0.1' -and $binding[0].HostPort -eq '4510' -and $mount.Count -eq 1 -and
    ([IO.Path]::GetFullPath($mount[0].Source) -eq [IO.Path]::GetFullPath($ScriptPath)) -and $mount[0].RW -eq $false
}

Write-Host "`n===============================================`n          MOTORLOG ALB DEPLOYMENT`n===============================================`n"
$previousInfoPath=Join-Path $ProjectRoot 'dist\alb-deployment.json';$previousInfo=if(Test-Path -LiteralPath $previousInfoPath){Get-Content -LiteralPath $previousInfoPath -Raw|ConvertFrom-Json}else{$null}
& (Join-Path $PSScriptRoot 'start-alb-targets.ps1')
foreach($target in @(@{id='motorlog-a';port=3101},@{id='motorlog-b';port=3102},@{id='motorlog-c';port=3103})){$response=Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$($target.port)/api/health" -TimeoutSec 3;if($response.StatusCode -ne 200 -or $response.Headers['X-Motorlog-Instance'] -ne $target.id){throw "$($target.id) is not healthy on port $($target.port)."};Write-Status OK "$($target.id) healthy on port $($target.port)"}
$flociContainer=Get-FlociContainer;Write-Status OK "Active Floci container discovered: $flociContainer"
$flociNetwork=Get-FlociNetwork $flociContainer;Write-Status OK "Docker network discovered: $flociNetwork"
$targetIp=$env:MOTORLOG_ALB_TARGET_IP
if($targetIp){Write-Status EXISTS 'Using MOTORLOG_ALB_TARGET_IP override'}else{$resolved=Invoke-Docker exec $flociContainer getent hosts host.docker.internal;$targetIp=(($resolved -join "`n") -split '\s+')[0]}
if(-not $targetIp -or $targetIp -notmatch '^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$'){throw 'Could not resolve a valid Docker-reachable host IP. Set MOTORLOG_ALB_TARGET_IP explicitly only when host.docker.internal is unavailable.'}
Write-Status OK "Docker-reachable target IP resolved: $targetIp"

$lbName='motorlog-alb';$tgName='motorlog-http-targets'
$allTargetGroups=@((Invoke-Aws elbv2 describe-target-groups|ConvertFrom-Json).TargetGroups);$existingNamedTargetGroup=@($allTargetGroups|Where-Object TargetGroupName -eq $tgName|Select-Object -First 1)
$allVpcs=@((Invoke-Aws ec2 describe-vpcs|ConvertFrom-Json).Vpcs);$vpc=$null
if($existingNamedTargetGroup.Count){$vpc=@($allVpcs|Where-Object VpcId -eq $existingNamedTargetGroup[0].VpcId|Select-Object -First 1)}
if(-not $vpc){$vpc=@($allVpcs|Where-Object{@($_.Tags|Where-Object{$_.Key -eq 'Name' -and $_.Value -eq 'motorlog-alb-vpc'}).Count}|Select-Object -First 1)}
if(-not $vpc){$cidrVpcs=@($allVpcs|Where-Object{$_.CidrBlock -eq '10.60.0.0/16' -and -not $_.IsDefault});if($cidrVpcs.Count -eq 1){$vpc=$cidrVpcs[0]}elseif($cidrVpcs.Count -gt 1){throw "Multiple untagged Motorlog CIDR VPCs were found and no target group identifies the active one: $($cidrVpcs.VpcId -join ', ')."}}
if(-not $vpc){Write-Status CREATE 'VPC motorlog-alb-vpc';$vpc=(Invoke-Aws ec2 create-vpc --cidr-block 10.60.0.0/16|ConvertFrom-Json).Vpc;Invoke-Aws ec2 create-tags --resources $vpc.VpcId --tags 'Key=Name,Value=motorlog-alb-vpc'|Out-Null}else{Write-Status EXISTS "VPC motorlog-alb-vpc ($($vpc.VpcId))"}
$subnetObjects=@((Invoke-Aws ec2 describe-subnets|ConvertFrom-Json).Subnets|Where-Object VpcId -eq $vpc.VpcId)
if(@($subnetObjects.AvailabilityZone|Select-Object -Unique).Count -lt 2){
  Write-Status CREATE 'ALB subnets in distinct availability zones'
  if($subnetObjects.CidrBlock -notcontains '10.60.1.0/24'){Invoke-Aws ec2 create-subnet --vpc-id $vpc.VpcId --cidr-block 10.60.1.0/24 --availability-zone us-east-1a|Out-Null}
  if($subnetObjects.CidrBlock -notcontains '10.60.2.0/24'){Invoke-Aws ec2 create-subnet --vpc-id $vpc.VpcId --cidr-block 10.60.2.0/24 --availability-zone us-east-1b|Out-Null}
  for($attempt=0;$attempt -lt 20;$attempt++){$subnetObjects=@((Invoke-Aws ec2 describe-subnets|ConvertFrom-Json).Subnets|Where-Object VpcId -eq $vpc.VpcId);if(@($subnetObjects.AvailabilityZone|Select-Object -Unique).Count -ge 2){break};Start-Sleep -Milliseconds 500}
  # Floci publishes EC2 subnet metadata before ELB's subnet index is ready.
  Start-Sleep -Seconds 2
}else{Write-Status EXISTS 'ALB subnets in distinct availability zones'}
$subnets=@($subnetObjects|Group-Object AvailabilityZone|ForEach-Object{$_.Group[0].SubnetId}|Select-Object -First 2)
if($subnets.Count -lt 2){throw 'ALB requires two subnets in distinct availability zones.'}
$group=@((Invoke-Aws ec2 describe-security-groups|ConvertFrom-Json).SecurityGroups|Where-Object{$_.VpcId -eq $vpc.VpcId -and $_.GroupName -eq 'motorlog-alb-sg'})[0]
if(-not $group){Write-Status CREATE 'Security group motorlog-alb-sg';$groupId=(Invoke-Aws ec2 create-security-group --group-name motorlog-alb-sg --description 'Motorlog local ALB' --vpc-id $vpc.VpcId|ConvertFrom-Json).GroupId;Invoke-Aws ec2 authorize-security-group-ingress --group-id $groupId --protocol tcp --port 80 --cidr 127.0.0.1/32|Out-Null;$group=[pscustomobject]@{GroupId=$groupId}}else{Write-Status EXISTS 'Security group motorlog-alb-sg'}
$groups=(Invoke-Aws elbv2 describe-target-groups|ConvertFrom-Json).TargetGroups;$tg=@($groups|Where-Object TargetGroupName -eq $tgName)[0]
if($tg -and $tg.VpcId -ne $vpc.VpcId){throw "Existing target group $tgName belongs to a different VPC; refusing to delete an existing resource."}
if(-not $tg){Write-Status CREATE "Target group $tgName";$tg=(Invoke-Aws elbv2 create-target-group --name $tgName --protocol HTTP --port 3101 --vpc-id $vpc.VpcId --target-type ip --health-check-protocol HTTP --health-check-path /api/health --health-check-port traffic-port --health-check-interval-seconds 5 --health-check-timeout-seconds 2 --healthy-threshold-count 2 --unhealthy-threshold-count 2 --matcher HttpCode=200|ConvertFrom-Json).TargetGroups[0]}else{Write-Status EXISTS "Target group $tgName"}
$health=@((Invoke-Aws elbv2 describe-target-health --target-group-arn $tg.TargetGroupArn|ConvertFrom-Json).TargetHealthDescriptions);$wantedPorts=@(3101,3102,3103);$obsolete=@($health|Where-Object{$_.Target.Id -ne $targetIp -or $_.Target.Port -notin $wantedPorts})
if($obsolete.Count){$args=@('elbv2','deregister-targets','--target-group-arn',$tg.TargetGroupArn,'--targets')+@($obsolete|ForEach-Object{"Id=$($_.Target.Id),Port=$($_.Target.Port)"});Invoke-Aws @args|Out-Null}
Invoke-Aws elbv2 register-targets --target-group-arn $tg.TargetGroupArn --targets "Id=$targetIp,Port=3101" "Id=$targetIp,Port=3102" "Id=$targetIp,Port=3103"|Out-Null;Write-Status OK 'Three targets registered'
$lbs=(Invoke-Aws elbv2 describe-load-balancers|ConvertFrom-Json).LoadBalancers;$lb=@($lbs|Where-Object LoadBalancerName -eq $lbName)[0]
# Floci's query parser currently validates --subnets before retaining all list
# members. AWS's equivalent SubnetMappings form preserves both AZ entries.
$subnetMappings=@($subnets|ForEach-Object{"SubnetId=$_"})
if(-not $lb){Write-Status CREATE "ALB $lbName";$lb=(Invoke-Aws elbv2 create-load-balancer --name $lbName --type application --scheme internal --ip-address-type ipv4 --subnet-mappings $subnetMappings --security-groups $group.GroupId|ConvertFrom-Json).LoadBalancers[0]}else{Write-Status EXISTS "ALB $lbName"}
$listeners=(Invoke-Aws elbv2 describe-listeners --load-balancer-arn $lb.LoadBalancerArn|ConvertFrom-Json).Listeners;$listener=@($listeners|Where-Object Port -eq 80)[0]
if(-not $listener){Write-Status CREATE 'ALB HTTP listener';$listener=(Invoke-Aws elbv2 create-listener --load-balancer-arn $lb.LoadBalancerArn --protocol HTTP --port 80 --default-actions "Type=forward,TargetGroupArn=$($tg.TargetGroupArn)"|ConvertFrom-Json).Listeners[0]}elseif($listener.DefaultActions[0].TargetGroupArn -ne $tg.TargetGroupArn){Write-Status UPDATE 'ALB HTTP listener';$listener=(Invoke-Aws elbv2 modify-listener --listener-arn $listener.ListenerArn --default-actions "Type=forward,TargetGroupArn=$($tg.TargetGroupArn)"|ConvertFrom-Json).Listeners[0]}else{Write-Status EXISTS 'ALB HTTP listener'}

$proxyName='motorlog-alb-loopback-proxy';$proxyScript=Join-Path $ProjectRoot 'scripts\alb-port-proxy.js';$proxyNames=@(Invoke-Docker ps --all --filter "name=^/$proxyName$" --format '{{.Names}}'|Where-Object{$_});$repair=$false
if($proxyNames.Count){$proxyInspect=(Invoke-Docker inspect $proxyName|ConvertFrom-Json)[0];$repair=-not(Test-ProxyConfiguration $proxyInspect $flociNetwork $flociContainer $proxyScript);if($repair){Write-Status UPDATE 'Obsolete ALB proxy configuration';Invoke-Docker rm --force $proxyName|Out-Null}}
if(-not $proxyNames.Count -or $repair){Invoke-Docker run --detach --name $proxyName --label 'com.motorlog.role=alb-loopback-proxy' --label "com.motorlog.floci-container=$flociContainer" --network $flociNetwork --publish '127.0.0.1:4510:4510' --mount "type=bind,source=$proxyScript,target=/proxy.js,readonly" --entrypoint /var/lang/bin/node public.ecr.aws/lambda/nodejs:22 /proxy.js $flociContainer 80 4510|Out-Null;Write-Status CREATE 'ALB loopback proxy'}else{$running=@(Invoke-Docker ps --filter "name=^/$proxyName$" --format '{{.Names}}'|Where-Object{$_});if(-not $running.Count){Invoke-Docker start $proxyName|Out-Null;Write-Status UPDATE 'Started existing ALB loopback proxy'}else{Write-Status EXISTS 'ALB loopback proxy'}}

for($attempt=0;$attempt -lt 60;$attempt++){$health=@((Invoke-Aws elbv2 describe-target-health --target-group-arn $tg.TargetGroupArn|ConvertFrom-Json).TargetHealthDescriptions);$healthy=@($health|Where-Object{$_.Target.Id -eq $targetIp -and $_.Target.Port -in $wantedPorts -and $_.TargetHealth.State -eq 'healthy'});if($healthy.Count -eq 3){break};Start-Sleep -Seconds 1}
if($healthy.Count -ne 3){throw "ALB targets did not all become healthy: $($health|ConvertTo-Json -Depth 6 -Compress)"};Write-Status OK 'All three ALB targets healthy'
$localHostName=if($lb.DNSName -match '\.localhost\.floci\.io$'){$lb.DNSName}else{"$($lb.DNSName -replace '\.elb\.floci$','').elb.localhost.floci.io"};$localUrl="http://$localHostName`:4510"
$endpoint=$null;for($attempt=0;$attempt -lt 20 -and -not $endpoint;$attempt++){try{$endpoint=Invoke-WebRequest -UseBasicParsing -Uri "$localUrl/api/health" -TimeoutSec 3}catch{Start-Sleep -Milliseconds 500}}
if(-not $endpoint -or $endpoint.StatusCode -ne 200 -or $endpoint.Headers['X-Motorlog-Instance'] -notin 'motorlog-a','motorlog-b','motorlog-c'){throw 'ALB proxy endpoint verification failed.'};Write-Status OK 'ALB endpoint verified'
$info=[ordered]@{loadBalancerName=$lbName;loadBalancerArn=$lb.LoadBalancerArn;dnsName=$lb.DNSName;url=$localUrl;listenerArn=$listener.ListenerArn;listenerPort=80;targetGroupName=$tgName;targetGroupArn=$tg.TargetGroupArn;targetIp=$targetIp;flociContainer=$flociContainer;dockerNetwork=$flociNetwork;targetCorsConfigured=$true;targets=@(@{id='motorlog-a';port=3101},@{id='motorlog-b';port=3102},@{id='motorlog-c';port=3103})};Write-JsonFile (Join-Path $ProjectRoot 'dist\alb-deployment.json') $info
if(-not $previousInfo.targetCorsConfigured -or $previousInfo.url -ne $localUrl){Write-Status UPDATE 'ALB backend exact-origin CORS'; & (Join-Path $PSScriptRoot 'restart-alb-targets.ps1');foreach($port in 3101,3102,3103){for($attempt=0;$attempt -lt 45;$attempt++){$state=@((Invoke-Aws elbv2 describe-target-health --target-group-arn $tg.TargetGroupArn|ConvertFrom-Json).TargetHealthDescriptions|Where-Object{$_.Target.Port -eq $port -and $_.TargetHealth.State -eq 'healthy'});if($state.Count){break};Start-Sleep -Seconds 1};if(-not $state.Count){throw "Restarted ALB target $port did not become healthy."}}}
& (Join-Path $PSScriptRoot 'update-alb-cors.ps1')
$apiBase=(Get-MotorlogApiDeployment).url
foreach($probe in @(@{path='/api/vehicles';method='GET'},@{path='/api/vehicles/probe/fuel';method='GET'},@{path='/api/reminders';method='GET'})){$preflight=Invoke-WebRequest -UseBasicParsing -Method OPTIONS -Uri "$apiBase$($probe.path)" -Headers @{Origin=$localUrl;'Access-Control-Request-Method'=$probe.method;'Access-Control-Request-Headers'='authorization,content-type,idempotency-key'} -TimeoutSec 10;if($preflight.StatusCode -notin 200,204 -or $preflight.Headers['Access-Control-Allow-Origin'] -ne $localUrl -or $preflight.Headers['Access-Control-Allow-Methods'] -notmatch $probe.method -or $preflight.Headers['Access-Control-Allow-Headers'] -notmatch '(?i)idempotency-key'){throw "API Gateway CORS verification failed for $($probe.path)."}}
Write-Status OK 'API Gateway exact-origin CORS verified'
Write-Host "`n-----------------------------------------------`nALB deployment: SUCCESS`n-----------------------------------------------`nALB URL: $localUrl"

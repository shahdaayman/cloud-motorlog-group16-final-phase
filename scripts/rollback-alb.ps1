param([switch]$ConfirmRollback)
if(-not $ConfirmRollback){throw 'Rollback stops the two ALB targets and deletes only Motorlog ALB resources. Re-run with -ConfirmRollback.'}
. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$infoPath=Join-Path $ProjectRoot 'dist\alb-deployment.json';if(-not(Test-Path -LiteralPath $infoPath)){throw 'ALB deployment metadata was not found.'};$info=Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json
try{Invoke-Aws elbv2 delete-listener --listener-arn $info.listenerArn|Out-Null}catch{};try{Invoke-Aws elbv2 delete-load-balancer --load-balancer-arn $info.loadBalancerArn|Out-Null}catch{};try{Invoke-Aws elbv2 delete-target-group --target-group-arn $info.targetGroupArn|Out-Null}catch{}
$savedPath=Join-Path $ProjectRoot 'dist\alb-targets.json';if(Test-Path -LiteralPath $savedPath){$saved=Get-Content -LiteralPath $savedPath -Raw|ConvertFrom-Json;foreach($target in @($saved.targets)){$process=Get-Process -Id $target.pid -ErrorAction SilentlyContinue;if($process -and $process.ProcessName -match '^node'){Stop-Process -Id $target.pid -Force}}}
& docker rm -f motorlog-alb-loopback-proxy 2>$null|Out-Null
Write-Host 'Removed the Motorlog ALB, listener, target group, loopback proxy and two ephemeral target processes. The dedicated VPC is retained for recoverable redeployment.'

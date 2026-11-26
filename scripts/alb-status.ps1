. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$path=Join-Path $ProjectRoot 'dist\alb-deployment.json';if(-not(Test-Path -LiteralPath $path)){throw 'Run npm run alb:deploy first.'};$info=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
Invoke-Aws elbv2 describe-load-balancers --load-balancer-arns $info.loadBalancerArn
Invoke-Aws elbv2 describe-listeners --listener-arns $info.listenerArn
Invoke-Aws elbv2 describe-target-health --target-group-arn $info.targetGroupArn
Write-Host "Listener URL: $($info.url)"

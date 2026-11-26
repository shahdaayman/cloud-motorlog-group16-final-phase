. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$items=(Invoke-Aws cloudfront list-distributions|ConvertFrom-Json).DistributionList.Items
$distribution=@($items|Where-Object{$_.Comment -eq 'Motorlog Frontend'})[0]
if(-not $distribution){throw 'Motorlog Frontend distribution was not found. Run npm run cloudfront:deploy.'}
Invoke-Aws cloudfront get-distribution --id $distribution.Id
$infoPath=Join-Path $ProjectRoot 'dist\cloudfront-deployment.json'
if(Test-Path -LiteralPath $infoPath){Write-Host "Local URL: $((Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json).url)"}

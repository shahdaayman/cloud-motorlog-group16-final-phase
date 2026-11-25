. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$items=(Invoke-Aws cloudfront list-distributions|ConvertFrom-Json).DistributionList.Items
$distribution=@($items|Where-Object{$_.Comment -eq 'Motorlog Frontend'})[0]
if(-not $distribution){throw 'Motorlog Frontend distribution was not found.'}
$batchPath=Join-Path $ProjectRoot 'dist\cloudfront-invalidation.json'
Write-JsonFile $batchPath @{Paths=@{Quantity=1;Items=@('/*')};CallerReference="motorlog-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"}
$result=Invoke-Aws cloudfront create-invalidation --distribution-id $distribution.Id --invalidation-batch "file://$batchPath"|ConvertFrom-Json
Write-Host "Created invalidation $($result.Invalidation.Id) for distribution $($distribution.Id)"

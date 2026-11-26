. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$bucket='motorlog-frontend'
Invoke-Aws s3api get-public-access-block --bucket $bucket
Invoke-Aws s3api get-bucket-website --bucket $bucket
Invoke-Aws s3api list-objects-v2 --bucket $bucket --query 'Contents[].{Key:Key,Size:Size}'

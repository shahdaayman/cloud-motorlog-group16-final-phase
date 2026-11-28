. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$bucket='motorlog-frontend';$source=Join-Path $ProjectRoot 'frontend';$stage=Join-Path $ProjectRoot 'dist\s3-frontend'
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'dist')|Out-Null
function Write-Status([string]$Status,[string]$Message){Write-Host (("[$Status]").PadRight(10)+$Message)}
Write-Host ''
Write-Host '==============================================='
Write-Host '          MOTORLOG S3 DEPLOYMENT'
Write-Host '==============================================='
Write-Host ''
Write-Status INFO 'Checking S3 frontend bucket...'
$bucketCheck=Invoke-AwsExistenceCheck -Arguments @('s3api','head-bucket','--bucket',$bucket) -NotFoundErrorCodes @('404','NoSuchBucket','NotFound')
if($bucketCheck.Exists){
  Write-Status EXISTS "S3 bucket $bucket"
}else{
  Write-Status CREATE "Bucket $bucket does not exist; creating..."
  Invoke-Aws s3api create-bucket --bucket $bucket|Out-Null
  $createdCheck=Invoke-AwsExistenceCheck -Arguments @('s3api','head-bucket','--bucket',$bucket) -NotFoundErrorCodes @('404','NoSuchBucket','NotFound')
  if(-not $createdCheck.Exists){throw "S3 bucket $bucket was not found after creation."}
  Write-Status OK 'S3 bucket created successfully'
}
$apiUrl=(Get-MotorlogApiDeployment).url
Write-Status OK 'API Gateway discovered'
$allowed=@('.html','.css','.js','.png','.jpg','.jpeg','.svg','.webp','.gif','.ico','.woff','.woff2')
$block=Join-Path $ProjectRoot 'dist\s3-public-access-block.json';Write-JsonFile $block @{BlockPublicAcls=$true;IgnorePublicAcls=$true;BlockPublicPolicy=$true;RestrictPublicBuckets=$true}
Invoke-Aws s3api put-public-access-block --bucket $bucket --public-access-block-configuration "file://$block"|Out-Null
$website=Join-Path $ProjectRoot 'dist\s3-website.json';Write-JsonFile $website @{IndexDocument=@{Suffix='index.html'};ErrorDocument=@{Key='index.html'}}
Invoke-Aws s3api put-bucket-website --bucket $bucket --website-configuration "file://$website"|Out-Null
New-Item -ItemType Directory -Force -Path $stage|Out-Null
$files=Get-ChildItem -LiteralPath $source -Recurse -File|Where-Object{$allowed -contains $_.Extension.ToLower()}
function Content-Type($extension){switch($extension.ToLower()){'.html'{'text/html; charset=utf-8'}'.css'{'text/css; charset=utf-8'}'.js'{'application/javascript; charset=utf-8'}'.svg'{'image/svg+xml'}'.png'{'image/png'}'.jpg'{'image/jpeg'}'.jpeg'{'image/jpeg'}'.webp'{'image/webp'}'.gif'{'image/gif'}'.ico'{'image/x-icon'}'.woff'{'font/woff'}'.woff2'{'font/woff2'}default{'application/octet-stream'}}}
foreach($file in $files){$relative=$file.FullName.Substring($source.Length+1);$key=$relative.Replace('\','/');$body=$file.FullName
  if($key -eq 'js/config.js'){$body=Join-Path $stage 'config.js';$content="// Generated for the private Floci S3 deployment. No credentials belong here.`r`nwindow.MOTORLOG_CONFIG = { API_BASE_URL: '$apiUrl', APP_NAME: 'Motorlog' };`r`n";[IO.File]::WriteAllText($body,$content,(New-Object Text.UTF8Encoding($false)))}
  $entryScripts=@('js/config.js','js/hash-router.js','js/secure-uuid.js','js/session-store.js','js/app.js','js/admin.js')
  $cache=if($file.Extension -eq '.html' -or $entryScripts -contains $key){'no-cache, no-store, must-revalidate'}else{'public, max-age=3600'}
  Invoke-Aws s3api put-object --bucket $bucket --key $key --body $body --content-type (Content-Type $file.Extension) --cache-control $cache|Out-Null
}
# A private S3 REST origin does not perform website-style directory index
# resolution. This safe alias lets CloudFront serve /admin/ while retaining OAC.
$adminIndex=Join-Path $source 'admin\index.html'
Invoke-Aws s3api put-object --bucket $bucket --key 'admin/' --body $adminIndex --content-type 'text/html; charset=utf-8' --cache-control 'no-cache, no-store, must-revalidate'|Out-Null
Write-Status OK "Frontend assets uploaded ($($files.Count) allow-listed files; no objects deleted)"
& (Join-Path $PSScriptRoot 'verify-s3-frontend.ps1')
if(-not $?){throw 'S3 frontend verification failed.'}
Write-Status OK 'MIME types verified'
Write-Status OK 'S3 frontend verification passed'
Write-Host 'Bucket remains private; website configuration is staged for CloudFront or explicitly approved local public testing.'
Write-Host "API base: $apiUrl"
Write-Host ''
Write-Host '-----------------------------------------------'
Write-Host 'S3 frontend deployment: SUCCESS'
Write-Host '-----------------------------------------------'

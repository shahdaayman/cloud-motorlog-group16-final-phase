. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$bucket='motorlog-frontend';$source=Join-Path $ProjectRoot 'frontend';$stage=Join-Path $ProjectRoot 'dist\s3-frontend'
$apiUrl=(Get-MotorlogApiDeployment).url
$allowed=@('.html','.css','.js','.png','.jpg','.jpeg','.svg','.webp','.gif','.ico','.woff','.woff2')
try{Invoke-Aws s3api head-bucket --bucket $bucket|Out-Null}catch{Invoke-Aws s3api create-bucket --bucket $bucket|Out-Null}
$block=Join-Path $ProjectRoot 'dist\s3-public-access-block.json';Write-JsonFile $block @{BlockPublicAcls=$true;IgnorePublicAcls=$true;BlockPublicPolicy=$true;RestrictPublicBuckets=$true}
Invoke-Aws s3api put-public-access-block --bucket $bucket --public-access-block-configuration "file://$block"|Out-Null
$website=Join-Path $ProjectRoot 'dist\s3-website.json';Write-JsonFile $website @{IndexDocument=@{Suffix='index.html'};ErrorDocument=@{Key='index.html'}}
Invoke-Aws s3api put-bucket-website --bucket $bucket --website-configuration "file://$website"|Out-Null
New-Item -ItemType Directory -Force -Path $stage|Out-Null
$files=Get-ChildItem -LiteralPath $source -Recurse -File|Where-Object{$allowed -contains $_.Extension.ToLower()}
function Content-Type($extension){switch($extension.ToLower()){'.html'{'text/html; charset=utf-8'}'.css'{'text/css; charset=utf-8'}'.js'{'application/javascript; charset=utf-8'}'.svg'{'image/svg+xml'}'.png'{'image/png'}'.jpg'{'image/jpeg'}'.jpeg'{'image/jpeg'}'.webp'{'image/webp'}'.gif'{'image/gif'}'.ico'{'image/x-icon'}'.woff'{'font/woff'}'.woff2'{'font/woff2'}default{'application/octet-stream'}}}
foreach($file in $files){$relative=$file.FullName.Substring($source.Length+1);$key=$relative.Replace('\','/');$body=$file.FullName
  if($key -eq 'js/config.js'){$body=Join-Path $stage 'config.js';$content="// Generated for the private Floci S3 deployment. No credentials belong here.`r`nwindow.MOTORLOG_CONFIG = { API_BASE_URL: '$apiUrl', APP_NAME: 'Motorlog' };`r`n";[IO.File]::WriteAllText($body,$content,(New-Object Text.UTF8Encoding($false)))}
  $entryScripts=@('js/config.js','js/hash-router.js','js/app.js','js/admin.js')
  $cache=if($file.Extension -eq '.html' -or $entryScripts -contains $key){'no-cache, no-store, must-revalidate'}else{'public, max-age=3600'}
  Invoke-Aws s3api put-object --bucket $bucket --key $key --body $body --content-type (Content-Type $file.Extension) --cache-control $cache|Out-Null
}
# A private S3 REST origin does not perform website-style directory index
# resolution. This safe alias lets CloudFront serve /admin/ while retaining OAC.
$adminIndex=Join-Path $source 'admin\index.html'
Invoke-Aws s3api put-object --bucket $bucket --key 'admin/' --body $adminIndex --content-type 'text/html; charset=utf-8' --cache-control 'no-cache, no-store, must-revalidate'|Out-Null
Write-Host "Uploaded $($files.Count) allow-listed static files to s3://$bucket without deleting existing objects."
Write-Host "API base: $apiUrl"
Write-Host 'Bucket remains private; website configuration is staged for CloudFront or explicitly approved local public testing.'

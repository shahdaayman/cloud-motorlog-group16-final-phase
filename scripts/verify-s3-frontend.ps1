. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$bucket='motorlog-frontend';$out=Join-Path $ProjectRoot 'dist\s3-verification';New-Item -ItemType Directory -Force -Path $out|Out-Null
$objects=Invoke-Aws s3api list-objects-v2 --bucket $bucket|ConvertFrom-Json;$keys=@($objects.Contents|ForEach-Object Key)
$required=@('index.html','admin/index.html','js/config.js','js/app.js','js/admin.js','css/styles.css','css/admin.css')
foreach($key in $required){if($keys -notcontains $key){throw "Missing required object: $key"};$safe=$key.Replace('/','-');Invoke-Aws s3api get-object --bucket $bucket --key $key (Join-Path $out $safe)|Out-Null;Write-Host "PASS retrieved $key"}
$bad=@($keys|Where-Object{$_ -match '(^|/)(\.env|node_modules|backend|tests?|dist|package(-lock)?\.json|.*\.(zip|pem|key))($|/)'});if($bad){throw "Sensitive or non-frontend keys found: $($bad -join ', ')"}
$html=Get-Content -LiteralPath (Join-Path $out 'index.html') -Raw;$admin=Get-Content -LiteralPath (Join-Path $out 'admin-index.html') -Raw;$config=Get-Content -LiteralPath (Join-Path $out 'js-config.js') -Raw
if($html -notmatch 'js/config\.js' -or $admin -notmatch '\.\./js/config\.js'){throw 'Frontend entry points do not load configuration'}
if($config -notmatch [regex]::Escape((Get-MotorlogApiDeployment).url)){throw 'Deployed API base is incorrect'}
foreach($check in @(@('index.html','text/html'),@('css/styles.css','text/css'),@('js/app.js','application/javascript'),@('admin/index.html','text/html'))){$meta=Invoke-Aws s3api head-object --bucket $bucket --key $check[0]|ConvertFrom-Json;if($meta.ContentType -notlike "$($check[1])*" ){throw "Wrong Content-Type for $($check[0]): $($meta.ContentType)"};Write-Host "PASS $($check[0]) Content-Type $($meta.ContentType)"}
$block=Invoke-Aws s3api get-public-access-block --bucket $bucket|ConvertFrom-Json;if(-not $block.PublicAccessBlockConfiguration.BlockPublicPolicy){throw 'Public policy blocking is not enabled'}
Write-Host "PASS private S3 frontend verified: $($keys.Count) objects; no sensitive keys; admin entry point present."

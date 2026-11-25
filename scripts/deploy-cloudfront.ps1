. (Join-Path $PSScriptRoot 'cloud-common.ps1')
$bucket='motorlog-frontend';$comment='Motorlog Frontend';$originId='motorlog-frontend-s3'

# Keep the existing S3 deployment current. It uploads only allow-listed assets.
& (Join-Path $PSScriptRoot 'deploy-s3-frontend.ps1')

$controls=Invoke-Aws cloudfront list-origin-access-controls|ConvertFrom-Json
$oac=@($controls.OriginAccessControlList.Items|Where-Object{$_.Name -eq 'motorlog-frontend-oac'})[0]
if(-not $oac){
  $oacConfig=Join-Path $ProjectRoot 'dist\cloudfront-oac.json'
  Write-JsonFile $oacConfig @{Name='motorlog-frontend-oac';Description='OAC for the private Motorlog frontend bucket';SigningProtocol='sigv4';SigningBehavior='always';OriginAccessControlOriginType='s3'}
  $oac=(Invoke-Aws cloudfront create-origin-access-control --origin-access-control-config "file://$oacConfig"|ConvertFrom-Json).OriginAccessControl
}

$existing=Invoke-Aws cloudfront list-distributions|ConvertFrom-Json
$distribution=@($existing.DistributionList.Items|Where-Object{$_.Comment -eq $comment})[0]
if(-not $distribution){
  $caller="motorlog-frontend-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  $configPath=Join-Path $ProjectRoot 'dist\cloudfront-distribution.json'
  $config=[ordered]@{
    CallerReference=$caller;Comment=$comment;Enabled=$true;DefaultRootObject='index.html';PriceClass='PriceClass_100';HttpVersion='http2';IsIPV6Enabled=$false
    Origins=@{Quantity=1;Items=@(@{Id=$originId;DomainName="$bucket.s3.$Region.amazonaws.com";OriginPath='';CustomHeaders=@{Quantity=0};S3OriginConfig=@{OriginAccessIdentity=''};OriginAccessControlId=$oac.Id;ConnectionAttempts=3;ConnectionTimeout=10;OriginShield=@{Enabled=$false}})}
    DefaultCacheBehavior=@{TargetOriginId=$originId;ViewerProtocolPolicy='allow-all';AllowedMethods=@{Quantity=2;Items=@('HEAD','GET');CachedMethods=@{Quantity=2;Items=@('HEAD','GET')}};Compress=$true;SmoothStreaming=$false;MinTTL=0;DefaultTTL=3600;MaxTTL=86400;ForwardedValues=@{QueryString=$false;Cookies=@{Forward='none'};Headers=@{Quantity=0};QueryStringCacheKeys=@{Quantity=0}};TrustedSigners=@{Enabled=$false;Quantity=0};TrustedKeyGroups=@{Enabled=$false;Quantity=0};FieldLevelEncryptionId=''}
    CacheBehaviors=@{Quantity=1;Items=@(@{PathPattern='*.html';TargetOriginId=$originId;ViewerProtocolPolicy='allow-all';AllowedMethods=@{Quantity=2;Items=@('HEAD','GET');CachedMethods=@{Quantity=2;Items=@('HEAD','GET')}};Compress=$true;SmoothStreaming=$false;MinTTL=0;DefaultTTL=0;MaxTTL=0;ForwardedValues=@{QueryString=$false;Cookies=@{Forward='none'};Headers=@{Quantity=0};QueryStringCacheKeys=@{Quantity=0}};TrustedSigners=@{Enabled=$false;Quantity=0};TrustedKeyGroups=@{Enabled=$false;Quantity=0};FieldLevelEncryptionId=''})}
    CustomErrorResponses=@{Quantity=0};Aliases=@{Quantity=0};ViewerCertificate=@{CloudFrontDefaultCertificate=$true;MinimumProtocolVersion='TLSv1';CertificateSource='cloudfront'};Restrictions=@{GeoRestriction=@{RestrictionType='none';Quantity=0}}
  }
  Write-JsonFile $configPath $config
  $distribution=(Invoke-Aws cloudfront create-distribution --distribution-config "file://$configPath"|ConvertFrom-Json).Distribution
}
$url="http://$($distribution.Id.ToLower()).cloudfront.localhost.localstack.cloud:4566"
$info=[ordered]@{id=$distribution.Id;arn=$distribution.ARN;domainName=$distribution.DomainName;url=$url;originBucket=$bucket;originDomain="$bucket.s3.$Region.amazonaws.com";originAccessControlId=$oac.Id;comment=$comment}
Write-JsonFile (Join-Path $ProjectRoot 'dist\cloudfront-deployment.json') $info

# Re-deploy only configuration/code for the existing Lambdas so the exact new
# browser origin is allowed. Tables, users, MFA and schedules are untouched.
& (Join-Path $PSScriptRoot 'deploy-lambdas.ps1')
& (Join-Path $PSScriptRoot 'invalidate-cloudfront.ps1')
Write-Host "CloudFront distribution: $($distribution.Id)"
Write-Host "CloudFront URL: $url"

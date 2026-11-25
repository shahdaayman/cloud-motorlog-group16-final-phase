const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('CloudFront deployment is repeatable and uses the existing private S3 origin',()=>{
  const pkg=JSON.parse(read('package.json'));
  for(const name of ['cloudfront:deploy','cloudfront:status','cloudfront:verify','cloudfront:invalidate'])assert.ok(pkg.scripts[name],name);
  const deploy=read('scripts/deploy-cloudfront.ps1');
  assert.match(deploy,/Motorlog Frontend/);
  assert.match(deploy,/motorlog-frontend-s3/);
  assert.match(deploy,/OriginAccessControlId/);
  assert.match(deploy,/DefaultRootObject='index\.html'/);
  assert.doesNotMatch(deploy,/create-bucket/);
});

test('CloudFront origin is added to exact-origin Lambda CORS and verification covers admin',()=>{
  const lambdas=read('scripts/deploy-lambdas.ps1');
  assert.match(lambdas,/cloudfront-deployment\.json/);
  const verify=read('scripts/verify-cloudfront.ps1');
  assert.match(verify,/Access-Control-Allow-Origin/);
  assert.match(verify,/\/api\/admin\/overview/);
  assert.match(verify,/\/admin\//);
  assert.doesNotMatch(verify,/Access-Control-Allow-Origin[^\n]+\*/);
});

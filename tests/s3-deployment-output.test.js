const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target); else fs.copyFileSync(source, target);
  }
}

function runDeployment(scenario) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'motorlog-s3-test-'));
  const scripts = path.join(sandbox, 'scripts');
  fs.mkdirSync(scripts);
  for (const name of ['cloud-common.ps1', 'deploy-s3-frontend.ps1', 'verify-s3-frontend.ps1']) {
    fs.copyFileSync(path.join(root, 'scripts', name), path.join(scripts, name));
  }
  copyTree(path.join(root, 'frontend'), path.join(sandbox, 'frontend'));
  const bin = path.join(sandbox, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'aws.cmd'), '@node "%~dp0fake-aws.js" %*\r\n');
  fs.writeFileSync(path.join(bin, 'fake-aws.js'), String.raw`
const fs=require('node:fs');
const a=process.argv.slice(2), service=a.find(x=>['s3api','apigateway'].includes(x));
const i=a.indexOf(service), op=a[i+1], scenario=process.env.FAKE_S3_SCENARIO;
const fail=(message,code=255)=>{console.error(message);process.exit(code)};
if(service==='apigateway'&&op==='get-rest-apis'){console.log('{"items":[{"id":"dynamic-api","name":"motorlog-api"}]}');process.exit(0)}
if(service==='apigateway'&&op==='get-stages'){console.log('{"item":[{"stageName":"dev","deploymentId":"dep-1"}]}');process.exit(0)}
if(service==='s3api'&&op==='head-bucket'){
  const marker=process.env.FAKE_S3_MARKER;
  if(scenario==='access')fail('An error occurred (403) when calling the HeadBucket operation: Forbidden',253);
  if(scenario==='network')fail('Could not connect to the endpoint URL: http://localhost:4566/motorlog-frontend',255);
  if(scenario==='missing'||scenario==='createfail'){
    if(!marker||!fs.existsSync(marker))fail('An error occurred (404) when calling the HeadBucket operation: Not Found',254);
  }
  process.exit(0);
}
if(service==='s3api'&&op==='create-bucket'){
  if(scenario==='createfail')fail('An error occurred (InternalError) when calling the CreateBucket operation: failed',252);
  fs.writeFileSync(process.env.FAKE_S3_MARKER,'created');console.log('{"Location":"/motorlog-frontend"}');process.exit(0);
}
if(service==='s3api'&&op==='list-objects-v2'){
  const keys=['index.html','admin/index.html','admin/','js/config.js','js/secure-uuid.js','js/session-store.js','js/app.js','js/admin.js','css/styles.css','css/admin.css'];
  console.log(JSON.stringify({Contents:keys.map(Key=>({Key}))}));process.exit(0);
}
if(service==='s3api'&&op==='get-object'){
  const key=a[a.indexOf('--key')+1], dest=a[a.length-1];let body='asset';
  if(key==='index.html')body='<script src="js/config.js"></script>';
  if(key==='admin/index.html')body='<script src="../js/config.js"></script>';
  if(key==='js/config.js')body="window.MOTORLOG_CONFIG={API_BASE_URL:'http://dynamic-api.execute-api.localhost.localstack.cloud:4566/dev'}";
  fs.mkdirSync(require('node:path').dirname(dest),{recursive:true});fs.writeFileSync(dest,body);console.log('{}');process.exit(0);
}
if(service==='s3api'&&op==='head-object'){
  const key=a[a.indexOf('--key')+1], ext=require('node:path').extname(key);
  const type=ext==='.html'?'text/html; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':'application/javascript; charset=utf-8';
  console.log(JSON.stringify({ContentType:type}));process.exit(0);
}
if(service==='s3api'&&op==='get-public-access-block'){console.log('{"PublicAccessBlockConfiguration":{"BlockPublicPolicy":true}}');process.exit(0)}
if(service==='s3api'&&['put-object','put-public-access-block','put-bucket-website'].includes(op)){console.log('{}');process.exit(0)}
fail('Unexpected fake AWS call: '+a.join(' '),251);
`);
  const marker = path.join(sandbox, 'bucket-created');
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'deploy-s3-frontend.ps1')], {
    cwd: sandbox, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, AWS_PROFILE: '', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_ENDPOINT_URL: 'http://localhost:4566', FAKE_S3_SCENARIO: scenario, FAKE_S3_MARKER: marker },
  });
  fs.rmSync(sandbox, { recursive: true, force: true });
  return result;
}

test('missing bucket 404 is quiet, creates the bucket, and deploys successfully', () => {
  const r=runDeployment('missing');assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');assert.match(r.stdout,/\[CREATE\].*does not exist/);assert.match(r.stdout,/S3 frontend deployment: SUCCESS/);assert.match(r.stdout,/dynamic-api/);
});
test('existing bucket is reused',()=>{const r=runDeployment('existing');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/\[EXISTS\].*motorlog-frontend/);assert.doesNotMatch(r.stdout,/\[CREATE\]/)});
test('access denied remains visible and fails',()=>{const r=runDeployment('access');assert.notEqual(r.status,0);assert.match(r.stderr,/403|Forbidden/);assert.doesNotMatch(r.stdout,/deployment: SUCCESS/)});
test('network errors remain visible and fail',()=>{const r=runDeployment('network');assert.notEqual(r.status,0);assert.match(r.stderr,/Could not connect/);assert.doesNotMatch(r.stdout,/deployment: SUCCESS/)});
test('bucket creation failure remains visible and fails',()=>{const r=runDeployment('createfail');assert.notEqual(r.status,0);assert.match(r.stderr,/InternalError|CreateBucket/);assert.doesNotMatch(r.stdout,/deployment: SUCCESS/)});

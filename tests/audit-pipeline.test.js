const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('audit Lambda records only allow-listed events and bounded fields',()=>{
  const source=read('backend/services/audit-logger/lambda.js');
  for(const type of ['VehicleCreated','MaintenanceAdded','ReminderCompleted'])assert.match(source,new RegExp(type));
  assert.match(source,/eventId/);assert.match(source,/vehicleId/);assert.match(source,/slice\(0,100\)/);
  assert.doesNotMatch(source,/JSON\.stringify\(event\)/);
  assert.doesNotMatch(source,/password|accessToken|refreshToken|otp/i);
});

test('cloud deployment provisions the Lambda audit bridge and removes the unsupported target',()=>{
  const deploy=read('scripts/deploy-scale-security.ps1');
  assert.match(deploy,/motorlog-audit-runtime/);
  assert.match(deploy,/motorlog-audit-least-privilege/);
  assert.match(deploy,/motorlog-audit-logger/);
  assert.match(deploy,/motorlog-eventbridge-audit-invoke/);
  assert.match(deploy,/remove-targets[^\n]+motorlog-audit-logs/);
  assert.match(deploy,/put-targets[^\n]+motorlog-audit-lambda/);
  assert.doesNotMatch(deploy,/put-targets[^\n]+motorlog-audit-logs/);
});

test('verification requires the generated EventBridge ID to arrive in CloudWatch Logs',()=>{
  const verify=read('scripts/verify-cloud-services.ps1');
  assert.match(verify,/motorlog-audit-verification-\$/);
  assert.match(verify,/put-events/);
  assert.match(verify,/Entries\[0\]\.EventId/);
  assert.match(verify,/filter-log-events/);
  assert.match(verify,/message -like "\*\$eventId\*"/);
  assert.match(verify,/did not reach CloudWatch Logs/);
});

test('audit package declares and bundles the CloudWatch Logs SDK client',()=>{
  const pkg=require('../package.json');const build=read('scripts/build-audit-logger.js');
  assert.ok(pkg.dependencies['@aws-sdk/client-cloudwatch-logs']);
  assert.match(build,/bundle:true/);assert.match(build,/external:\[\]/);
  assert.match(build,/motorlog-audit-logger\.zip/);
});

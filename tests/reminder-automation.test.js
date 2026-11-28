const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {eventType}=require('../backend/services/reminders/lambda');
const root=path.join(__dirname,'..');

test('reminders Lambda distinguishes Scheduler, SQS, and HTTP events',()=>{
  assert.equal(eventType({source:'aws.scheduler',job:'check-reminders'}),'scheduler');
  assert.equal(eventType({Records:[{eventSource:'aws:sqs'}]}),'sqs');
  assert.equal(eventType({requestContext:{http:{method:'GET'}}}),'http');
});

test('scheduled checks use due index, open status, active users, and atomic duplicate claims',()=>{
  const worker=fs.readFileSync(path.join(root,'backend/services/reminders/worker.js'),'utf8');
  assert.match(worker,/IndexName:'due-index'/);assert.match(worker,/':open':'Open'/);
  assert.match(worker,/owner\.status!=='Active'/);assert.match(worker,/ConditionExpression:'#status = :open/);
  assert.match(worker,/lastNotifiedOn <> :today/);assert.match(worker,/options\.dryRun/);
});

test('queue worker revalidates reminder, owner, completion, and delivery deduplication',()=>{
  const worker=fs.readFileSync(path.join(root,'backend/services/reminders/worker.js'),'utf8');
  assert.match(worker,/reminder\.ownerId!==job\.ownerId/);assert.match(worker,/reminder\.status!=='Open'/);
  assert.match(worker,/user\.status!=='Active'/);assert.match(worker,/lastEmailSentOn===job\.today/);
  assert.match(worker,/batchItemFailures/);assert.match(worker,/lastEmailSentOn:job\.today/);
  assert.match(worker,/error:e\.name/);assert.doesNotMatch(worker,/String\(e\.message/);assert.doesNotMatch(worker,/console\.error\([^\n]*job\)/);
});

test('deployment is idempotent, enabled by default, and configures one-message partial-batch processing',()=>{
  const deploy=fs.readFileSync(path.join(root,'scripts/deploy-reminder-automation.ps1'),'utf8');
  assert.match(deploy,/get-schedule.*motorlog-daily-reminder-check/);
  assert.match(deploy,/update-schedule/);assert.match(deploy,/create-schedule/);
  assert.match(deploy,/cron\(0 9 \* \* \? \*\)/);assert.match(deploy,/Africa\/Cairo/);assert.match(deploy,/state ENABLED/i);assert.doesNotMatch(deploy,/create-schedule[^\n]+--state DISABLED/i);
  assert.match(deploy,/NOTIFICATION_QUEUE_URL/);assert.match(deploy,/Reminder automation: ENABLED/);
  assert.match(deploy,/batch-size 1/);assert.match(deploy,/ReportBatchItemFailures/);
  assert.match(deploy,/deadLetterTargetArn/);assert.match(deploy,/maxReceiveCount='3'/);
  const lambdas=fs.readFileSync(path.join(root,'scripts/deploy-lambdas.ps1'),'utf8');assert.match(lambdas,/get-function-configuration.*cml-reminders/);assert.match(lambdas,/notificationQueueUrl=.*Environment\.Variables\.NOTIFICATION_QUEUE_URL/);
});

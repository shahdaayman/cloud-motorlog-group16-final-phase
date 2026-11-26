/** Guarded Floci-only end-to-end test for one explicitly approved reminder/account. */
require('dotenv').config();
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const {SQSClient,SendMessageCommand,GetQueueAttributesCommand}=require('@aws-sdk/client-sqs');
const db=require('../backend/shared/db');
const {awsOptions}=require('../backend/shared/config');
const {claimNotification,releaseNotification}=require('../backend/services/reminders/worker');

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function cairoDay(date=new Date()){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);const value=type=>parts.find(part=>part.type===type).value;return `${value('year')}-${value('month')}-${value('day')}`;}
function parseArguments(argv){const values={approved:false};for(let i=0;i<argv.length;i++){if(argv[i]==='--reminder-id')values.reminderId=argv[++i];else if(argv[i]==='--approved-email')values.email=argv[++i];else if(argv[i]==='--approve-send')values.approved=true;else throw new Error(`Unknown argument: ${argv[i]}`);}return values;}
function validateTarget({reminder,user,email,today}){
  if(!reminder)throw new Error('The specified reminder does not exist');
  if(!user||reminder.ownerId!==user.id)throw new Error('Reminder ownership could not be verified');
  if(user.status!=='Active')throw new Error('The approved test account is not active');
  if(!user.email||user.email.toLowerCase()!==email.toLowerCase())throw new Error('Approved email does not match the reminder owner');
  if(reminder.status!=='Open')throw new Error('The specified reminder is not open');
  if(!reminder.dueDate||reminder.dueDate==='9999-12-31'||reminder.dueDate>=today)throw new Error('The specified reminder is not date-overdue');
  if(reminder.lastNotifiedOn===today||reminder.lastEmailSentOn===today)throw new Error('This reminder was already claimed or emailed for the current notification period');
  return true;
}
function awsJson(args){return JSON.parse(execFileSync('aws',['--profile',process.env.AWS_PROFILE||'floci','--region',process.env.AWS_REGION||'us-east-1','--endpoint-url','http://localhost:4566',...args],{encoding:'utf8',windowsHide:true}));}
function relayDeliveriesSince(since){const result=spawnSync('docker',['logs','cloud-issue-floci-motorlog-html-delivery-1','--since',since],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error('Could not inspect the Gmail delivery bridge');return `${result.stdout||''}\n${result.stderr||''}`.split(/\r?\n/).filter(line=>line.includes('Delivered message via Gmail SMTP')).length;}
async function main(){
  const args=parseArguments(process.argv.slice(2));
  if(!args.reminderId||!args.email)throw new Error('Usage: npm run reminders:test-email -- --reminder-id ID --approved-email EMAIL --approve-send');
  if(!args.approved)throw new Error('Refusing to send without the explicit --approve-send flag');
  if(process.env.AWS_ENDPOINT_URL!=='http://localhost:4566')throw new Error('This targeted test is restricted to local Floci');
  const schedule=awsJson(['scheduler','get-schedule','--group-name','motorlog','--name','motorlog-daily-reminder-check']);
  if(schedule.State!=='DISABLED')throw new Error('The production reminder schedule must be disabled during the targeted test');
  const today=cairoDay(),reminder=await db.get('Reminders',args.reminderId),user=reminder?await db.get('Users',reminder.ownerId):null;
  validateTarget({reminder,user,email:args.email,today});
  const queueUrl=String(process.env.NOTIFICATION_QUEUE_URL||'').replace(/#\s*$/,'');if(!queueUrl)throw new Error('NOTIFICATION_QUEUE_URL is not configured');
  const sqs=new SQSClient({...awsOptions,endpoint:'http://localhost:4566'});
  const queueState=(await sqs.send(new GetQueueAttributesCommand({QueueUrl:queueUrl,AttributeNames:['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible','ApproximateNumberOfMessagesDelayed']}))).Attributes||{};
  if(Object.values(queueState).some(value=>Number(value)!==0))throw new Error('Notification queue is not empty; refusing to mix the targeted test with other work');
  const startedAt=new Date().toISOString();
  if(!await claimNotification(reminder,today))throw new Error('The reminder could not be claimed atomically');
  try{await sqs.send(new SendMessageCommand({QueueUrl:queueUrl,MessageBody:JSON.stringify({type:'REMINDER_DUE',reminderId:reminder.id,ownerId:reminder.ownerId,today})}));}catch(error){await releaseNotification(reminder,today);throw error;}
  let accepted=false;for(let attempt=0;attempt<45&&!accepted;attempt++){await sleep(2000);accepted=(await db.get('Reminders',reminder.id))?.lastEmailSentOn===today;}
  if(!accepted)throw new Error('SES acceptance was not recorded within 90 seconds; the claim remains to prevent an unsafe duplicate');
  let relayCount=0;for(let attempt=0;attempt<30&&relayCount===0;attempt++){await sleep(2000);relayCount=relayDeliveriesSince(startedAt);}
  if(relayCount!==1)throw new Error(`Expected exactly one Gmail relay delivery after test start; observed ${relayCount}`);
  const evidence={test:'targeted-reminder-email',reminderId:reminder.id,ownerId:reminder.ownerId,recipientHash:crypto.createHash('sha256').update(args.email.toLowerCase()).digest('hex').slice(0,16),notificationDay:today,startedAt,completedAt:new Date().toISOString(),sqsTriggered:true,sesAccepted:true,gmailRelayProcessed:true,deliveryCount:relayCount,scheduleState:schedule.State};
  const output=path.join(__dirname,'..','dist','targeted-reminder-email-evidence.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2));
  console.log(`PASS: one targeted reminder email completed. Sanitized evidence: ${path.relative(process.cwd(),output)}`);
}
if(require.main===module)main().catch(error=>{console.error(`Targeted reminder test failed: ${error.message}`);process.exitCode=1;});
module.exports={cairoDay,parseArguments,validateTarget};

const {SQSClient,SendMessageCommand}=require('@aws-sdk/client-sqs');
const {UpdateCommand}=require('@aws-sdk/lib-dynamodb');
const {SESv2Client,SendEmailCommand}=require('@aws-sdk/client-sesv2');
const {awsOptions}=require('../../shared/config');
const db=require('../../shared/db');
const {buildReminderEmail,buildConfirmationEmail,addCalendarDays}=require('./reminder-email');
const {emitMetricSafely}=require('../../shared/metrics');
const {reminderState}=require('../../shared/calc');
const sqs=new SQSClient(awsOptions),ses=new SESv2Client(awsOptions);
async function claimNotification(row,today,store=db){try{await store.client.send(new UpdateCommand({TableName:require('../../shared/config').tables.Reminders,Key:{id:row.id},UpdateExpression:'SET lastNotifiedOn = :today',ConditionExpression:'#status = :open AND (attribute_not_exists(lastNotifiedOn) OR lastNotifiedOn <> :today)',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':today':today,':open':'Open'}}));return true;}catch(error){if(error.name==='ConditionalCheckFailedException')return false;throw error;}}
async function releaseNotification(row,today,store=db){try{await store.client.send(new UpdateCommand({TableName:require('../../shared/config').tables.Reminders,Key:{id:row.id},UpdateExpression:'REMOVE lastNotifiedOn',ConditionExpression:'lastNotifiedOn = :today',ExpressionAttributeValues:{':today':today}}));}catch(error){console.error(JSON.stringify({type:'notification_claim_release_failed',reminderId:row.id,error:error.name}));}}
async function claimConfirmation(row,confirmationId,store=db){try{await store.client.send(new UpdateCommand({TableName:require('../../shared/config').tables.Reminders,Key:{id:row.id},UpdateExpression:'SET confirmationEmailStatus = :processing, confirmationUpdatedAt = :now',ConditionExpression:'creationRequestKey = :id AND confirmationEmailStatus IN (:queued, :pending, :failed)',ExpressionAttributeValues:{':processing':'PROCESSING',':now':new Date().toISOString(),':id':confirmationId,':queued':'QUEUED',':pending':'PENDING_QUEUE',':failed':'FAILED'}}));return true;}catch(error){if(error.name==='ConditionalCheckFailedException')return false;throw error;}}
function cairoDate(value=new Date()){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value).reduce((out,part)=>(out[part.type]=part.value,out),{});return `${parts.year}-${parts.month}-${parts.day}`;}
async function checkScheduled(today=cairoDate(),options={},dependencies={}){
  const store=dependencies.db||db,queue=dependencies.sqs||sqs;
  const url=process.env.NOTIFICATION_QUEUE_URL;if(!url)throw new Error('NOTIFICATION_QUEUE_URL not configured');
  // Query only open reminders. The projected due-index also contains the 9999-12-31
  // sentinel, allowing mileage-only reminders to be evaluated without a table scan.
  let last,total=0,eligible=0,skippedInactive=0;do{
    const {QueryCommand}=require('@aws-sdk/lib-dynamodb');
    const out=await store.client.send(new QueryCommand({TableName:require('../../shared/config').tables.Reminders,IndexName:'due-index',KeyConditionExpression:'#s = :open',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':open':'Open'},ExclusiveStartKey:last,Limit:100}));
    for(const row of out.Items||[]){if(row.status!=='Open'||row.lastNotifiedOn===today)continue;
      const [owner,vehicle]=await Promise.all([store.get('Users',row.ownerId),row.vehicleId?store.get('Vehicles',row.vehicleId):null]);if(!owner?.email||owner.status!=='Active'){skippedInactive++;continue;}const datePreDeadline=row.dueDate&&row.dueDate!=='9999-12-31'&&row.dueDate===addCalendarDays(today,1);if(!datePreDeadline)continue;eligible++;
      if(options.dryRun)continue;
      if(!await claimNotification(row,today,store))continue;
      try{await queue.send(new SendMessageCommand({QueueUrl:url,MessageBody:JSON.stringify({type:'REMINDER_DUE',notificationKind:'DATE_PREDEADLINE',reminderId:row.id,ownerId:row.ownerId,today})}));total++;}catch(error){await releaseNotification(row,today,store);throw error;}
    }last=out.LastEvaluatedKey;
  }while(last);const summary={queued:total,eligible,skippedInactive,day:today,dryRun:options.dryRun===true,...(options.runId?{runId:String(options.runId).slice(0,80)}:{})};console.log(JSON.stringify({type:'scheduled_reminder_check',...summary}));return summary;
}
async function handleQueue(event,dependencies={}){const store=dependencies.db||db,emailClient=dependencies.ses||ses,metric=dependencies.emitMetricSafely||emitMetricSafely;const failures=[];for(const message of event.Records||[]){try{
  const job=JSON.parse(message.body),manual=job.type==='REMINDER_TEST',confirmation=job.type==='REMINDER_CREATED',scheduled=job.type==='REMINDER_DUE';if(!manual&&!confirmation&&!scheduled)throw new Error('Unexpected queue message type');
  const [reminder,user]=await Promise.all([store.get('Reminders',job.reminderId),store.get('Users',job.ownerId)]);
  if(!reminder||reminder.ownerId!==job.ownerId||!user||user.status!=='Active'||!user.email)continue;
  if(confirmation){if(!job.confirmationId||reminder.creationRequestKey!==job.confirmationId||String(user.email).toLowerCase()!==String(job.verifiedEmail||'').toLowerCase()||reminder.confirmationEmailStatus==='SES_ACCEPTED')continue;}else if(reminder.status!=='Open')continue;
  if(manual){if(!job.requestId||reminder.testEmailRequestId!==job.requestId||String(user.email).toLowerCase()!==String(job.verifiedEmail||'').toLowerCase())continue;}else if(scheduled&&reminder.lastEmailSentOn===job.today)continue;
  if(!process.env.SES_FROM_EMAIL)throw new Error('SES_FROM_EMAIL not set');
  const vehicle=reminder.vehicleId?await store.get('Vehicles',reminder.vehicleId):null;
  if(!vehicle||vehicle.ownerId!==job.ownerId)continue;
  if(scheduled&&!(job.notificationKind==='DATE_PREDEADLINE'&&reminder.dueDate===addCalendarDays(job.today,1)))continue;
  if(manual&&reminderState(reminder,vehicle.mileageKm||0,job.today)!=='Due')continue;
  if(manual)await store.patch('Reminders',reminder.id,{testEmailStatus:'PROCESSING',testEmailUpdatedAt:new Date().toISOString()});
  if(confirmation&&!await claimConfirmation(reminder,job.confirmationId,store))continue;
  const renderedEmail=confirmation?buildConfirmationEmail({reminder,vehicle}):buildReminderEmail({reminder,vehicle});
  try{await emailClient.send(new SendEmailCommand({FromEmailAddress:process.env.SES_FROM_EMAIL,Destination:{ToAddresses:[user.email]},Content:{Simple:{Subject:{Data:renderedEmail.subject,Charset:'UTF-8'},Body:{Html:{Data:renderedEmail.html,Charset:'UTF-8'},Text:{Data:renderedEmail.text,Charset:'UTF-8'}}}}}));}catch(error){if(manual)await store.patch('Reminders',reminder.id,{testEmailStatus:'FAILED',testEmailUpdatedAt:new Date().toISOString(),testEmailFailureCode:String(error.name||'DeliveryError').slice(0,80)}).catch(()=>{});if(confirmation)await store.patch('Reminders',reminder.id,{confirmationEmailStatus:'FAILED',confirmationUpdatedAt:new Date().toISOString(),confirmationFailureCode:String(error.name||'DeliveryError').slice(0,80)}).catch(()=>{});throw error;}
  if(manual)await store.patch('Reminders',reminder.id,{testEmailStatus:'SES_ACCEPTED',testEmailUpdatedAt:new Date().toISOString(),lastTestEmailSentAt:new Date().toISOString(),testEmailFailureCode:null});else if(confirmation)await store.patch('Reminders',reminder.id,{confirmationEmailStatus:'SES_ACCEPTED',confirmationUpdatedAt:new Date().toISOString(),confirmationSesAcceptedAt:new Date().toISOString(),confirmationFailureCode:null});else await store.patch('Reminders',reminder.id,{lastEmailSentOn:job.today});
  await metric('NotificationsProcessed',1,{service:'reminders',operation:'notification'});
  }catch(e){console.error(JSON.stringify({type:'notification_failed',messageId:message.messageId,error:e.name||'Error'}));await metric('NotificationFailures',1,{service:'reminders',operation:'notification'});failures.push({itemIdentifier:message.messageId});}}
  return {batchItemFailures:failures};
}
module.exports={checkScheduled,handleQueue,claimNotification,releaseNotification,claimConfirmation,cairoDate};

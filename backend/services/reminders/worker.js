const {SQSClient,SendMessageCommand}=require('@aws-sdk/client-sqs');
const {UpdateCommand}=require('@aws-sdk/lib-dynamodb');
const {SESv2Client,SendEmailCommand}=require('@aws-sdk/client-sesv2');
const {awsOptions}=require('../../shared/config');
const db=require('../../shared/db');
const {buildReminderEmail}=require('./reminder-email');
const {emitMetricSafely}=require('../../shared/metrics');
const sqs=new SQSClient(awsOptions),ses=new SESv2Client(awsOptions);
async function claimNotification(row,today){try{await db.client.send(new UpdateCommand({TableName:require('../../shared/config').tables.Reminders,Key:{id:row.id},UpdateExpression:'SET lastNotifiedOn = :today',ConditionExpression:'#status = :open AND (attribute_not_exists(lastNotifiedOn) OR lastNotifiedOn <> :today)',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':today':today,':open':'Open'}}));return true;}catch(error){if(error.name==='ConditionalCheckFailedException')return false;throw error;}}
async function releaseNotification(row,today){try{await db.client.send(new UpdateCommand({TableName:require('../../shared/config').tables.Reminders,Key:{id:row.id},UpdateExpression:'REMOVE lastNotifiedOn',ConditionExpression:'lastNotifiedOn = :today',ExpressionAttributeValues:{':today':today}}));}catch(error){console.error(JSON.stringify({type:'notification_claim_release_failed',reminderId:row.id,error:error.name}));}}
async function checkScheduled(today=new Date().toISOString().slice(0,10),options={}){
  const url=process.env.NOTIFICATION_QUEUE_URL;if(!url)throw new Error('NOTIFICATION_QUEUE_URL not configured');
  // Query by status and dueDate, not a table scan. Mileage-only reminders are shown on dashboard,
  // but scheduled emails require a due date, avoiding million-user full-table scans.
  let last,total=0,eligible=0,skippedInactive=0;do{
    const {QueryCommand}=require('@aws-sdk/lib-dynamodb');
    const {client}=require('../../shared/db');
    const out=await client.send(new QueryCommand({TableName:require('../../shared/config').tables.Reminders,IndexName:'due-index',KeyConditionExpression:'#s = :open AND #d <= :today',ExpressionAttributeNames:{'#s':'status','#d':'dueDate'},ExpressionAttributeValues:{':open':'Open',':today':today},ExclusiveStartKey:last,Limit:100}));
    for(const row of out.Items||[]){if(row.lastNotifiedOn===today)continue;
      const owner=await db.get('Users',row.ownerId);if(!owner?.email||owner.status!=='Active'){skippedInactive++;continue;}eligible++;
      if(options.dryRun)continue;
      if(!await claimNotification(row,today))continue;
      try{await sqs.send(new SendMessageCommand({QueueUrl:url,MessageBody:JSON.stringify({type:'REMINDER_DUE',reminderId:row.id,ownerId:row.ownerId,today})}));total++;}catch(error){await releaseNotification(row,today);throw error;}
    }last=out.LastEvaluatedKey;
  }while(last);const summary={queued:total,eligible,skippedInactive,day:today,dryRun:options.dryRun===true,...(options.runId?{runId:String(options.runId).slice(0,80)}:{})};console.log(JSON.stringify({type:'scheduled_reminder_check',...summary}));return summary;
}
async function handleQueue(event){const failures=[];for(const message of event.Records||[]){try{
  const job=JSON.parse(message.body);if(job.type!=='REMINDER_DUE')throw new Error('Unexpected queue message type');
  const [reminder,user]=await Promise.all([db.get('Reminders',job.reminderId),db.get('Users',job.ownerId)]);
  if(!reminder||reminder.ownerId!==job.ownerId||reminder.status!=='Open'||!user||user.status!=='Active'||!user.email)continue;
  if(reminder.lastEmailSentOn===job.today)continue;
  if(!process.env.SES_FROM_EMAIL)throw new Error('SES_FROM_EMAIL not set');
  const vehicle=reminder.vehicleId?await db.get('Vehicles',reminder.vehicleId):null;
  if(vehicle&&vehicle.ownerId!==job.ownerId)throw new Error('Reminder vehicle ownership mismatch');
  const renderedEmail=buildReminderEmail({reminder,vehicle});
  await ses.send(new SendEmailCommand({FromEmailAddress:process.env.SES_FROM_EMAIL,Destination:{ToAddresses:[user.email]},Content:{Simple:{Subject:{Data:renderedEmail.subject,Charset:'UTF-8'},Body:{Html:{Data:renderedEmail.html,Charset:'UTF-8'},Text:{Data:renderedEmail.text,Charset:'UTF-8'}}}}}));
  await db.patch('Reminders',reminder.id,{lastEmailSentOn:job.today});
  await emitMetricSafely('NotificationsProcessed',1,{service:'reminders',operation:'notification'});
  }catch(e){console.error(JSON.stringify({type:'notification_failed',messageId:message.messageId,error:e.name||'Error'}));await emitMetricSafely('NotificationFailures',1,{service:'reminders',operation:'notification'});failures.push({itemIdentifier:message.messageId});}}
  return {batchItemFailures:failures};
}
module.exports={checkScheduled,handleQueue,claimNotification,releaseNotification};

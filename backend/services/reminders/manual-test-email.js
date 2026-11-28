const {randomUUID}=require('node:crypto');
const {GetUserCommand}=require('@aws-sdk/client-cognito-identity-provider');
const {SendMessageCommand}=require('@aws-sdk/client-sqs');
const {UpdateCommand}=require('@aws-sdk/lib-dynamodb');
const {tables}=require('../../shared/config');
const {bad,conflict,forbidden}=require('../../shared/errors');
const {reminderState}=require('../../shared/calc');

const COOLDOWN_MS=15*60*1000;
function attributes(output){return Object.fromEntries((output.UserAttributes||[]).map(item=>[item.Name,item.Value]));}
function publicStatus(reminder){return {requestId:reminder.testEmailRequestId||null,status:reminder.testEmailStatus||'IDLE',requestedAt:reminder.lastTestEmailRequestedAt||null,updatedAt:reminder.testEmailUpdatedAt||null,relayStatus:'NOT_VERIFIABLE',message:reminder.testEmailStatus==='SES_ACCEPTED'?'SES accepted the message. Gmail relay and inbox delivery are not asserted by Motorlog.':null};}
async function requestManualTest({reminderId,user,now=new Date(),queueUrl,store,idp,sqs}){
  if(!/^[A-Za-z0-9-]{1,100}$/.test(String(reminderId||'')))throw bad('Invalid reminder ID');
  if(!queueUrl)throw new Error('NOTIFICATION_QUEUE_URL not configured');
  const reminder=await store.owned('Reminders',reminderId,user.sub),vehicle=await store.ownVehicle(reminder.vehicleId,user.sub);
  if(reminder.status!=='Open'||reminderState(reminder,vehicle.mileageKm||0,now.toISOString().slice(0,10))!=='Due')throw bad('Only an open reminder that is currently due can send a test email');
  const account=attributes(await idp.send(new GetUserCommand({AccessToken:user.accessToken}))),verified=account.email_verified==='true'||account.email_verified===true;
  if(!verified||!account.email||account.email.toLowerCase()!==String(user.email||'').toLowerCase())throw forbidden('A verified account email is required');
  const requestId=randomUUID(),requestedAt=now.toISOString(),cutoff=new Date(now.getTime()-COOLDOWN_MS).toISOString();
  try{await store.client.send(new UpdateCommand({TableName:tables.Reminders,Key:{id:reminder.id},UpdateExpression:'SET testEmailRequestId = :requestId, testEmailStatus = :queued, lastTestEmailRequestedAt = :requestedAt, testEmailUpdatedAt = :requestedAt',ConditionExpression:'ownerId = :owner AND #status = :open AND (attribute_not_exists(lastTestEmailRequestedAt) OR lastTestEmailRequestedAt < :cutoff)',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':requestId':requestId,':queued':'QUEUED',':requestedAt':requestedAt,':owner':user.sub,':open':'Open',':cutoff':cutoff}}));}catch(error){if(error.name==='ConditionalCheckFailedException')throw conflict('A test email was already requested recently. Wait 15 minutes before trying again.');throw error;}
  try{await sqs.send(new SendMessageCommand({QueueUrl:queueUrl,MessageBody:JSON.stringify({type:'REMINDER_TEST',reminderId:reminder.id,ownerId:user.sub,today:now.toISOString().slice(0,10),requestId,verifiedEmail:account.email})}));}catch(error){await store.client.send(new UpdateCommand({TableName:tables.Reminders,Key:{id:reminder.id},UpdateExpression:'REMOVE testEmailRequestId, testEmailStatus, lastTestEmailRequestedAt, testEmailUpdatedAt',ConditionExpression:'testEmailRequestId = :requestId',ExpressionAttributeValues:{':requestId':requestId}})).catch(()=>{});throw error;}
  return {requestId,status:'QUEUED',requestedAt,relayStatus:'NOT_VERIFIABLE'};
}
module.exports={COOLDOWN_MS,attributes,publicStatus,requestManualTest};

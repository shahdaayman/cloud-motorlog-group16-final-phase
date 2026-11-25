const {EventBridgeClient,PutEventsCommand}=require('@aws-sdk/client-eventbridge');
const {SNSClient,PublishCommand}=require('@aws-sdk/client-sns');
const {awsOptions}=require('./config');
const eventBridge=new EventBridgeClient(awsOptions),sns=new SNSClient(awsOptions);
async function publishEvent(detailType,detail){
  if(!process.env.EVENT_BUS_NAME)return false;
  try{const out=await eventBridge.send(new PutEventsCommand({Entries:[{EventBusName:process.env.EVENT_BUS_NAME,Source:'motorlog.application',DetailType:detailType,Detail:JSON.stringify(detail)}]}));if(out.FailedEntryCount)throw new Error('EventBridge rejected event');return true;}catch(error){console.error(JSON.stringify({type:'event_publish_failed',detailType,error:error.name||'Error'}));return false;}
}
async function publishNotification(type,detail){
  if(!process.env.SNS_TOPIC_ARN)return false;
  try{await sns.send(new PublishCommand({TopicArn:process.env.SNS_TOPIC_ARN,Subject:`Motorlog: ${type}`.slice(0,100),Message:JSON.stringify({type,...detail})}));return true;}catch(error){console.error(JSON.stringify({type:'sns_publish_failed',notificationType:type,error:error.name||'Error'}));return false;}
}
module.exports={publishEvent,publishNotification};

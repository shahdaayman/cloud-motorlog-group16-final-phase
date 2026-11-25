const {CloudWatchLogsClient,CreateLogStreamCommand,PutLogEventsCommand}=require('@aws-sdk/client-cloudwatch-logs');
const {awsOptions}=require('../../shared/config');

const logGroupName=process.env.AUDIT_LOG_GROUP||'/motorlog/events/audit';
const logStreamName=process.env.AUDIT_LOG_STREAM||'motorlog-eventbridge-audit';
const allowedTypes=new Set(['VehicleCreated','MaintenanceAdded','ReminderCompleted']);
const logs=new CloudWatchLogsClient(awsOptions);

async function handler(event){
  if(event?.source!=='motorlog.application'||!allowedTypes.has(event?.['detail-type']))return {status:'ignored'};
  const record={timestamp:event.time||new Date().toISOString(),eventId:String(event.id||'').slice(0,100),source:event.source,eventType:event['detail-type'],vehicleId:event.detail?.vehicleId?String(event.detail.vehicleId).slice(0,100):null};
  try{await logs.send(new CreateLogStreamCommand({logGroupName,logStreamName}));}catch(error){if(error.name!=='ResourceAlreadyExistsException')throw error;}
  await logs.send(new PutLogEventsCommand({logGroupName,logStreamName,logEvents:[{timestamp:Date.now(),message:JSON.stringify(record)}]}));
  return {status:'logged',eventId:record.eventId};
}

module.exports={handler};

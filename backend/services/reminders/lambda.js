const serverless=require('serverless-http');
const http=serverless(require('./app'));
const {checkScheduled,handleQueue}=require('./worker');
const {emitMetricSafely}=require('../../shared/metrics');
function eventType(event){if(Array.isArray(event?.Records)&&event.Records[0]?.eventSource==='aws:sqs')return 'sqs';if(event?.source==='aws.scheduler'&&event?.job==='check-reminders')return 'scheduler';return 'http';}
module.exports.handler=async(event,context)=>{
 const type=eventType(event);
 if(type==='sqs')return handleQueue(event);
 if(type==='scheduler'){
   try{const result=await checkScheduled(event.today||undefined,{dryRun:event.dryRun===true,runId:event.runId});await emitMetricSafely('ReminderChecks',1,{service:'reminders',operation:'schedule'});if(result.queued)await emitMetricSafely('RemindersQueued',result.queued,{service:'reminders',operation:'schedule'});return result;}
   catch(error){await emitMetricSafely('ReminderCheckFailures',1,{service:'reminders',operation:'schedule'});throw error;}
 }
 return http(event,context);
};
module.exports.eventType=eventType;

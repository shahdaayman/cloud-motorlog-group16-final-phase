const {CloudWatchClient,PutMetricDataCommand}=require('@aws-sdk/client-cloudwatch');
const {awsOptions}=require('./config');

const namespace='Motorlog/Application';
const allowed=new Set(['API5xxErrors','ReminderChecks','ReminderCheckFailures','RemindersQueued','NotificationsProcessed','NotificationFailures']);
const client=new CloudWatchClient(awsOptions);

function dimensionsFor(name,context={}){
  const values={Environment:process.env.MOTORLOG_ENVIRONMENT||'floci'};
  if(name!=='API5xxErrors'){
    values.Service=context.service||'reminders';
    values.Operation=context.operation||'unknown';
  }
  return Object.entries(values).map(([Name,Value])=>({Name,Value:String(Value).slice(0,255)}));
}
function buildMetric(name,value=1,context={}){
  if(!allowed.has(name))throw new Error(`Unsupported Motorlog metric: ${name}`);
  if(!Number.isFinite(value))throw new TypeError('Metric value must be finite');
  return {MetricName:name,Value:value,Unit:'Count',Dimensions:dimensionsFor(name,context)};
}
async function emitMetric(name,value=1,context={}){
  await client.send(new PutMetricDataCommand({Namespace:namespace,MetricData:[buildMetric(name,value,context)]}));
}
function emitMetricSafely(name,value=1,context={}){
  return emitMetric(name,value,context).catch(error=>console.error(JSON.stringify({type:'metric_publish_failed',metric:name,error:error.name||'Error'})));
}
module.exports={namespace,allowed,buildMetric,emitMetric,emitMetricSafely};

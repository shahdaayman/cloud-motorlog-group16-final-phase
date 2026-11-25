const {S3Client,HeadBucketCommand}=require('@aws-sdk/client-s3');
const {LambdaClient,GetFunctionCommand}=require('@aws-sdk/client-lambda');
const {APIGatewayClient,GetRestApisCommand}=require('@aws-sdk/client-api-gateway');
const {IAMClient,GetRoleCommand}=require('@aws-sdk/client-iam');
const {CloudWatchClient,DescribeAlarmsCommand}=require('@aws-sdk/client-cloudwatch');
const {SchedulerClient,GetScheduleCommand}=require('@aws-sdk/client-scheduler');
const {CloudFrontClient,ListDistributionsCommand}=require('@aws-sdk/client-cloudfront');
const {ElasticLoadBalancingV2Client,DescribeLoadBalancersCommand}=require('@aws-sdk/client-elastic-load-balancing-v2');

const required=(value,message)=>{if(!value)throw Object.assign(new Error(message),{name:'ResourceNotFound'});return value;};

function createInfrastructureChecks(awsOptions,overrides={}){
  const clients={
    s3:new S3Client({...awsOptions,forcePathStyle:true}),lambda:new LambdaClient(awsOptions),api:new APIGatewayClient(awsOptions),
    iam:new IAMClient(awsOptions),cloudwatch:new CloudWatchClient(awsOptions),scheduler:new SchedulerClient(awsOptions),
    cloudfront:new CloudFrontClient(awsOptions),elb:new ElasticLoadBalancingV2Client(awsOptions),...overrides
  };
  return [
    ['S3',async()=>clients.s3.send(new HeadBucketCommand({Bucket:'motorlog-frontend'}))],
    ['API Gateway',async()=>required((await clients.api.send(new GetRestApisCommand({limit:500}))).items?.some(x=>x.name==='motorlog-api'),'motorlog-api was not found')],
    ['Lambda',async()=>clients.lambda.send(new GetFunctionCommand({FunctionName:'cml-vehicles'}))],
    ['IAM',async()=>clients.iam.send(new GetRoleCommand({RoleName:'motorlog-vehicles-runtime'}))],
    ['CloudWatch',async()=>required((await clients.cloudwatch.send(new DescribeAlarmsCommand({AlarmNames:['motorlog-api-errors','motorlog-reminder-failures','motorlog-notification-dlq']}))).MetricAlarms?.length,'Motorlog alarms were not found')],
    ['EventBridge Scheduler',async()=>clients.scheduler.send(new GetScheduleCommand({GroupName:'motorlog',Name:'motorlog-daily-reminder-check'}))],
    ['CloudFront',async()=>required((await clients.cloudfront.send(new ListDistributionsCommand({}))).DistributionList?.Items?.some(x=>x.Comment==='Motorlog Frontend'||x.Id==='E9R4PRGCHFESF7'),'Motorlog Frontend distribution was not found')],
    ['Application Load Balancer',async()=>clients.elb.send(new DescribeLoadBalancersCommand({Names:['motorlog-alb']}))]
  ];
}

module.exports={createInfrastructureChecks};

/** Creates the complete seven-table DynamoDB schema in the selected AWS/Floci account. */
require('dotenv').config();
const {DynamoDBClient,CreateTableCommand,DescribeTableCommand,UpdateTableCommand,UpdateTimeToLiveCommand,waitUntilTableExists}=require('@aws-sdk/client-dynamodb');
const {awsOptions,tables}=require('../backend/shared/config');
const client=new DynamoDBClient(awsOptions);
const specs={
 Users:[],
 Vehicles:[['owner-index','ownerId']],
 Maintenance:[['owner-index','ownerId'],['vehicle-index','vehicleId'],['owner-date-index','ownerId','date'],['vehicle-date-index','vehicleId','date']],
 Fuel:[['owner-index','ownerId'],['vehicle-index','vehicleId'],['owner-date-index','ownerId','date'],['vehicle-date-index','vehicleId','date']],
 Expenses:[['owner-index','ownerId'],['vehicle-index','vehicleId'],['owner-date-index','ownerId','date'],['vehicle-date-index','vehicleId','date']],
 Reminders:[['owner-index','ownerId'],['vehicle-index','vehicleId'],['due-index','status','dueDate']],
 Audit:[],
 AuthRateLimits:[]
};
async function main(){
 for(const [name,indices] of Object.entries(specs)){
   const table=tables[name];let existing;try{existing=(await client.send(new DescribeTableCommand({TableName:table}))).Table;}catch(e){if(!['ResourceNotFoundException','ResourceNotFound'].includes(e.name))throw e;}
   if(existing){const present=new Set((existing.GlobalSecondaryIndexes||[]).map(x=>x.IndexName));for(const [indexName,hash,range] of indices.filter(x=>!present.has(x[0]))){console.log('Adding index:',table,indexName);await client.send(new UpdateTableCommand({TableName:table,AttributeDefinitions:[{AttributeName:hash,AttributeType:'S'},...(range&&range!==hash?[{AttributeName:range,AttributeType:'S'}]:[])],GlobalSecondaryIndexUpdates:[{Create:{IndexName:indexName,KeySchema:[{AttributeName:hash,KeyType:'HASH'},...(range?[{AttributeName:range,KeyType:'RANGE'}]:[])],Projection:{ProjectionType:'ALL'}}}]}));let ready=false;for(let attempt=0;attempt<60&&!ready;attempt++){await new Promise(resolve=>setTimeout(resolve,1000));const state=(await client.send(new DescribeTableCommand({TableName:table}))).Table;ready=state.TableStatus==='ACTIVE'&&(state.GlobalSecondaryIndexes||[]).find(x=>x.IndexName===indexName)?.IndexStatus==='ACTIVE';}if(!ready)throw new Error(`Timed out waiting for ${table}/${indexName}`);}console.log('Already exists/reconciled:',table);continue;}
   const attributeNames=new Set(['id']);for(const index of indices){attributeNames.add(index[1]);if(index[2])attributeNames.add(index[2]);}
   const gsis=indices.map(([indexName,hash,range])=>({IndexName:indexName,KeySchema:[{AttributeName:hash,KeyType:'HASH'},...(range?[{AttributeName:range,KeyType:'RANGE'}]:[])],Projection:{ProjectionType:'ALL'}}));
   const request={TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'id',KeyType:'HASH'}],AttributeDefinitions:[...attributeNames].map(AttributeName=>({AttributeName,AttributeType:'S'})),...(gsis.length?{GlobalSecondaryIndexes:gsis}:{})};
   await client.send(new CreateTableCommand(request));console.log('Created:',table);
   try{await waitUntilTableExists({client,maxWaitTime:60},{TableName:table});}catch(e){console.log('Table waiter did not confirm status; verify via Floci dashboard:',table);}
 }
 try{await client.send(new UpdateTimeToLiveCommand({TableName:tables.AuthRateLimits,TimeToLiveSpecification:{Enabled:true,AttributeName:'expiresAt'}}));}catch(error){if(!['ValidationException','UnknownOperationException'].includes(error.name))throw error;console.warn('Floci did not enable TTL; expired limiter windows remain inert and may be cleaned up manually.');}
 console.log('All 8 tables accounted for. No sample credentials or private data inserted.');
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1});
module.exports={specs};

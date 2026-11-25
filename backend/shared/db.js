const {DynamoDBClient}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,GetCommand,PutCommand,UpdateCommand,DeleteCommand,QueryCommand,ScanCommand,BatchWriteCommand}=require('@aws-sdk/lib-dynamodb');
const {awsOptions,tables}=require('./config');
const {missing,forbidden,conflict}=require('./errors');
const client=DynamoDBDocumentClient.from(new DynamoDBClient(awsOptions),{marshallOptions:{removeUndefinedValues:true}});
async function get(table,id){const r=await client.send(new GetCommand({TableName:tables[table],Key:{id}}));return r.Item||null;}
async function put(table,item,unique=false){try{await client.send(new PutCommand({TableName:tables[table],Item:item,...(unique?{ConditionExpression:'attribute_not_exists(id)'}:{})}));return item;}catch(e){if(e.name==='ConditionalCheckFailedException')throw conflict('Record already exists');throw e;}}
async function del(table,id){await client.send(new DeleteCommand({TableName:tables[table],Key:{id}}));}
async function patch(table,id,values){if(!Object.keys(values).length)return get(table,id);const names={},valuesMap={};const changes=Object.entries(values).map(([k,v],i)=>{names[`#k${i}`]=k;valuesMap[`:v${i}`]=v;return `#k${i} = :v${i}`;});try{const r=await client.send(new UpdateCommand({TableName:tables[table],Key:{id},UpdateExpression:`SET ${changes.join(', ')}`,ConditionExpression:'attribute_exists(id)',ExpressionAttributeNames:names,ExpressionAttributeValues:valuesMap,ReturnValues:'ALL_NEW'}));return r.Attributes;}catch(e){if(e.name==='ConditionalCheckFailedException')throw missing();throw e;}}
async function query(table,index,field,value,options={}){
  const {rangeField,from,to,ascending=true,limit,exclusiveStartKey,projection}=options;
  const names={'#pk':field},values={':value':value};let condition='#pk = :value';
  if(rangeField&&(from||to)){
    names['#sk']=rangeField;
    if(from&&to){condition+=' AND #sk BETWEEN :from AND :to';values[':from']=from;values[':to']=to;}
    else if(from){condition+=' AND #sk >= :from';values[':from']=from;}
    else{condition+=' AND #sk <= :to';values[':to']=to;}
  }
  const input={TableName:tables[table],IndexName:index,KeyConditionExpression:condition,ExpressionAttributeNames:names,ExpressionAttributeValues:values,ScanIndexForward:ascending};
  if(projection?.length){input.ProjectionExpression=projection.map((name,i)=>{const key=`#p${i}`;names[key]=name;return key;}).join(', ');}
  if(limit){input.Limit=limit;input.ExclusiveStartKey=exclusiveStartKey;const result=await client.send(new QueryCommand(input));return {items:result.Items||[],lastKey:result.LastEvaluatedKey||null};}
  const all=[];let last=exclusiveStartKey;do{const result=await client.send(new QueryCommand({...input,ExclusiveStartKey:last}));all.push(...(result.Items||[]));last=result.LastEvaluatedKey;if(all.length>(options.hardCap||2500))throw new Error('Too many records to fetch for a single request');}while(last);return all;
}
async function scan(table,{limit=150,exclusiveStartKey}={}){const r=await client.send(new ScanCommand({TableName:tables[table],Limit:limit,ExclusiveStartKey:exclusiveStartKey}));return {items:r.Items||[],lastKey:r.LastEvaluatedKey||null};}
async function scanAll(table,{hardCap=2500}={}){const items=[];let lastKey;do{const page=await scan(table,{limit:Math.min(250,hardCap-items.length),exclusiveStartKey:lastKey});items.push(...page.items);lastKey=page.lastKey;if(lastKey&&items.length>=hardCap){const e=new Error(`The ${table} dataset exceeds the safe reporting limit`);e.status=503;e.code='REPORT_LIMIT_EXCEEDED';throw e;}}while(lastKey);return items;}
async function deleteByOwner(table,ownerId){
  let lastKey,deleted=0;
  do{
    const result=await client.send(new QueryCommand({TableName:tables[table],IndexName:'owner-index',KeyConditionExpression:'#owner = :owner',ExpressionAttributeNames:{'#owner':'ownerId'},ExpressionAttributeValues:{':owner':ownerId},ProjectionExpression:'id, ownerId',ExclusiveStartKey:lastKey,Limit:100}));
    const owned=(result.Items||[]).filter(item=>item.ownerId===ownerId);
    for(let i=0;i<owned.length;i+=25){
      let pending=owned.slice(i,i+25).map(item=>({DeleteRequest:{Key:{id:item.id}}}));
      for(let attempt=0;pending.length&&attempt<8;attempt++){
        const output=await client.send(new BatchWriteCommand({RequestItems:{[tables[table]]:pending}}));
        pending=output.UnprocessedItems?.[tables[table]]||[];
        if(pending.length)await new Promise(resolve=>setTimeout(resolve,Math.min(1000,25*2**attempt)));
      }
      if(pending.length){const error=new Error(`Could not finish deleting ${table} records`);error.code='CLEANUP_INCOMPLETE';error.status=503;throw error;}
      deleted+=Math.min(25,owned.length-i);
    }
    lastKey=result.LastEvaluatedKey;
  }while(lastKey);
  return deleted;
}
async function owned(table,id,sub){const r=await get(table,id);if(!r)throw missing();if(r.ownerId!==sub)throw missing();return r;}
async function ownVehicle(id,sub){return owned('Vehicles',id,sub);}
module.exports={client,get,put,del,patch,query,scan,scanAll,deleteByOwner,owned,ownVehicle};

const test=require('node:test');
const assert=require('node:assert/strict');
const db=require('../backend/shared/db');
const {specs}=require('../scripts/create-tables');

test('range query uses the date sort key, descending order, limit and continuation key',async()=>{
 const original=db.client.send,seen=[];db.client.send=async command=>{seen.push(command.input);return {Items:[{id:'two',date:'2026-02-02'}],LastEvaluatedKey:{id:'two'}};};
 try{const page=await db.query('Fuel','vehicle-date-index','vehicleId','car-1',{rangeField:'date',from:'2026-02-01',to:'2026-02-28',ascending:false,limit:20,exclusiveStartKey:{id:'one'}});assert.deepEqual(page,{items:[{id:'two',date:'2026-02-02'}],lastKey:{id:'two'}});const input=seen[0];assert.equal(input.KeyConditionExpression,'#pk = :value AND #sk BETWEEN :from AND :to');assert.equal(input.ScanIndexForward,false);assert.equal(input.Limit,20);assert.deepEqual(input.ExclusiveStartKey,{id:'one'});}
 finally{db.client.send=original;}
});

test('range query emits only expression aliases and values that its key condition references',async()=>{
 const original=db.client.send,inputs=[];db.client.send=async command=>{inputs.push(command.input);return {Items:[]};};
 const cases=[
  [{},'#pk = :value',{'#pk':'vehicleId'},{':value':'car-1'}],
  [{from:'2026-01-01'},'#pk = :value AND #sk >= :from',{'#pk':'vehicleId','#sk':'date'},{':value':'car-1',':from':'2026-01-01'}],
  [{to:'2026-01-31'},'#pk = :value AND #sk <= :to',{'#pk':'vehicleId','#sk':'date'},{':value':'car-1',':to':'2026-01-31'}],
  [{from:'2026-01-01',to:'2026-01-31'},'#pk = :value AND #sk BETWEEN :from AND :to',{'#pk':'vehicleId','#sk':'date'},{':value':'car-1',':from':'2026-01-01',':to':'2026-01-31'}]
 ];
 try{
  for(const [dates] of cases)await db.query('Maintenance','vehicle-date-index','vehicleId','car-1',{rangeField:'date',...dates,ascending:false,limit:40});
  cases.forEach(([,condition,names,values],i)=>{assert.equal(inputs[i].KeyConditionExpression,condition);assert.deepEqual(inputs[i].ExpressionAttributeNames,names);assert.deepEqual(inputs[i].ExpressionAttributeValues,values);for(const alias of Object.keys(names))assert.match(condition,new RegExp(alias.replace('#','\\#')));for(const alias of Object.keys(values))assert.match(condition,new RegExp(alias));});
 }finally{db.client.send=original;}
});

test('unbounded keyed query paginates and preserves DynamoDB order',async()=>{
 const original=db.client.send;let calls=0;db.client.send=async()=>++calls===1?{Items:[{id:'a'}],LastEvaluatedKey:{id:'a'}}:{Items:[{id:'b'}]};
 try{assert.deepEqual(await db.query('Vehicles','owner-index','ownerId','user-1'),[{id:'a'},{id:'b'}]);assert.equal(calls,2);}finally{db.client.send=original;}
});

test('owned lookup hides missing and cross-user records with the same 404 response',async()=>{
 const original=db.client.send;db.client.send=async()=>({Item:{id:'fuel-1',ownerId:'other-user'}});
 try{await assert.rejects(()=>db.owned('Fuel','fuel-1','user-1'),error=>error.status===404);}finally{db.client.send=original;}
});

test('date indexes required by range access patterns are present in schema',()=>{
 for(const table of ['Maintenance','Fuel','Expenses'])assert.deepEqual(specs[table].filter(x=>x[0].endsWith('-date-index')).map(x=>x[0]),['owner-date-index','vehicle-date-index']);
});

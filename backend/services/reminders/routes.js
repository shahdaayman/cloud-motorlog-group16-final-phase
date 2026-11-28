const express=require('express');
const db=require('../../shared/db');
const {authenticate}=require('../../shared/auth');
const {asyncRoute,bad}=require('../../shared/errors');
const v=require('../../shared/validate');
const {reminderState,monthlyCosts,costSummary,completionRate}=require('../../shared/calc');
const {publishEvent}=require('../../shared/cloud-events');
const {CognitoIdentityProviderClient}=require('@aws-sdk/client-cognito-identity-provider');
const {SQSClient}=require('@aws-sdk/client-sqs');
const {awsOptions}=require('../../shared/config');
const {requestManualTest,publicStatus}=require('./manual-test-email');
const {reminderId,requestKey,verifiedEmail,queueConfirmation}=require('./confirmation');
const r=express.Router();r.use(authenticate);
r.testEmailDependencies={store:db,idp:new CognitoIdentityProviderClient(awsOptions),sqs:new SQSClient(awsOptions)};
const now=()=>new Date().toISOString();
function parseReminder(body,partial=false){v.assertFields(body,['title','dueDate','dueMileageKm','notes','status']);const o={};
  if(!partial||body.title!==undefined)o.title=v.str(body.title,'title',3,100);
  if(body.dueDate!==undefined)o.dueDate=body.dueDate?v.date(body.dueDate,'dueDate'):'9999-12-31';
  if(body.dueMileageKm!==undefined)o.dueMileageKm=body.dueMileageKm===null?null:v.number(body.dueMileageKm,'dueMileageKm',0,5e7);
  if(body.notes!==undefined)o.notes=v.optionalStr(body.notes,'notes',400);
  if(body.status!==undefined)o.status=v.enumValue(body.status,'status',['Open','Completed']);
  if(!partial&&!body.dueDate&&body.dueMileageKm==null)throw bad('Reminder requires a due date and/or target mileage');return o;
}
r.post('/vehicles/:vehicleId/reminders',asyncRoute(async(req,res)=>{const vehicle=await db.ownVehicle(req.params.vehicleId,req.user.sub),key=requestKey(req),email=await verifiedEmail(r.testEmailDependencies.idp,req.user),id=reminderId(req.user.sub,vehicle.id,key);let item=await db.get('Reminders',id),created=false;if(item){if(item.ownerId!==req.user.sub||item.vehicleId!==vehicle.id||item.creationRequestKey!==key)throw bad('Invalid reminder retry');}else{item={id,ownerId:req.user.sub,vehicleId:vehicle.id,status:'Open',dueDate:'9999-12-31',...parseReminder(req.body),createdAt:now(),creationRequestKey:key,confirmationEmailStatus:'PENDING_QUEUE'};await db.put('Reminders',item,true);created=true;}const confirmation=await queueConfirmation({store:db,sqs:r.testEmailDependencies.sqs,queueUrl:process.env.NOTIFICATION_QUEUE_URL,reminder:item,email,key});const output={...item,confirmationEmailStatus:confirmation.queued?'QUEUED':'PENDING_QUEUE',confirmationQueued:confirmation.queued,retryable:!confirmation.queued};res.status(confirmation.queued&&created?201:202).json(output);}));
r.get('/reminders',asyncRoute(async(req,res)=>{
  const all=await db.query('Reminders','owner-index','ownerId',req.user.sub);const vehicles=await db.query('Vehicles','owner-index','ownerId',req.user.sub);const current=new Map(vehicles.map(c=>[c.id,c]));
  const status=String(req.query.status||'all');if(!['all','due','upcoming','completed'].includes(status))throw bad('Invalid status filter');
  const items=all.map(r=>({...r,state:reminderState(r,current.get(r.vehicleId)?.mileageKm||0),vehicleName:current.get(r.vehicleId)?.nickname||'Vehicle'})).filter(r=>status==='all'||r.state.toLowerCase()===status).sort((a,b)=>a.dueDate.localeCompare(b.dueDate)).slice(0,v.boundedQuery(req));res.json({items});
}));
r.patch('/reminders/:id',asyncRoute(async(req,res)=>{
  const item=await db.owned('Reminders',req.params.id,req.user.sub);const patch=parseReminder(req.body,true);
  if(!Object.keys(patch).length)throw bad('No fields supplied');
  const next={...item,...patch};if(next.dueDate==='9999-12-31'&&next.dueMileageKm==null)throw bad('Reminder requires a due date or mileage');
  if(patch.status==='Completed')patch.completedAt=now();
  if(patch.status==='Open')patch.completedAt=null;
  const updated=await db.patch('Reminders',item.id,patch);if(patch.status==='Completed')void publishEvent('ReminderCompleted',{reminderId:item.id,vehicleId:item.vehicleId,occurredAt:patch.completedAt});res.json(updated);
}));
r.delete('/reminders/:id',asyncRoute(async(req,res)=>{await db.owned('Reminders',req.params.id,req.user.sub);await db.del('Reminders',req.params.id);res.status(204).end();}));
r.post('/reminders/:id/test-email',asyncRoute(async(req,res)=>{const result=await requestManualTest({reminderId:req.params.id,user:req.user,queueUrl:process.env.NOTIFICATION_QUEUE_URL,...r.testEmailDependencies});res.status(202).json(result);}));
r.get('/reminders/:id/test-email-status',asyncRoute(async(req,res)=>{const reminder=await db.owned('Reminders',req.params.id,req.user.sub);res.json(publicStatus(reminder));}));
async function ownerData(sub){const [cars,fuel,expenses,maintenance,reminders]=await Promise.all(['Vehicles','Fuel','Expenses','Maintenance','Reminders'].map(t=>db.query(t,'owner-index','ownerId',sub)));return {cars,fuel,expenses,maintenance,reminders};}
r.get('/analytics/summary',asyncRoute(async(req,res)=>{
  const data=await ownerData(req.user.sub);const total=costSummary(data);const mileageById=new Map(data.cars.map(c=>[c.id,c.mileageKm]));
  const due=data.reminders.filter(r=>reminderState(r,mileageById.get(r.vehicleId)||0)==='Due').length;
  res.json({vehicles:data.cars.length,maintenanceRecords:data.maintenance.length,fuelEntries:data.fuel.length,expenses:data.expenses.length,totalCost:total.grandTotal,costs:total,reminders:{total:data.reminders.length,due,completed:data.reminders.filter(r=>r.status==='Completed').length,completionRate:completionRate(data.reminders)}});
}));
r.get('/analytics/monthly',asyncRoute(async(req,res)=>{const months=v.integer(Number(req.query.months||6),'months',1,12),asOf=new Date(),from=new Date(Date.UTC(asOf.getUTCFullYear(),asOf.getUTCMonth()-months+1,1)).toISOString().slice(0,10),to=new Date(Date.UTC(asOf.getUTCFullYear(),asOf.getUTCMonth()+1,0)).toISOString().slice(0,10);const [fuel,expenses,maintenance]=await Promise.all(['Fuel','Expenses','Maintenance'].map(t=>db.query(t,'owner-date-index','ownerId',req.user.sub,{rangeField:'date',from,to})));res.json({items:monthlyCosts({fuel,expenses,maintenance},months,asOf)});}));
r.get('/analytics/maintenance',asyncRoute(async(req,res)=>{
  const data=await ownerData(req.user.sub);const typeTotals={};for(const row of data.maintenance){if(!typeTotals[row.type])typeTotals[row.type]={count:0,cost:0};typeTotals[row.type].count++;typeTotals[row.type].cost=v.money(typeTotals[row.type].cost+row.cost);}
  res.json({totalRecords:data.maintenance.length,totalMaintenanceCost:v.money(data.maintenance.reduce((a,r)=>a+r.cost,0)),byType:typeTotals,completedReminders:data.reminders.filter(x=>x.status==='Completed').length,reminderCompletionRate:completionRate(data.reminders)});
}));
module.exports=r;

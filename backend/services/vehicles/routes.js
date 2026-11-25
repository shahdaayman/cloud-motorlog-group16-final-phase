const express=require('express');
const {randomUUID}=require('node:crypto');
const db=require('../../shared/db');
const {authenticate,adminOnly}=require('../../shared/auth');
const {asyncRoute,bad,missing,conflict}=require('../../shared/errors');
const v=require('../../shared/validate');
const authRoutes=require('./auth-routes');
const {decodeVin}=require('./vin-decoder');
const {publishEvent,publishNotification}=require('../../shared/cloud-events');
const r=express.Router();
r.use(authRoutes);r.use(authenticate);
const now=()=>new Date().toISOString();
function parseVehicle(body,partial=false){
  v.assertFields(body,['nickname','make','model','year','vin','mileageKm']);
  const out={};
  if(!partial||body.nickname!==undefined)out.nickname=v.str(body.nickname,'nickname',2,50);
  if(!partial||body.make!==undefined)out.make=v.str(body.make,'Brand',1,60);
  if(!partial||body.model!==undefined)out.model=v.str(body.model,'model',1,60);
  if(!partial||body.year!==undefined)out.year=v.integer(body.year,'year',1950,new Date().getUTCFullYear()+2);
  if(body.vin!==undefined)out.vin=body.vin?v.vin(body.vin):'';
  if(!partial||body.mileageKm!==undefined)out.mileageKm=v.number(body.mileageKm,'mileageKm',0,5e7);
  return out;
}
function parseMaintenance(b,partial=false){v.assertFields(b,['type','date','mileageKm','cost','notes']);const out={};
  if(!partial||b.type!==undefined)out.type=v.enumValue(b.type,'type',['Oil Change','Tires','Brakes','Inspection','Battery','Repair','Other']);
  if(!partial||b.date!==undefined)out.date=v.date(b.date);
  if(!partial||b.mileageKm!==undefined)out.mileageKm=v.number(b.mileageKm,'mileageKm',0,5e7);
  if(!partial||b.cost!==undefined)out.cost=v.money(v.number(b.cost,'cost',0,1e9));
  if(!partial||b.notes!==undefined)out.notes=v.optionalStr(b.notes,'notes',600);return out;
}
async function audit(actor,action,target,result){try{await db.put('Audit',{id:randomUUID(),actorId:actor,action,target,result,createdAt:now()});}catch(e){console.error('audit-write-failed',e.name);}}
r.get('/vehicles',asyncRoute(async(req,res)=>{
  const data=await db.query('Vehicles','owner-index','ownerId',req.user.sub);const text=String(req.query.search||'').toLowerCase().slice(0,60);
  res.json({items:data.filter(x=>!text||[x.nickname,x.make,x.model,x.vin].some(y=>String(y||'').toLowerCase().includes(text))).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,v.boundedQuery(req))});
}));
r.post('/vehicles',asyncRoute(async(req,res)=>{const input=parseVehicle(req.body);const item={id:randomUUID(),ownerId:req.user.sub,...input,createdAt:now(),updatedAt:now()};await db.put('Vehicles',item,true);void publishEvent('VehicleCreated',{vehicleId:item.id,occurredAt:item.createdAt});res.status(201).json(item);}));
r.post('/vehicles/decode-vin',asyncRoute(async(req,res)=>{
  const vin=v.vin(req.body?.vin);
  res.json(await decodeVin(vin));
}));
r.get('/vehicles/:id',asyncRoute(async(req,res)=>res.json(await db.ownVehicle(req.params.id,req.user.sub))));
r.patch('/vehicles/:id',asyncRoute(async(req,res)=>{const item=await db.ownVehicle(req.params.id,req.user.sub);const input=parseVehicle(req.body,true);if(input.mileageKm!=null&&input.mileageKm<item.mileageKm)throw bad('Odometer cannot decrease');res.json(await db.patch('Vehicles',item.id,{...input,updatedAt:now()}));}));
r.delete('/vehicles/:id',asyncRoute(async(req,res)=>{
  const vehicle=await db.ownVehicle(req.params.id,req.user.sub);
  for(const table of ['Maintenance','Fuel','Expenses','Reminders']){const children=await db.query(table,'vehicle-index','vehicleId',vehicle.id,{hardCap:2500});if(children.length)throw conflict(`Delete the vehicle's ${table.toLowerCase()} records first`);}
  await db.del('Vehicles',vehicle.id);res.status(204).end();
}));
r.get('/vehicles/:vehicleId/maintenance',asyncRoute(async(req,res)=>{await db.ownVehicle(req.params.vehicleId,req.user.sub);const {from,to}=v.dateRange(req.query);const result=await db.query('Maintenance','vehicle-date-index','vehicleId',req.params.vehicleId,{rangeField:'date',from,to,ascending:false,limit:v.boundedQuery(req),exclusiveStartKey:v.parsePageToken(req.query.page)});res.json({items:result.items.filter(x=>x.ownerId===req.user.sub),nextPage:v.pageToken(result.lastKey)});}));
r.post('/vehicles/:vehicleId/maintenance',asyncRoute(async(req,res)=>{
  const car=await db.ownVehicle(req.params.vehicleId,req.user.sub);const item={id:randomUUID(),vehicleId:car.id,ownerId:req.user.sub,...parseMaintenance(req.body),createdAt:now()};await db.put('Maintenance',item,true);void publishEvent('MaintenanceAdded',{maintenanceId:item.id,vehicleId:car.id,occurredAt:item.createdAt});void publishNotification('Maintenance record created',{maintenanceId:item.id,vehicleId:car.id});res.status(201).json(item);
}));
r.patch('/maintenance/:id',asyncRoute(async(req,res)=>{await db.owned('Maintenance',req.params.id,req.user.sub);res.json(await db.patch('Maintenance',req.params.id,parseMaintenance(req.body,true)));}));
r.delete('/maintenance/:id',asyncRoute(async(req,res)=>{await db.owned('Maintenance',req.params.id,req.user.sub);await db.del('Maintenance',req.params.id);res.status(204).end();}));
r.use('/admin',adminOnly,require('./admin-routes'));
module.exports=r;

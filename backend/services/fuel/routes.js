const express=require('express');
const {randomUUID}=require('node:crypto');
const db=require('../../shared/db');
const {authenticate}=require('../../shared/auth');
const {asyncRoute,bad}=require('../../shared/errors');
const v=require('../../shared/validate');
const {fuelEconomy,costSummary}=require('../../shared/calc');
const r=express.Router();r.use(authenticate);
const timestamp=()=>new Date().toISOString();
const categories=['Insurance','Registration','Parking','Tolls','Car Wash','Accessories','Other'];
function fuelInput(b,partial=false){v.assertFields(b,['date','litres','totalCost','odometerKm','fullTank','station','notes']);const o={};
  if(!partial||b.date!==undefined)o.date=v.date(b.date);
  if(!partial||b.litres!==undefined)o.litres=v.number(b.litres,'litres',0.01,1000);
  if(!partial||b.totalCost!==undefined)o.totalCost=v.money(v.number(b.totalCost,'totalCost',0.01,1e9));
  if(!partial||b.odometerKm!==undefined)o.odometerKm=v.number(b.odometerKm,'odometerKm',0,5e7);
  if(!partial||b.fullTank!==undefined)o.fullTank=v.boolean(b.fullTank,'fullTank');
  if(b.station!==undefined)o.station=v.optionalStr(b.station,'station',80);
  if(b.notes!==undefined)o.notes=v.optionalStr(b.notes,'notes',300);return o;
}
function expenseInput(b,partial=false){v.assertFields(b,['date','amount','category','notes']);const o={};
  if(!partial||b.date!==undefined)o.date=v.date(b.date);
  if(!partial||b.amount!==undefined)o.amount=v.money(v.number(b.amount,'amount',0.01,1e9));
  if(!partial||b.category!==undefined)o.category=v.enumValue(b.category,'category',categories);
  if(b.notes!==undefined)o.notes=v.optionalStr(b.notes,'notes',300);return o;
}
async function listCar(table,vehicleId,ownerId,query=null){await db.ownVehicle(vehicleId,ownerId);if(query){const {from,to}=v.dateRange(query);const result=await db.query(table,'vehicle-date-index','vehicleId',vehicleId,{rangeField:'date',from,to,ascending:false,limit:v.boundedQuery({query}),exclusiveStartKey:v.parsePageToken(query.page)});return {items:result.items.filter(x=>x.ownerId===ownerId),nextPage:v.pageToken(result.lastKey)};}const all=await db.query(table,'vehicle-index','vehicleId',vehicleId);return all.filter(x=>x.ownerId===ownerId);}
r.get('/vehicles/:vehicleId/fuel',asyncRoute(async(req,res)=>res.json(await listCar('Fuel',req.params.vehicleId,req.user.sub,req.query))));
r.post('/vehicles/:vehicleId/fuel',asyncRoute(async(req,res)=>{
  const vehicle=await db.ownVehicle(req.params.vehicleId,req.user.sub);const data=fuelInput(req.body);const existing=await db.query('Fuel','vehicle-index','vehicleId',vehicle.id);
  if(existing.some(x=>x.odometerKm>data.odometerKm && x.date<=data.date))throw bad('Odometer reading cannot decrease over time');
  const item={id:randomUUID(),vehicleId:vehicle.id,ownerId:req.user.sub,...data,createdAt:timestamp()};await db.put('Fuel',item,true);
  if(data.odometerKm>vehicle.mileageKm)await db.patch('Vehicles',vehicle.id,{mileageKm:data.odometerKm,updatedAt:timestamp()});res.status(201).json(item);
}));
r.patch('/fuel/:id',asyncRoute(async(req,res)=>{await db.owned('Fuel',req.params.id,req.user.sub);const updated=await db.patch('Fuel',req.params.id,fuelInput(req.body,true));res.json(updated);}));
r.delete('/fuel/:id',asyncRoute(async(req,res)=>{await db.owned('Fuel',req.params.id,req.user.sub);await db.del('Fuel',req.params.id);res.status(204).end();}));
r.get('/vehicles/:vehicleId/expenses',asyncRoute(async(req,res)=>{const page=await listCar('Expenses',req.params.vehicleId,req.user.sub,req.query),category=req.query.category?String(req.query.category):null;res.json({...page,items:category?page.items.filter(x=>x.category===category):page.items});}));
r.post('/vehicles/:vehicleId/expenses',asyncRoute(async(req,res)=>{await db.ownVehicle(req.params.vehicleId,req.user.sub);const item={id:randomUUID(),vehicleId:req.params.vehicleId,ownerId:req.user.sub,...expenseInput(req.body),createdAt:timestamp()};await db.put('Expenses',item,true);res.status(201).json(item);}));
r.patch('/expenses/:id',asyncRoute(async(req,res)=>{await db.owned('Expenses',req.params.id,req.user.sub);res.json(await db.patch('Expenses',req.params.id,expenseInput(req.body,true)));}));
r.delete('/expenses/:id',asyncRoute(async(req,res)=>{await db.owned('Expenses',req.params.id,req.user.sub);await db.del('Expenses',req.params.id);res.status(204).end();}));
r.get('/vehicles/:vehicleId/fuel-economy',asyncRoute(async(req,res)=>{const entries=await listCar('Fuel',req.params.vehicleId,req.user.sub);res.json(fuelEconomy(entries));}));
r.get('/vehicles/:vehicleId/costs',asyncRoute(async(req,res)=>{
  await db.ownVehicle(req.params.vehicleId,req.user.sub);const {from,to}=v.dateRange(req.query);
  const [fuel,expenses,maintenance]=await Promise.all(['Fuel','Expenses','Maintenance'].map(t=>db.query(t,'vehicle-date-index','vehicleId',req.params.vehicleId,{rangeField:'date',from,to})));
  res.json(costSummary({fuel:fuel.filter(x=>x.ownerId===req.user.sub),expenses:expenses.filter(x=>x.ownerId===req.user.sub),maintenance:maintenance.filter(x=>x.ownerId===req.user.sub)},from,to));
}));
module.exports=r;

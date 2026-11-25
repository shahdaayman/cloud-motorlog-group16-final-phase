const {money}=require('./validate');
function eligible(records,from,to){return records.filter(r=>(!from||r.date>=from)&&(!to||r.date<=to));}
function fuelEconomy(records){
  const sorted=records.filter(r=>Number.isFinite(r.odometerKm)&&r.litres>0).sort((a,b)=>a.odometerKm-b.odometerKm || String(a.date).localeCompare(String(b.date)));
  let lastFull=null, litres=0, distance=0, intervalCount=0; const intervals=[];
  for(const entry of sorted){
    if(lastFull){litres+=entry.litres;
      if(entry.fullTank){const km=entry.odometerKm-lastFull.odometerKm;if(km>0){distance+=km;intervals.push({fromKm:lastFull.odometerKm,toKm:entry.odometerKm,distanceKm:km,litres:money(litres),litresPer100Km:money(litres/km*100)});intervalCount++;}lastFull=entry;litres=0;}
    } else if(entry.fullTank) lastFull=entry;
  }
  return {hasEnoughData:intervalCount>0,intervals,intervalCount,distanceKm:distance,litresConsumed:money(intervals.reduce((s,i)=>s+i.litres,0)),litresPer100Km:distance>0?money(intervals.reduce((s,i)=>s+i.litres,0)/distance*100):null,method:'Full-tank to full-tank; partial refills between full tanks are included'};
}
function costSummary({fuel=[],expenses=[],maintenance=[]},from=null,to=null){
  const f=eligible(fuel,from,to), e=eligible(expenses,from,to), m=eligible(maintenance,from,to);
  const sum=(items,key)=>money(items.reduce((a,r)=>a+(Number(r[key])||0),0));
  const fuelTotal=sum(f,'totalCost'),expensesTotal=sum(e,'amount'),maintenanceTotal=sum(m,'cost');
  return {from,to,fuelTotal,expensesTotal,maintenanceTotal,grandTotal:money(fuelTotal+expensesTotal+maintenanceTotal),counts:{fuel:f.length,expenses:e.length,maintenance:m.length}};
}
function monthlyCosts(data,months=6,asOf=new Date()){
  const out=[]; const year=asOf.getUTCFullYear(), month=asOf.getUTCMonth();
  for(let i=months-1;i>=0;i--){const start=new Date(Date.UTC(year,month-i,1)).toISOString().slice(0,10);const end=new Date(Date.UTC(year,month-i+1,0)).toISOString().slice(0,10);out.push({month:start.slice(0,7),...costSummary(data,start,end)});}
  return out;
}
function reminderState(reminder,currentMileageKm=0,today=new Date().toISOString().slice(0,10)){
  if(reminder.status==='Completed')return 'Completed';
  const dateDue=!!reminder.dueDate && reminder.dueDate<='9998-12-31' && reminder.dueDate<=today;
  const kmDue=reminder.dueMileageKm!=null&&currentMileageKm>=reminder.dueMileageKm;
  return dateDue||kmDue?'Due':'Upcoming';
}
function completionRate(reminders){if(!reminders.length)return 0;return money(100*reminders.filter(r=>r.status==='Completed').length/reminders.length);}
module.exports={fuelEconomy,costSummary,monthlyCosts,reminderState,completionRate};

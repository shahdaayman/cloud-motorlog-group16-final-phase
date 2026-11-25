const test=require('node:test');const assert=require('node:assert/strict');
const {fuelEconomy,costSummary,monthlyCosts,reminderState,completionRate}=require('../backend/shared/calc');
test('Fuel economy uses full-tank intervals and includes intermediate partial fills',()=>{
 const e=fuelEconomy([
 {date:'2026-01-01',odometerKm:1000,litres:30,fullTank:true},
 {date:'2026-01-09',odometerKm:1300,litres:15,fullTank:false},
 {date:'2026-01-15',odometerKm:1500,litres:25,fullTank:true}]);
 assert.equal(e.hasEnoughData,true);assert.equal(e.distanceKm,500);assert.equal(e.litresConsumed,40);assert.equal(e.litresPer100Km,8);
});
test('Fuel economy cannot be calculated from a single reading',()=>{
 const e=fuelEconomy([{odometerKm:1400,litres:20,fullTank:true}]);assert.equal(e.litresPer100Km,null);assert.equal(e.hasEnoughData,false);
});
test('Fuel economy ignores zero-distance refills',()=>{
 const e=fuelEconomy([{odometerKm:1000,litres:20,fullTank:true},{odometerKm:1000,litres:15,fullTank:true}]);assert.equal(e.hasEnoughData,false);
});
test('Costs sum three service categories without rounding drift',()=>{
 const data={fuel:[{date:'2026-01-01',totalCost:10.10},{date:'2026-02-10',totalCost:12.2}],expenses:[{date:'2026-01-08',amount:2.1}],maintenance:[{date:'2026-01-22',cost:4.5}]};
 assert.deepEqual(costSummary(data,'2026-01-01','2026-01-31'),{from:'2026-01-01',to:'2026-01-31',fuelTotal:10.1,expensesTotal:2.1,maintenanceTotal:4.5,grandTotal:16.7,counts:{fuel:1,expenses:1,maintenance:1}});
 assert.equal(costSummary(data).grandTotal,28.9);
});
test('Monthly summaries contain requested months and real costs',()=>{
 const data={fuel:[{date:'2026-01-12',totalCost:100},{date:'2026-02-12',totalCost:120}],expenses:[],maintenance:[]};
 const values=monthlyCosts(data,2,new Date('2026-02-28T00:00:00Z'));assert.deepEqual(values.map(x=>[x.month,x.grandTotal]),[['2026-01',100],['2026-02',120]]);
});
test('Reminders can be due by date, mileage, or completed',()=>{
 assert.equal(reminderState({dueDate:'2026-01-01',status:'Open'},0,'2026-01-02'),'Due');
 assert.equal(reminderState({dueDate:'9999-12-31',dueMileageKm:15000,status:'Open'},15500,'2026-01-02'),'Due');
 assert.equal(reminderState({dueDate:'9999-12-31',dueMileageKm:15000,status:'Open'},14000,'2026-01-02'),'Upcoming');
 assert.equal(reminderState({dueDate:'2026-01-01',status:'Completed'},100,'2026-01-02'),'Completed');
 assert.equal(completionRate([{status:'Open'},{status:'Completed'},{status:'Completed'}]),66.67);
 assert.equal(completionRate([]),0);
});

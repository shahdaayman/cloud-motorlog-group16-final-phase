const test=require('node:test');
const assert=require('node:assert/strict');
const {decodeVin,endpoint}=require('../backend/services/vehicles/vin-decoder');
const validate=require('../backend/shared/validate');
const validVin='1HGCM82633A004352';

test('valid NHTSA response produces vehicle fields using the official endpoint',async()=>{
 let requested;const result=await decodeVin(validVin,{fetchImpl:async(url,options)=>{requested={url,options};return {ok:true,json:async()=>({Results:[{Make:'HONDA',Model:'Accord',ModelYear:'2003',Manufacturer:'AMERICAN HONDA MOTOR CO., INC.',ErrorText:'0 - VIN decoded clean.'}]})};}});
 assert.equal(requested.url,`${endpoint}/${validVin}?format=json`);assert.equal(requested.options.headers.Accept,'application/json');assert.deepEqual({make:result.make,model:result.model,year:result.year},{make:'HONDA',model:'Accord',year:2003});assert.equal(result.source,'NHTSA vPIC');
});

test('NHTSA timeout returns useful 504 feedback without crashing',async()=>{
 const timeout=Object.assign(new Error('timed out'),{name:'TimeoutError'});
 await assert.rejects(()=>decodeVin(validVin,{fetchImpl:async()=>{throw timeout;}}),error=>error.status===504&&error.code==='VIN_SERVICE_TIMEOUT'&&/manually/i.test(error.message));
});

test('NHTSA HTTP and malformed response errors return safe gateway failures',async()=>{
 await assert.rejects(()=>decodeVin(validVin,{fetchImpl:async()=>({ok:false,status:503})}),error=>error.status===502&&error.code==='VIN_SERVICE_ERROR');
 await assert.rejects(()=>decodeVin(validVin,{fetchImpl:async()=>({ok:true,json:async()=>({unexpected:true})})}),error=>error.status===502&&error.code==='VIN_SERVICE_INVALID_RESPONSE');
});

test('network failure preserves manual-entry fallback guidance',async()=>{
 await assert.rejects(()=>decodeVin(validVin,{fetchImpl:async()=>{throw new Error('ECONNREFUSED');}}),error=>error.status===502&&error.code==='VIN_SERVICE_UNAVAILABLE'&&/Enter vehicle details manually/.test(error.message));
});

test('invalid VIN is rejected before any external request',()=>{assert.throws(()=>validate.vin('1HGCM82633AOO4352'),/VIN must have 17 characters/);});

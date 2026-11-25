const {HttpError}=require('../../shared/errors');
const endpoint='https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues';
function serviceError(status,code,message){return new HttpError(status,code,message);}
async function decodeVin(vin,{fetchImpl=globalThis.fetch,timeoutMs=8000}={}){let response;try{response=await fetchImpl(`${endpoint}/${encodeURIComponent(vin)}?format=json`,{signal:AbortSignal.timeout(timeoutMs),headers:{Accept:'application/json'}});}catch(error){if(error?.name==='TimeoutError'||error?.name==='AbortError')throw serviceError(504,'VIN_SERVICE_TIMEOUT','VIN service timed out. Enter vehicle details manually or try again.');throw serviceError(502,'VIN_SERVICE_UNAVAILABLE','VIN service is temporarily unavailable. Enter vehicle details manually.');}
 if(!response?.ok)throw serviceError(502,'VIN_SERVICE_ERROR',`VIN service returned an error${response?.status?` (${response.status})`:''}. Enter vehicle details manually.`);
 let body;try{body=await response.json();}catch{throw serviceError(502,'VIN_SERVICE_INVALID_RESPONSE','VIN service returned an invalid response. Enter vehicle details manually.');}
 const result=body?.Results?.[0];if(!result)throw serviceError(502,'VIN_SERVICE_INVALID_RESPONSE','VIN decoder returned no vehicle record. Enter vehicle details manually.');
 return {vin,make:String(result.Make||'').slice(0,60),model:String(result.Model||'').slice(0,60),year:Number(result.ModelYear)||null,manufacturer:String(result.Manufacturer||'').slice(0,100),warning:String(result.ErrorText||'').slice(0,180),source:'NHTSA vPIC'};
}
module.exports={decodeVin,endpoint};

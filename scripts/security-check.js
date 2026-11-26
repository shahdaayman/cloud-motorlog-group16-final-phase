/** Controlled BOLA/role checks against your own running local app.
 * Set TEST_TOKEN_USER_A, TEST_TOKEN_USER_B, TEST_VEHICLE_A, TEST_REMINDER_A in an ignored environment.
 * Never paste access tokens in project documents, screenshots, log files or the terminal history. */
require('dotenv').config();
const base=process.env.SMOKE_BASE_URL||'http://localhost:3000';
(async()=>{
 const a=process.env.TEST_TOKEN_USER_A,b=process.env.TEST_TOKEN_USER_B,id=process.env.TEST_VEHICLE_A;
 if(!a||!b||!id)throw new Error('Set TEST_TOKEN_USER_A, TEST_TOKEN_USER_B and TEST_VEHICLE_A in .env (never commit)');
 async function call(path,token,method='GET',body){return fetch(`${base}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
 const good=await call(`/api/vehicles/${id}`,a);const denied=await call(`/api/vehicles/${id}`,b);const deniedUpdate=await call(`/api/vehicles/${id}`,b,'PATCH',{nickname:'Unauthorized edit'});const nonAdmin=await call('/api/admin/users',b);
 const checks={ownerRead:good.status===200,crossUserReadDenied:denied.status===404,crossUserWriteDenied:deniedUpdate.status===404,nonAdminDenied:nonAdmin.status===403};console.log(checks);if(!Object.values(checks).every(Boolean))process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1});

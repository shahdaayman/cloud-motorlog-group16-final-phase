/** Safe read-only smoke checks, requires a running local backend. */
require('dotenv').config();
const base=process.env.SMOKE_BASE_URL||'http://localhost:3000';
(async()=>{
 const res=await fetch(`${base}/api/health`);const body=await res.json();if(res.status!==200||body.status!=='ok')throw new Error('Health check failed');
 const auth=await fetch(`${base}/api/vehicles`);if(auth.status!==401)throw new Error(`Missing-token security check expected 401, received ${auth.status}`);
 const admin=await fetch(`${base}/api/admin/users`);if(admin.status!==401)throw new Error(`Admin unauthenticated check expected 401, received ${admin.status}`);
 console.log('PASS health','PASS vehicles protected','PASS admin protected');
})().catch(e=>{console.error(e);process.exitCode=1});

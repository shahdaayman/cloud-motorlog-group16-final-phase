const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const cors=require('cors');
const {createAuthRateLimiter,opaqueKey,shouldRateLimitAuthRequest}=require('../backend/services/vehicles/auth-rate-limit');

function harness(start=0){
  let time=start;const buckets=new Map();
  const consumeAttempt=async({id,limit,windowMs,now})=>{const windowStart=Math.floor(now/windowMs)*windowMs,key=`${id}:${windowStart}`,count=(buckets.get(key)||0)+1;buckets.set(key,count);return {allowed:count<=limit,count:Math.min(count,limit),resetAt:windowStart+windowMs};};
  const limiter=createAuthRateLimiter({secret:'test-only-secret',consumeAttempt,now:()=>time});
  async function request(email,path='/login',origin='http://localhost:3000'){const headers={};let status=200,body;await limiter({body:{email},path,headers:{origin}},{setHeader:(k,v)=>headers[k]=v,status:n=>{status=n;return{json:value=>body=value};}},()=>{});return{status,headers,body};}
  return{request,advance:ms=>time+=ms};
}

test('normal users, administrators and browser origins do not share unrelated account buckets',async()=>{const h=harness();for(let i=0;i<20;i++)assert.equal((await h.request('user@example.com','/login',i%2?'http://localhost:3000':'http://example.cloudfront')).status,200);assert.equal((await h.request('user@example.com')).status,429);assert.equal((await h.request('admin@example.com')).status,200);});
test('repeated attempts return Retry-After and cooldown expiry opens the account bucket',async()=>{const h=harness();for(let i=0;i<20;i++)await h.request('user@example.com');const blocked=await h.request('user@example.com');assert.equal(blocked.status,429);assert.equal(blocked.headers['Retry-After'],'900');assert.equal(blocked.body.error.retryAfter,900);h.advance(900001);assert.equal((await h.request('user@example.com')).status,200);});
test('OTP has a separate tighter bucket on the deployed auth path and keys are opaque stable HMACs',async()=>{const h=harness();for(let i=0;i<10;i++)assert.equal((await h.request('Admin@Example.com','/auth/verify-otp')).status,200);assert.equal((await h.request('admin@example.com','/auth/verify-otp')).status,429);assert.notEqual(opaqueKey('secret','account:/login','user@example.com'),'user@example.com');});
test('429 responses retain exact-origin CORS and do not use client IP headers',async()=>{const origin='http://example.cloudfront.local';const limiter=createAuthRateLimiter({secret:'test-only-secret',consumeAttempt:async({limit,now,windowMs})=>({allowed:false,count:limit,resetAt:now+windowMs}),now:()=>0});const app=express();app.use(cors({origin}));app.use(express.json());app.post('/login',limiter,()=>{});const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});try{const response=await fetch(`http://127.0.0.1:${server.address().port}/login`,{method:'POST',headers:{origin,'content-type':'application/json','x-forwarded-for':'203.0.113.4'},body:JSON.stringify({email:'user@example.com'})});assert.equal(response.status,429);assert.equal(response.headers.get('access-control-allow-origin'),origin);assert.equal(response.headers.get('retry-after'),'900');}finally{await new Promise(resolve=>server.close(resolve));}});
test('implementation never trusts forwarded client IP headers',()=>{const source=require('node:fs').readFileSync(require.resolve('../backend/services/vehicles/auth-rate-limit'),'utf8');assert.doesNotMatch(source,/x-forwarded-for|req\.ip|forwarded/i);});

test('only unauthenticated authentication operations consume auth limiter buckets',()=>{
  for(const path of ['/auth/register','/auth/confirm','/auth/resend-confirmation','/auth/login','/auth/verify-otp','/auth/forgot-password','/auth/reset-password'])assert.equal(shouldRateLimitAuthRequest({method:'POST',path}),true,path);
  for(const [method,path] of [['GET','/api/vehicles'],['GET','/vehicles'],['GET','/reminders'],['GET','/analytics/summary'],['GET','/analytics/monthly'],['GET','/vehicles/car-1/fuel'],['GET','/admin/overview'],['GET','/admin/users'],['POST','/auth/logout'],['DELETE','/auth/account']])assert.equal(shouldRateLimitAuthRequest({method,path}),false,path);
  assert.equal(shouldRateLimitAuthRequest({method:'GET',path:'/auth/login'}),false);
});

test('global authentication circuit breaker remains independent and enforced',async()=>{
  let time=0;const buckets=new Map();
  const consumeAttempt=async({id,limit,windowMs,now})=>{const key=`${id}:${Math.floor(now/windowMs)*windowMs}`,count=(buckets.get(key)||0)+1;buckets.set(key,count);return{allowed:count<=limit,count:Math.min(count,limit),resetAt:Math.floor(now/windowMs)*windowMs+windowMs};};
  const limiter=createAuthRateLimiter({secret:'global-breaker-test',consumeAttempt,now:()=>time});
  const request=async email=>{let status=200;await limiter({body:{email},path:'/login'},{setHeader(){},status(value){status=value;return{json(){}};}},()=>{});return status;};
  for(let i=0;i<500;i++)assert.equal(await request(`user-${i}@example.com`),200);
  assert.equal(await request('next-user@example.com'),429);
});

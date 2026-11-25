const test=require('node:test');
const assert=require('node:assert/strict');
const {apiRateLimit}=require('../backend/shared/rate-limit');
function response(){return {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
test('general API limiter returns 429 without trusting forwarded headers',()=>{
  let time=1000;const middleware=apiRateLimit({windowMs:60000,max:2,now:()=>time});
  const request={path:'/api/vehicles',method:'GET',ip:'127.0.0.1',headers:{'x-forwarded-for':'203.0.113.99'}};
  for(let attempt=1;attempt<=2;attempt++){const res=response();let next=false;middleware(request,res,()=>{next=true;});assert.equal(next,true);assert.equal(res.statusCode,200);}
  const blocked=response();middleware(request,blocked,()=>assert.fail('blocked request called next'));assert.equal(blocked.statusCode,429);assert.equal(blocked.body.error.code,'RATE_LIMIT');assert.ok(blocked.headers['Retry-After']);
});

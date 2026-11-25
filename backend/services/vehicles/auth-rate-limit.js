const {createHmac}=require('node:crypto');
const {UpdateCommand}=require('@aws-sdk/lib-dynamodb');
const db=require('../../shared/db');
const {tables}=require('../../shared/config');

const POLICIES={
  '/login':{limit:20,windowMs:15*60*1000,label:'20-in-15min'},
  '/verify-otp':{limit:10,windowMs:15*60*1000,label:'10-in-15min'},
  '/resend-confirmation':{limit:1,windowMs:60*1000,label:'1-in-1min'},
  default:{limit:20,windowMs:15*60*1000,label:'20-in-15min'}
};
const LIMITED_AUTH_PATHS=new Set([
  '/auth/register','/auth/confirm','/auth/resend-confirmation','/auth/login',
  '/auth/verify-otp','/auth/forgot-password','/auth/reset-password'
]);
function shouldRateLimitAuthRequest(req){return req.method==='POST'&&LIMITED_AUTH_PATHS.has(req.path);}
const developmentBuckets=new Map();
function normalizedIdentity(req){
  const raw=String(req.body?.email||'').trim().toLowerCase().slice(0,320);
  return raw||'missing-identity';
}
function opaqueKey(secret,scope,value){return createHmac('sha256',secret).update(`${scope}\0${value}`).digest('hex');}
async function consume({id,limit,windowMs,now=Date.now()}){
  const windowStart=Math.floor(now/windowMs)*windowMs;
  const resetAt=windowStart+windowMs;
  try{
    const result=await db.client.send(new UpdateCommand({
      TableName:tables.AuthRateLimits,Key:{id:`${id}:${windowStart}`},
      UpdateExpression:'ADD #attempts :one SET #expiresAt = if_not_exists(#expiresAt, :expiresAt)',
      ConditionExpression:'attribute_not_exists(#attempts) OR #attempts < :limit',
      ExpressionAttributeNames:{'#attempts':'attempts','#expiresAt':'expiresAt'},
      ExpressionAttributeValues:{':one':1,':limit':limit,':expiresAt':Math.ceil(resetAt/1000)+300},ReturnValues:'ALL_NEW'
    }));
    return {allowed:true,count:result.Attributes.attempts,resetAt};
  }catch(error){
    if(error.name==='ConditionalCheckFailedException')return {allowed:false,count:limit,resetAt};
    if(process.env.NODE_ENV!=='production'&&['ResourceNotFoundException','ResourceNotFound'].includes(error.name)){
      const key=`${id}:${windowStart}`,count=(developmentBuckets.get(key)||0)+1;developmentBuckets.set(key,count);
      return {allowed:count<=limit,count:Math.min(count,limit),resetAt};
    }
    throw error;
  }
}
function createAuthRateLimiter({secret=process.env.RATE_LIMIT_KEY_SECRET||process.env.SERVICE_INTERNAL_SECRET||(process.env.NODE_ENV!=='production'?'motorlog-development-only-rate-limit-key':''),consumeAttempt=consume,now=()=>Date.now()}={}){
  if(!secret)throw new Error('RATE_LIMIT_KEY_SECRET is required');
  return async function authRateLimit(req,res,next){
    try{
      const currentTime=now();
      const policyPath=req.path.startsWith('/auth/')?req.path.slice('/auth'.length):req.path;
      const policy=POLICIES[policyPath]||POLICIES.default;
      const identity=normalizedIdentity(req);
      const accountId=opaqueKey(secret,`account:${req.path}`,identity);
      const globalId=opaqueKey(secret,'global-auth','all');
      const [account,global]=await Promise.all([
        consumeAttempt({id:accountId,...policy,now:currentTime}),
        consumeAttempt({id:globalId,limit:500,windowMs:15*60*1000,now:currentTime})
      ]);
      const retrySeconds=Math.max(1,Math.ceil((account.resetAt-currentTime)/1000));
      const remaining=Math.max(0,policy.limit-account.count);
      res.setHeader('RateLimit',`"${policy.label}"; r=${remaining}; t=${retrySeconds}`);
      res.setHeader('RateLimit-Policy',`"${policy.label}"; q=${policy.limit}; w=${Math.round(policy.windowMs/1000)}`);
      if(!account.allowed||!global.allowed){
        const resetAt=!account.allowed?account.resetAt:global.resetAt;
        const retry=Math.max(1,Math.ceil((resetAt-currentTime)/1000));
        res.setHeader('Retry-After',String(retry));
        return res.status(429).json({error:{code:'RATE_LIMIT',message:'Too many authentication requests. Try again later.',retryAfter:retry}});
      }
      next();
    }catch(error){next(error);}
  };
}
module.exports={POLICIES,LIMITED_AUTH_PATHS,shouldRateLimitAuthRequest,normalizedIdentity,opaqueKey,consume,createAuthRateLimiter};

const {runtime}=require('./config');
const buckets=new Map();
function apiRateLimit({windowMs=runtime.rateLimitWindowMs,max=runtime.rateLimitMax,now=()=>Date.now()}={}){
  return (req,res,next)=>{
    if(req.path==='/api/health')return next();
    const time=now(),windowStart=Math.floor(time/windowMs)*windowMs,key=`${req.ip}:${windowStart}`,count=(buckets.get(key)||0)+1;buckets.set(key,count);
    if(buckets.size>10000)for(const [k] of buckets){if(!k.endsWith(String(windowStart)))buckets.delete(k);}
    const remaining=Math.max(0,max-count),retry=Math.max(1,Math.ceil((windowStart+windowMs-time)/1000));
    res.setHeader('RateLimit',`limit=${max}, remaining=${remaining}, reset=${retry}`);
    if(count>max){res.setHeader('Retry-After',String(retry));console.warn(JSON.stringify({type:'security_event',event:'rate_limit_violation',path:req.path,method:req.method}));return res.status(429).json({error:{code:'RATE_LIMIT',message:'Too many requests. Try again later.',retryAfter:retry}});}
    next();
  };
}
module.exports={apiRateLimit};

const logged=Symbol('motorlogRequestLogged');
function timestamp(date=new Date()){return date.toISOString().replace('T',' ').replace('Z','');}
function requestLogger(service='gateway'){return (req,res,next)=>{if(req[logged])return next();req[logged]=true;const started=Date.now(),safePath=req.path||String(req.url||'/').split('?')[0];res.on('finish',()=>{const entry={type:'http_request',service,method:req.method,path:safePath,statusCode:res.statusCode,durationMs:Date.now()-started};const output=res.statusCode>=500?console.error:res.statusCode>=400?console.warn:console.info;output(JSON.stringify(entry));if(res.statusCode>=500)require('./metrics').emitMetricSafely('API5xxErrors',1,{service,operation:'http'});});next();};}
module.exports={requestLogger,timestamp};

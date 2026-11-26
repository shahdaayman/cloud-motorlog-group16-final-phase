require('dotenv').config();
const express=require('express');
const path=require('node:path');
const helmet=require('helmet');
const {sendError}=require('./shared/errors');
const {requestLogger}=require('./shared/logger');
const app=express();app.disable('x-powered-by');
const instanceId=/^[a-z0-9-]{1,32}$/i.test(process.env.MOTORLOG_INSTANCE_ID||'')?process.env.MOTORLOG_INSTANCE_ID:'motorlog-local';
app.use((req,res,next)=>{res.setHeader('X-Motorlog-Instance',instanceId);next();});
app.use(requestLogger('local'));
app.use(helmet({contentSecurityPolicy:{useDefaults:true,directives:{'script-src':["'self'"], 'connect-src':["'self'",'http://localhost:4566','https://vpic.nhtsa.dot.gov'], 'img-src':["'self'",'data:'], 'style-src':["'self'","'unsafe-inline'",'https://fonts.googleapis.com'], 'font-src':["'self'",'https://fonts.gstatic.com'],upgradeInsecureRequests:null}}}));
if(process.env.MOTORLOG_API_BASE_URL){app.get('/js/config.js',(req,res)=>{res.type('application/javascript').set('Cache-Control','no-store').send(`window.MOTORLOG_CONFIG = ${JSON.stringify({API_BASE_URL:process.env.MOTORLOG_API_BASE_URL,APP_NAME:'Motorlog'})};\n`);});}
app.use(express.static(path.join(__dirname,'../frontend'),{index:'index.html',extensions:['html']}));
const vehicles=require('./services/vehicles/app');const fuel=require('./services/fuel/app');const reminders=require('./services/reminders/app');
// Locally mount each independent service at a shared API root; deployed API Gateway routes to distinct Lambdas.
const vehiclePaths=['/api/auth','/api/vehicles','/api/maintenance','/api/admin'];
app.use((req,res,next)=>{
 const p=req.path;
 if(p.startsWith('/api/auth')||p.startsWith('/api/admin')||p.startsWith('/api/maintenance'))return vehicles(req,res,next);
 if(p.startsWith('/api/fuel/')||p.startsWith('/api/expenses/')||p.includes('/fuel')||p.includes('/expenses')||p.endsWith('/costs'))return fuel(req,res,next);
 if(p.startsWith('/api/reminders')||p.startsWith('/api/analytics')||p.includes('/reminders'))return reminders(req,res,next);
 if(p.startsWith('/api/vehicles')||p==='/api/health')return vehicles(req,res,next);
 return next();
});
app.use('/api',(req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'No matching API route'}}));
app.use(sendError);
function startDevServer(port=Number(process.env.PORT||3000),{exitOnError=require.main===module}={}){
 const server=app.listen(port);
 server.once('listening',()=>console.log(`Car Maintenance Log running: http://localhost:${port}`));
 server.once('error',error=>{
  if(error?.code==='EADDRINUSE')console.error(`[Motorlog] EADDRINUSE: port ${port} is already in use. Another development server may already be running. Stop that server or choose a different PORT, then try again.`);
  else console.error(`[Motorlog] Development server failed to start: ${error?.code||error?.name||'ERROR'} ${error?.message||'Unknown error'}`);
  process.exitCode=1;
  if(exitOnError)setImmediate(()=>process.exit(1));
 });
 return server;
}
if(require.main===module)require('./shared/secrets').loadRuntimeConfig().then(()=>startDevServer()).catch(error=>{console.error(JSON.stringify({type:'startup_failed',error:error.name||'Error'}));process.exitCode=1;});
module.exports=app;
module.exports.startDevServer=startDevServer;

const express=require('express');
const helmet=require('helmet');
const cors=require('cors');
const {sendError,missing}=require('./errors');
const {requestLogger}=require('./logger');
const {apiRateLimit}=require('./rate-limit');
function createApp(label){
  const app=express(); app.disable('x-powered-by');app.set('trust proxy',process.env.TRUST_PROXY_HOPS?Number(process.env.TRUST_PROXY_HOPS):false);app.use(helmet({contentSecurityPolicy:{useDefaults:true,directives:{'default-src':["'none'"],'frame-ancestors':["'none'"]}}}));
  const allowed=(process.env.CORS_ORIGINS||'http://localhost:3000,http://localhost:8080,http://localhost:4566').split(',').map(x=>x.trim());
  app.use(cors({origin(origin,callback){if(!origin||allowed.includes(origin))return callback(null,true);return callback(null,false);},methods:['GET','POST','PATCH','DELETE','OPTIONS'],allowedHeaders:['Content-Type','Authorization']}));
  app.use(express.json({limit:'64kb',strict:true}));app.use(apiRateLimit());
  app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});app.use(requestLogger(label));
  app.get('/api/health',(req,res)=>res.json({status:'ok',service:label,runtime:process.env.AWS_LAMBDA_FUNCTION_NAME?'lambda':'local',timestamp:new Date().toISOString()}));
  return app;
}
function finishApp(app){app.use((req,res,next)=>next(missing('Route not found')));app.use(sendError);return app;}
module.exports={createApp,finishApp};

const fs=require('node:fs'),path=require('node:path');
const [instanceId,portText]=process.argv.slice(2);
if(!/^[a-z0-9-]{1,32}$/i.test(instanceId||''))throw new Error('A safe instance identifier is required');
const port=Number(portText);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('A non-privileged target port is required');
process.env.MOTORLOG_INSTANCE_ID=instanceId;
process.env.PORT=String(port);
if(!process.env.MOTORLOG_API_BASE_URL){
  const deploymentPath=path.join(__dirname,'..','dist','floci-deployment.json');
  const deployment=JSON.parse(fs.readFileSync(deploymentPath,'utf8'));
  if(!deployment.invokeUrl)throw new Error('dist/floci-deployment.json has no invokeUrl; run npm run api:deploy');
  process.env.MOTORLOG_API_BASE_URL=deployment.invokeUrl;
}
const albDeploymentPath=path.join(__dirname,'..','dist','alb-deployment.json');
if(fs.existsSync(albDeploymentPath)){
  const alb=JSON.parse(fs.readFileSync(albDeploymentPath,'utf8'));
  if(alb.url){const origins=(process.env.CORS_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);if(!origins.includes(alb.url))process.env.CORS_ORIGINS=[...origins,alb.url].join(',');}
}
require('../backend/dev-server').startDevServer(port);

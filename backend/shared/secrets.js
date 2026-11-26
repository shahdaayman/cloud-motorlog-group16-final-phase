const {SecretsManagerClient,GetSecretValueCommand}=require('@aws-sdk/client-secrets-manager');
const {awsOptions}=require('./config');
async function loadRuntimeConfig(){
  const name=process.env.APP_CONFIG_SECRET_NAME;if(!name)return {source:'environment'};
  try{const out=await new SecretsManagerClient(awsOptions).send(new GetSecretValueCommand({SecretId:name}));const value=JSON.parse(out.SecretString||'{}');for(const [key,target] of [['rateLimitMax','RATE_LIMIT_MAX'],['rateLimitWindowMs','RATE_LIMIT_WINDOW_MS']])if(value[key]!=null&&!process.env[target])process.env[target]=String(value[key]);return {source:'secrets-manager'};}
  catch(error){if(process.env.NODE_ENV==='production')throw error;console.warn(JSON.stringify({type:'config_secret_unavailable',error:error.name||'Error',fallback:'environment'}));return {source:'environment'};}
}
module.exports={loadRuntimeConfig};

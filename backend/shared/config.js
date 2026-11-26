require('dotenv').config();
const region=process.env.AWS_REGION||'us-east-1';
const endpoint=process.env.AWS_ENDPOINT_URL || undefined;
const awsOptions={region,...(endpoint?{endpoint,credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID||'test',secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY||'test'}}:{})};
const prefix=process.env.TABLE_PREFIX||'CML';
const tables=Object.fromEntries(['Users','Vehicles','Maintenance','Fuel','Expenses','Reminders','Audit','AuthRateLimits'].map(name=>[name,`${prefix}${name}`]));
const runtime={rateLimitWindowMs:Number(process.env.RATE_LIMIT_WINDOW_MS||60000),rateLimitMax:Number(process.env.RATE_LIMIT_MAX||120)};
module.exports={awsOptions,region,endpoint,prefix,tables,runtime,appClientId:process.env.COGNITO_APP_CLIENT_ID||'',userPoolId:process.env.COGNITO_USER_POOL_ID||'',requireMfa:process.env.REQUIRE_MFA!=='false'};

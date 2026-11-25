/** Creates/reuses the local Cognito user pool with mandatory EMAIL_OTP MFA, app client and Admin group.
 * Run only after `npm install` and while Floci is healthy. Does not deploy any Lambda function. */
require('dotenv').config();
const fs=require('node:fs'),path=require('node:path');
const {CognitoIdentityProviderClient,ListUserPoolsCommand,CreateUserPoolCommand,ListUserPoolClientsCommand,CreateUserPoolClientCommand,UpdateUserPoolClientCommand,SetUserPoolMfaConfigCommand,CreateGroupCommand}=require('@aws-sdk/client-cognito-identity-provider');
const {SESv2Client,CreateEmailIdentityCommand}=require('@aws-sdk/client-sesv2');
const {awsOptions,region}=require('../backend/shared/config');
const idp=new CognitoIdentityProviderClient(awsOptions),ses=new SESv2Client(awsOptions);
async function main(){
 if(!process.env.AWS_ENDPOINT_URL||!process.env.AWS_ENDPOINT_URL.includes('localhost'))throw new Error('This script is restricted to local Floci. Set AWS_ENDPOINT_URL=http://localhost:4566');
 const sender=process.env.SES_FROM_EMAIL||'no-reply@car-maintenance.local';try{await ses.send(new CreateEmailIdentityCommand({EmailIdentity:sender}));}catch(e){console.warn('SES identity setup:',e.message);}
 const poolName='CML-Group16-Users';const existing=await idp.send(new ListUserPoolsCommand({MaxResults:60}));
 let pool=existing.UserPools?.find(p=>p.Name===poolName);
 if(!pool){const response=await idp.send(new CreateUserPoolCommand({PoolName:poolName,UsernameAttributes:['email'],AutoVerifiedAttributes:['email'],UserPoolTier:'ESSENTIALS',Policies:{PasswordPolicy:{MinimumLength:12,RequireLowercase:true,RequireUppercase:true,RequireNumbers:true,RequireSymbols:false}},EmailConfiguration:{EmailSendingAccount:'DEVELOPER',From:process.env.SES_FROM_EMAIL||'no-reply@car-maintenance.local'}}));pool=response.UserPool;console.log('Created user pool:',pool.Id);}else console.log('User pool already exists:',pool.Id);
 await idp.send(new SetUserPoolMfaConfigCommand({UserPoolId:pool.Id,MfaConfiguration:'ON',EmailMfaConfiguration:{Subject:'Motorlog sign-in verification code',Message:'Your Motorlog verification code is {####}. It expires soon.'}}));
 let clients=await idp.send(new ListUserPoolClientsCommand({UserPoolId:pool.Id,MaxResults:60}));let app=clients.UserPoolClients?.find(c=>c.ClientName==='CML-Web-App');
 const clientConfig={UserPoolId:pool.Id,ClientName:'CML-Web-App',ExplicitAuthFlows:['ALLOW_USER_PASSWORD_AUTH','ALLOW_REFRESH_TOKEN_AUTH','ALLOW_USER_SRP_AUTH'],AuthSessionValidity:5,PreventUserExistenceErrors:'ENABLED',AccessTokenValidity:7,IdTokenValidity:7,TokenValidityUnits:{AccessToken:'hours',IdToken:'hours'}};
 if(!app){const created=await idp.send(new CreateUserPoolClientCommand({...clientConfig,GenerateSecret:false}));app=created.UserPoolClient;console.log('Created app client:',app.ClientId);}
 else{await idp.send(new UpdateUserPoolClientCommand({...clientConfig,ClientId:app.ClientId}));console.log('Updated app client with 7-hour access and ID tokens:',app.ClientId);}
 try{await idp.send(new CreateGroupCommand({GroupName:'Admin',UserPoolId:pool.Id,Description:'Privileged support accounts'}));console.log('Admin group created');}catch(e){if(e.name!=='GroupExistsException')throw e;console.log('Admin group already exists');}
 const envPath=path.resolve(__dirname,'../.env');if(!fs.existsSync(envPath))fs.copyFileSync(path.resolve(__dirname,'../.env.example'),envPath);
 const localIssuer=`${process.env.AWS_ENDPOINT_URL}/${pool.Id}`;
 let issuer=localIssuer;try{const discovery=await fetch(`${localIssuer}/.well-known/openid-configuration`);if(discovery.ok)issuer=(await discovery.json()).issuer||localIssuer;}catch(e){console.warn('Issuer discovery:',e.message);}
 let env=fs.readFileSync(envPath,'utf8');const updates={COGNITO_USER_POOL_ID:pool.Id,COGNITO_APP_CLIENT_ID:app.ClientId,COGNITO_ISSUER:issuer,COGNITO_JWKS_URL:`${localIssuer}/.well-known/jwks.json`,REQUIRE_MFA:'true',SES_FROM_EMAIL:sender};
 for(const [key,value] of Object.entries(updates)){const re=new RegExp(`^${key}=.*$`,'m');env=re.test(env)?env.replace(re,`${key}=${value}`):`${env}\n${key}=${value}`;}
 fs.writeFileSync(envPath,env,{mode:0o600});
 console.log('\nCompleted. User pool:',pool.Id,'\nClient:',app.ClientId,'\nConfiguration written to .env (ignored by Git).');
 console.log('Floci email inbox: http://localhost:4566/_aws/ses');
 console.log('For the admin role, sign up then run: aws cognito-idp admin-add-user-to-group --user-pool-id '+pool.Id+' --username <confirmed-email> --group-name Admin');
}
main().catch(e=>{console.error('Setup failed:',e.name,e.message);process.exitCode=1});

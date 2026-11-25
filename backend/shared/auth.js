const {jwtVerify,createRemoteJWKSet}=require('jose');
const {CognitoIdentityProviderClient,GetUserCommand}=require('@aws-sdk/client-cognito-identity-provider');
const {awsOptions}=require('./config');
const idp=new CognitoIdentityProviderClient(awsOptions);
const {tables,userPoolId,appClientId,region}=require('./config');
const db=require('./db');
const {unauthorized,forbidden}=require('./errors');
let jwks;
async function verifyToken(jwt){
  const issuer=process.env.COGNITO_ISSUER||`https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  if(!userPoolId||!appClientId)throw new Error('Cognito environment not configured');
  if(!jwks)jwks=createRemoteJWKSet(new URL(process.env.COGNITO_JWKS_URL||`${issuer}/.well-known/jwks.json`));
  const {payload}=await jwtVerify(jwt,jwks,{issuer,algorithms:['RS256']});
  if(payload.token_use!=='access'||payload.client_id!==appClientId)throw unauthorized('Invalid access token');
  return payload;
}
async function authenticate(req,res,next){
  try{
    const match=/^Bearer (\S+)$/i.exec(req.get('authorization')||'');
    if(!match)throw unauthorized();
    let payload;try{payload=await verifyToken(match[1]);}catch(e){if(e.status)throw e;throw unauthorized('Invalid or expired access token');}
    let profile=await db.get('Users',payload.sub);
    if(!profile){let userEmail=payload.email||payload.username||payload['cognito:username']||'';try{const details=await idp.send(new GetUserCommand({AccessToken:match[1]}));userEmail=details.UserAttributes?.find(a=>a.Name==='email')?.Value||userEmail;}catch(e){console.warn('Could not retrieve Cognito user email',e.name);}
      profile=await db.put('Users',{id:payload.sub,email:userEmail,status:'Active',createdAt:new Date().toISOString()},true).catch(async e=>e.status===409?db.get('Users',payload.sub):Promise.reject(e));}
    const deletionRetry=req.method==='DELETE'&&req.originalUrl?.split('?')[0].endsWith('/api/auth/account');
    if(profile.status!=='Active'&&!(profile.status==='Deleting'&&deletionRetry))throw forbidden(profile.status==='Deleting'?'Account deletion is in progress':'Account disabled');
    req.user={sub:payload.sub,email:profile.email,groups:payload['cognito:groups']||[],isAdmin:(payload['cognito:groups']||[]).includes('Admin'),accessToken:match[1]};
    next();
  }catch(e){next(e);}
}
function adminOnly(req,res,next){if(!req.user?.isAdmin)return next(forbidden('Admin role required'));next();}
module.exports={authenticate,adminOnly,verifyToken};

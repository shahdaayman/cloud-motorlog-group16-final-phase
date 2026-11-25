const express=require('express');
const {createAuthRateLimiter,shouldRateLimitAuthRequest}=require('./auth-rate-limit');
const {CognitoIdentityProviderClient,SignUpCommand,ConfirmSignUpCommand,ResendConfirmationCodeCommand,InitiateAuthCommand,RespondToAuthChallengeCommand,GlobalSignOutCommand,ForgotPasswordCommand,ConfirmForgotPasswordCommand}=require('@aws-sdk/client-cognito-identity-provider');
const {awsOptions,appClientId,userPoolId,requireMfa}=require('../../shared/config');
const {asyncRoute,bad,unauthorized}=require('../../shared/errors');
const db=require('../../shared/db');
const {randomUUID}=require('node:crypto');
const {requireDeleteConfirmation,assertAdminSafety,permanentlyDelete}=require('./account-deletion');
const {email,str}=require('../../shared/validate');
const {authenticate}=require('../../shared/auth');
const router=express.Router();
const idp=new CognitoIdentityProviderClient(awsOptions);
const limiter=createAuthRateLimiter();
router.use((req,res,next)=>shouldRateLimitAuthRequest(req)?limiter(req,res,next):next());
function requireConfig(){if(!appClientId||!userPoolId)throw new Error('COGNITO_APP_CLIENT_ID and COGNITO_USER_POOL_ID are required');}
function authReply(output){
  if(output.AuthenticationResult){if(requireMfa)throw new Error('MFA is required but Cognito issued tokens without an OTP challenge; enable required email MFA for this user pool');return {mfaRequired:false,accessToken:output.AuthenticationResult.AccessToken,idToken:output.AuthenticationResult.IdToken,expiresIn:output.AuthenticationResult.ExpiresIn};}
  if(!['EMAIL_OTP','SMS_MFA','SOFTWARE_TOKEN_MFA','SELECT_MFA_TYPE'].includes(output.ChallengeName))throw bad(`Unsupported authentication challenge: ${output.ChallengeName||'none'}`);
  return {mfaRequired:true,challenge:output.ChallengeName,session:output.Session,delivery:'email'};
}
router.post('/auth/register',asyncRoute(async(req,res)=>{
  requireConfig();const username=email(req.body?.email);const password=str(req.body?.password,'password',12,128);
  if(!/[a-z]/.test(password)||!/[A-Z]/.test(password)||!/[0-9]/.test(password))throw bad('Password needs uppercase and lowercase letters and a number');
  try{await idp.send(new SignUpCommand({ClientId:appClientId,Username:username,Password:password,UserAttributes:[{Name:'email',Value:username}]}));}
  catch(e){
    if(e.name!=='UsernameExistsException')throw e;
    try{await idp.send(new ResendConfirmationCodeCommand({ClientId:appClientId,Username:username}));}
    catch(resendError){if(!['InvalidParameterException','NotAuthorizedException','UserNotFoundException'].includes(resendError.name))throw resendError;}
  }
  res.status(201).json({message:'If registration can be completed, enter the verification code sent to your email.',nextStep:'CONFIRM_SIGNUP'});
}));
router.post('/auth/confirm',asyncRoute(async(req,res)=>{
  requireConfig();const username=email(req.body?.email);const code=str(req.body?.code,'code',4,10);
  await idp.send(new ConfirmSignUpCommand({ClientId:appClientId,Username:username,ConfirmationCode:code}));res.json({message:'Email confirmed. You can sign in.'});
}));
router.post('/auth/resend-confirmation',asyncRoute(async(req,res)=>{
  requireConfig();const username=email(req.body?.email);
  try{await idp.send(new ResendConfirmationCodeCommand({ClientId:appClientId,Username:username}));}
  catch(e){if(!['UserNotFoundException','InvalidParameterException','NotAuthorizedException'].includes(e.name))throw e;}
  res.json({message:'If this registration is awaiting verification, a new code has been sent.'});
}));
router.post('/auth/login',asyncRoute(async(req,res)=>{
  requireConfig();const username=email(req.body?.email);const password=str(req.body?.password,'password',1,128);
  let result;try{result=await idp.send(new InitiateAuthCommand({ClientId:appClientId,AuthFlow:'USER_PASSWORD_AUTH',AuthParameters:{USERNAME:username,PASSWORD:password}}));}catch(e){if(e.name==='UserNotConfirmedException'){e.status=403;e.code='ACCOUNT_NOT_CONFIRMED';e.message='Finish email verification before signing in.';}throw e;}
  res.json(authReply(result));
}));
router.post('/auth/verify-otp',asyncRoute(async(req,res)=>{
  requireConfig();const username=email(req.body?.email);const code=str(req.body?.code,'OTP',6,8);const session=str(req.body?.session,'session',8,8192);
  const challenge=str(req.body?.challenge||'EMAIL_OTP','challenge',4,32);
  const codeFields={EMAIL_OTP:'EMAIL_OTP_CODE',SMS_MFA:'SMS_MFA_CODE',SOFTWARE_TOKEN_MFA:'SOFTWARE_TOKEN_MFA_CODE'};
  if(!codeFields[challenge])throw bad('Unsupported OTP challenge');
  const result=await idp.send(new RespondToAuthChallengeCommand({ClientId:appClientId,ChallengeName:challenge,Session:session,ChallengeResponses:{USERNAME:username,[codeFields[challenge]]:code}}));
  if(!result.AuthenticationResult)throw unauthorized('OTP verification not complete');
  res.json({accessToken:result.AuthenticationResult.AccessToken,idToken:result.AuthenticationResult.IdToken,expiresIn:result.AuthenticationResult.ExpiresIn,mfaVerified:true});
}));
router.post('/auth/forgot-password',asyncRoute(async(req,res)=>{requireConfig();const username=email(req.body?.email);await idp.send(new ForgotPasswordCommand({ClientId:appClientId,Username:username}));res.json({message:'If the account exists, a reset code was sent.'});}));
router.post('/auth/reset-password',asyncRoute(async(req,res)=>{requireConfig();const username=email(req.body?.email);const code=str(req.body?.code,'code',4,10);const password=str(req.body?.password,'password',12,128);await idp.send(new ConfirmForgotPasswordCommand({ClientId:appClientId,Username:username,ConfirmationCode:code,Password:password}));res.json({message:'Password updated'});}));
router.post('/auth/logout',authenticate,asyncRoute(async(req,res)=>{await idp.send(new GlobalSignOutCommand({AccessToken:req.user.accessToken}));res.status(204).end();}));
router.delete('/auth/account',authenticate,asyncRoute(async(req,res)=>{
  requireDeleteConfirmation(req.body);
  const claims=await require('../../shared/auth').verifyToken(req.user.accessToken);
  const authTime=Number(claims.auth_time||0);
  if(!authTime||Date.now()/1000-authTime>10*60){const error=unauthorized('Please sign in again before deleting your account');error.code='RECENT_AUTH_REQUIRED';throw error;}
  try{
    const target=await assertAdminSafety({idp,userPoolId,targetId:req.user.sub,actorId:req.user.sub,allowSelf:true});
    const deleted=await permanentlyDelete({idp,userPoolId,targetId:req.user.sub,deletionRole:target.role});
    await db.put('Audit',{id:randomUUID(),actorId:req.user.sub,action:'ACCOUNT_DELETE',target:req.user.sub,result:'SUCCESS',details:{deletedRecords:String(Object.values(deleted).reduce((sum,n)=>sum+n,0))},createdAt:new Date().toISOString()}).catch(error=>console.error('audit-write-failed',error.name));
    res.json({message:'Account permanently deleted'});
  }catch(error){await db.put('Audit',{id:randomUUID(),actorId:req.user.sub,action:'ACCOUNT_DELETE',target:req.user.sub,result:'FAILED',details:{reason:String(error.code||error.name||'ERROR').slice(0,80)},createdAt:new Date().toISOString()}).catch(()=>{});throw error;}
}));
router.authClient=idp;
module.exports=router;

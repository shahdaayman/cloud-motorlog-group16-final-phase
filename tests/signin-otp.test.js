const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const authRoutes=require('../backend/services/vehicles/auth-routes');
const {sendError}=require('../backend/shared/errors');
const {randomUUID}=require('node:crypto');

async function withServer(send,run){const original=authRoutes.authClient.send;authRoutes.authClient.send=send;const app=express();app.use(express.json());app.use('/api',authRoutes);app.use(sendError);const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});try{return await run(`http://127.0.0.1:${server.address().port}`);}finally{authRoutes.authClient.send=original;await new Promise(resolve=>server.close(resolve));}}
const post=(base,path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const providerError=name=>Object.assign(new Error('provider details must not escape'),{name});
const uniqueEmail=label=>`${label}-${randomUUID()}@example.com`;

test('EMAIL_OTP login preserves the Cognito session and submits the AWS response fields',()=>{const address=uniqueEmail('signin');return withServer(async command=>{
  if(command.constructor.name==='InitiateAuthCommand')return {ChallengeName:'EMAIL_OTP',Session:'opaque-login-session'};
  assert.equal(command.constructor.name,'RespondToAuthChallengeCommand');
  assert.equal(command.input.ChallengeName,'EMAIL_OTP');
  assert.equal(command.input.Session,'opaque-login-session');
  assert.deepEqual(command.input.ChallengeResponses,{USERNAME:address,EMAIL_OTP_CODE:'87654321'});
  return {AuthenticationResult:{AccessToken:'access-token',IdToken:'id-token',ExpiresIn:3600}};
},async base=>{
  const login=await post(base,'/api/auth/login',{email:address,password:'StrongPassword123'});assert.equal(login.status,200);const challenge=await login.json();
  assert.deepEqual({mfaRequired:challenge.mfaRequired,challenge:challenge.challenge,session:challenge.session},{mfaRequired:true,challenge:'EMAIL_OTP',session:'opaque-login-session'});
  const verified=await post(base,'/api/auth/verify-otp',{email:address,code:'87654321',challenge:challenge.challenge,session:challenge.session});assert.equal(verified.status,200);assert.equal((await verified.json()).mfaVerified,true);
});});

for(const [name,status,message] of [['CodeMismatchException',401,/incorrect/i],['ExpiredCodeException',401,/expired/i],['NotAuthorizedException',401,/authentication session/i]])test(`${name} remains a failed OTP verification`,()=>{const address=uniqueEmail(name.toLowerCase());return withServer(async command=>{if(command.constructor.name==='RespondToAuthChallengeCommand')throw providerError(name);throw new Error('Unexpected command');},async base=>{const response=await post(base,'/api/auth/verify-otp',{email:address,code:'123456',challenge:'EMAIL_OTP',session:'different-session'});assert.equal(response.status,status);const body=await response.json();assert.match(body.error.message,message);assert.doesNotMatch(body.error.message,/provider details/);});});

test('missing Cognito session is rejected before contacting Cognito',()=>{const address=uniqueEmail('missing-session');return withServer(async()=>{throw new Error('Cognito must not be called');},async base=>{const response=await post(base,'/api/auth/verify-otp',{email:address,code:'123456',challenge:'EMAIL_OTP'});assert.equal(response.status,400);});});

test('diagnostic logs correlate stages without secrets, OTPs, tokens, sessions, or email addresses',()=>{const address=uniqueEmail('secret');return withServer(async command=>command.constructor.name==='InitiateAuthCommand'?{ChallengeName:'EMAIL_OTP',Session:'opaque-sensitive-session'}:{AuthenticationResult:{AccessToken:'sensitive-access-token',IdToken:'sensitive-id-token',ExpiresIn:3600}},async base=>{
  const original=console.log,lines=[];console.log=line=>lines.push(String(line));try{await post(base,'/api/auth/login',{email:address,password:'SensitivePassword123'});await post(base,'/api/auth/verify-otp',{email:address,code:'87654321',challenge:'EMAIL_OTP',session:'opaque-sensitive-session'});}finally{console.log=original;}
  const output=lines.join('\n');assert.match(output,/authentication_flow/);assert.match(output,/correlationId/);for(const secret of [address,'SensitivePassword123','87654321','opaque-sensitive-session','sensitive-access-token','sensitive-id-token'])assert.doesNotMatch(output,new RegExp(secret));
});});

test('frontend guards duplicate submissions, preserves failed challenges, and clears them only after success',()=>{const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../frontend/js/app.js'),'utf8');assert.match(source,/if\(authSubmitting\)return/);assert.match(source,/session:state\.pending\.session,challenge:state\.pending\.challenge/);assert.match(source,/post\('\/api\/auth\/verify-otp'[\s\S]{0,180}state\.pending=null/);assert.doesNotMatch(source,/state\.pending=null[\s\S]{0,80}post\('\/api\/auth\/verify-otp'/);});

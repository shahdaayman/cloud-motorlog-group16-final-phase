const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {requestLogger}=require('../backend/shared/logger');

function run(status=200){const req={method:'POST',path:'/api/auth/login',url:'/api/auth/login?token=secret',body:{password:'secret',code:'123456'},headers:{authorization:'Bearer secret'}},res=new EventEmitter();res.statusCode=status;let nextCalls=0;requestLogger('test')(req,res,()=>nextCalls++);return {req,res,nextCalls};}
test('request logger records structured method, safe path, status and duration',()=>{const old=console.info,lines=[];console.info=line=>lines.push(line);try{const {res,nextCalls}=run(200);res.emit('finish');assert.equal(nextCalls,1);const entry=JSON.parse(lines[0]);assert.deepEqual({type:entry.type,service:entry.service,method:entry.method,path:entry.path,statusCode:entry.statusCode},{type:'http_request',service:'test',method:'POST',path:'/api/auth/login',statusCode:200});assert.equal(Number.isInteger(entry.durationMs),true);}finally{console.info=old;}});
test('request logger uses error output and never logs bodies, credentials, tokens or query values',()=>{const old=console.error,lines=[];console.error=line=>lines.push(line);try{const {res}=run(502);res.emit('finish');assert.equal(lines.length,1);assert.doesNotMatch(lines[0],/secret|123456|token=|authorization|password/i);}finally{console.error=old;}});
test('nested service logger does not duplicate a request already logged by gateway',()=>{const {req,res}=run(200);let nested=0;requestLogger('nested')(req,res,()=>nested++);assert.equal(nested,1);assert.equal(res.listenerCount('finish'),1);});

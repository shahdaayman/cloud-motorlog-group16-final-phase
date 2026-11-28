const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {v4}=require('../frontend/js/secure-uuid');

test('prefers native randomUUID when the browser provides it',()=>{let fallbackCalled=false;const expected='12345678-1234-4123-8123-123456789abc',actual=v4({randomUUID:()=>expected,getRandomValues:()=>{fallbackCalled=true;}});assert.equal(actual,expected);assert.equal(fallbackCalled,false);});
test('HTTP-context fallback uses getRandomValues and produces a standards-compliant UUID v4',()=>{let calls=0;const value=v4({getRandomValues:bytes=>{calls++;for(let index=0;index<bytes.length;index++)bytes[index]=index;return bytes;}});assert.equal(calls,1);assert.match(value,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.equal(value,'00010203-0405-4607-8809-0a0b0c0d0e0f');});
test('a native randomUUID failure falls back to getRandomValues',()=>{const value=v4({randomUUID:()=>{throw new Error('secure context required');},getRandomValues:bytes=>bytes.fill(255)});assert.equal(value,'ffffffff-ffff-4fff-bfff-ffffffffffff');});
test('never falls back to non-cryptographic randomness',()=>{assert.throws(()=>v4({}),/Secure random identifier/);assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../frontend/js/secure-uuid.js'),'utf8'),/Math\.random/);});
test('reminder retries retain one key while new modal contexts generate new keys',()=>{const source=fs.readFileSync(path.join(__dirname,'../frontend/js/app.js'),'utf8'),index=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');assert.match(source,/context\.requestKey=context\.requestKey\|\|MotorlogSecureUUID\.v4\(\)/);assert.doesNotMatch(source,/crypto\.randomUUID\(/);assert.ok(index.indexOf('js/secure-uuid.js')<index.indexOf('js/app.js'));});

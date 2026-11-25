const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {create}=require('../frontend/js/hash-router');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

function fake(hash=''){const locationObject={hash};const calls=[];const historyObject={pushState(_s,_t,value){calls.push(['push',value]);locationObject.hash=value;},replaceState(_s,_t,value){calls.push(['replace',value]);locationObject.hash=value;}};return{locationObject,historyObject,calls};}
const user=['dashboard','vehicles','maintenance','fuel','expenses','reminders','analytics','account'];
const admin=['overview','users','activity','audit','notifications','health','security'];

test('every user and Admin page supports direct hashes and refresh restoration',()=>{for(const routes of [user,admin])for(const route of routes){const env=fake(`#${route}`),router=create({valid:routes,fallback:routes[0],...env});assert.equal(router.resolve(),route);assert.equal(router.normalize(),route);assert.deepEqual(env.calls,[]);}});
test('navigation writes stable hashes and supports history-driven Back and Forward resolution',()=>{const env=fake('#dashboard'),router=create({valid:user,fallback:'dashboard',...env});assert.equal(router.navigate('maintenance'),'maintenance');assert.deepEqual(env.calls,[['push','#maintenance']]);env.locationObject.hash='#vehicles';assert.equal(router.resolve(),'vehicles');env.locationObject.hash='#maintenance';assert.equal(router.resolve(),'maintenance');});
test('unknown, malformed and cross-console hashes fall back safely',()=>{for(const hash of ['#unknown','#admin','#users','#%E0%A4%A']){const env=fake(hash),router=create({valid:user,fallback:'dashboard',...env});assert.equal(router.normalize(),'dashboard');assert.equal(env.locationObject.hash,'#dashboard');}const env=fake('#maintenance'),router=create({valid:admin,fallback:'overview',...env});assert.equal(router.normalize(),'overview');});
test('both entry points use cache-busted router scripts and history events',()=>{const index=read('frontend/index.html'),adminHtml=read('frontend/admin/index.html'),app=read('frontend/js/app.js'),adminJs=read('frontend/js/admin.js');assert.match(index,/js\/hash-router\.js\?v=/);assert.match(index,/js\/app\.js\?v=/);assert.match(adminHtml,/\.\.\/js\/hash-router\.js\?v=/);assert.match(adminHtml,/\.\.\/js\/admin\.js\?v=/);for(const source of [app,adminJs]){assert.match(source,/hashchange/);assert.match(source,/popstate/);assert.match(source,/restoreRoute/);}});
test('deploy marks executable entry scripts no-store so browser caches cannot retain old routing',()=>{const deploy=read('scripts/deploy-s3-frontend.ps1');for(const file of ['js/config.js','js/hash-router.js','js/app.js','js/admin.js'])assert.ok(deploy.includes(`'${file}'`));assert.match(deploy,/no-cache, no-store, must-revalidate/);});
test('route allowlists exclude temporary UI and keep Admin routes out of the user app',()=>{assert.equal(user.includes('admin'),false);for(const value of ['modal','confirm','delete','otp'])assert.equal(user.includes(value)||admin.includes(value),false);});

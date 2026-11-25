const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const routerSource=read('frontend/js/hash-router.js');
const appSource=read('frontend/js/app.js');
const adminSource=read('frontend/js/admin.js');
const userRoutes=['dashboard','vehicles','maintenance','fuel','expenses','reminders','analytics','account'];
const adminRoutes=['overview','users','activity','audit','notifications','health','security'];
const wait=()=>new Promise(resolve=>setTimeout(resolve,15));

function token(admin=false){const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');return `${encode({alg:'none'})}.${encode({sub:'test-user',email:'test@example.com',exp:Math.floor(Date.now()/1000)+3600,...(admin?{'cognito:groups':['Admin']}:{})})}.signature`;}
function response(body,status=200){return{ok:status>=200&&status<300,status,headers:{get:()=>null},json:async()=>body};}
function userPayload(url){if(url.includes('/api/vehicles?'))return{items:[{id:'car-1',nickname:'Test Car',make:'Motorlog',model:'One',year:2026,mileageKm:1000}]};if(url.includes('/maintenance'))return{items:[{id:'maint-1',type:'Oil Change',date:'2026-11-18',mileageKm:1000,cost:100,notes:''}]};if(url.includes('/fuel?'))return{items:[]};if(url.includes('/expenses?'))return{items:[]};if(url.includes('/api/reminders'))return{items:[]};if(url.includes('/analytics/monthly'))return{items:[]};if(url.includes('/analytics/summary'))return{};if(url.includes('/fuel-economy'))return{hasEnoughData:false};return{};}
function adminPayload(url){const route=new URL(url,'http://motorlog.local').pathname.split('/').pop();if(route==='overview')return{stats:{},recentRegistrations:[],recentActions:[],recentSecurityEvents:[],notifications:{}};if(route==='users')return{items:[],nextPage:null};if(route==='activity'||route==='audit')return{items:[],nextPage:null};if(route==='notifications')return{open:0,overdue:0,queued:0,acceptedBySes:0,failed:0,lastQueuedNotification:'None',note:''};if(route==='health')return{services:[],checkedAt:new Date().toISOString()};if(route==='security')return{account:{email:'admin@example.com',id:'admin'},role:'Admin',authenticated:true,mfaStatus:'verified',accessControl:'verified'};return{};}
async function boot({hash,admin=false,sharedSession}){const html=read(admin?'frontend/admin/index.html':'frontend/index.html');const dom=new JSDOM(html,{url:`http://motorlog.local/${admin?'admin/':''}${hash}`,runScripts:'outside-only',pretendToBeVisual:true});const {window}=dom;for(const [key,value] of sharedSession)window.sessionStorage.setItem(key,value);const calls=[];window.fetch=async url=>{calls.push(String(url));return response(adminPayload(String(url)));};if(!admin)window.fetch=async url=>{calls.push(String(url));return response(userPayload(String(url)));};window.MOTORLOG_CONFIG={API_BASE_URL:'http://api.local'};window.eval(routerSource);window.eval(admin?adminSource:appSource);await wait();await wait();return{dom,window,calls};}
function session(admin=false){return new Map(admin?[['motorlog_admin_token',token(true)],['motorlog_admin_email','admin@example.com']]:[['motorlog_session_token',token(false)],['motorlog_session_email','user@example.com']]);}

test('actual user entry point navigates, reloads Maintenance, restores active sidebar and refetches data',async()=>{const shared=session();let runtime=await boot({hash:'#dashboard',sharedSession:shared});const button=runtime.window.document.querySelector('[data-view="maintenance"]');button.dispatchEvent(new runtime.window.MouseEvent('click',{bubbles:true}));await wait();assert.equal(runtime.window.location.hash,'#maintenance');assert.equal(runtime.window.document.querySelector('#breadcrumb').textContent,'Maintenance');runtime.dom.window.close();runtime=await boot({hash:'#maintenance',sharedSession:shared});assert.equal(runtime.window.location.hash,'#maintenance');assert.equal(runtime.window.document.querySelector('#breadcrumb').textContent,'Maintenance');assert.equal(runtime.window.document.querySelector('[data-view="maintenance"]').classList.contains('active'),true);assert.ok(runtime.calls.some(url=>url.includes('/api/vehicles/car-1/maintenance')));assert.match(runtime.window.document.querySelector('#main-content').textContent,/Oil Change/);runtime.dom.window.close();});

test('actual user entry point restores every direct route without logging out',async()=>{const shared=session();for(const route of userRoutes){const runtime=await boot({hash:`#${route}`,sharedSession:shared});assert.equal(runtime.window.location.hash,`#${route}`);assert.equal(runtime.window.document.querySelector(`[data-view="${route}"]`).classList.contains('active'),true);assert.equal(runtime.window.document.querySelector('#app').classList.contains('is-locked'),false);assert.ok(runtime.window.sessionStorage.getItem('motorlog_session_token'));runtime.dom.window.close();}});

test('actual Admin entry point restores every route and requests its matching API',async()=>{const shared=session(true);for(const route of adminRoutes){const runtime=await boot({hash:`#${route}`,admin:true,sharedSession:shared});assert.equal(runtime.window.location.hash,`#${route}`);assert.equal(runtime.window.document.querySelector(`[data-view="${route}"]`).classList.contains('active'),true);assert.ok(runtime.calls.some(url=>url.includes(`/api/admin/${route}`)));assert.ok(runtime.window.sessionStorage.getItem('motorlog_admin_token'));runtime.dom.window.close();}});

test('actual entry point follows Back and Forward history',async()=>{const runtime=await boot({hash:'#dashboard',sharedSession:session()});for(const route of ['maintenance','fuel']){runtime.window.document.querySelector(`[data-view="${route}"]`).dispatchEvent(new runtime.window.MouseEvent('click',{bubbles:true}));await wait();}assert.equal(runtime.window.location.hash,'#fuel');runtime.window.history.back();await wait();assert.equal(runtime.window.location.hash,'#maintenance');assert.equal(runtime.window.document.querySelector('[data-view="maintenance"]').classList.contains('active'),true);runtime.window.history.forward();await wait();assert.equal(runtime.window.location.hash,'#fuel');assert.equal(runtime.window.document.querySelector('[data-view="fuel"]').classList.contains('active'),true);runtime.dom.window.close();});

test('rapid navigation across all user and Admin pages completes without authentication requests',async()=>{
 const user=await boot({hash:'#dashboard',sharedSession:session()});
 for(const route of userRoutes.filter(x=>x!=='dashboard')){user.window.document.querySelector(`[data-view="${route}"]`).dispatchEvent(new user.window.MouseEvent('click',{bubbles:true}));await wait();assert.equal(user.window.location.hash,`#${route}`);}
 assert.equal(user.calls.some(url=>url.includes('/api/auth/')),false);user.dom.window.close();
 const admin=await boot({hash:'#overview',admin:true,sharedSession:session(true)});
 for(const route of adminRoutes.filter(x=>x!=='overview')){admin.window.document.querySelector(`[data-view="${route}"]`).dispatchEvent(new admin.window.MouseEvent('click',{bubbles:true}));await wait();assert.equal(admin.window.location.hash,`#${route}`);}
 assert.equal(admin.calls.some(url=>url.includes('/api/auth/')),false);admin.dom.window.close();
});

test('overlapping user navigation coalesces identical GET requests',async()=>{
 const runtime=await boot({hash:'#dashboard',sharedSession:session()});runtime.calls.length=0;
 runtime.window.fetch=async url=>{runtime.calls.push(String(url));await new Promise(resolve=>setTimeout(resolve,30));return response(userPayload(String(url)));};
 runtime.window.document.querySelector('[data-view="vehicles"]').dispatchEvent(new runtime.window.MouseEvent('click',{bubbles:true}));
 runtime.window.document.querySelector('[data-view="maintenance"]').dispatchEvent(new runtime.window.MouseEvent('click',{bubbles:true}));
 await new Promise(resolve=>setTimeout(resolve,80));
 for(const path of ['/api/vehicles?limit=100','/api/reminders?limit=100','/api/analytics/summary','/api/analytics/monthly?months=6'])assert.equal(runtime.calls.filter(url=>url.includes(path)).length,1,path);
 runtime.dom.window.close();
});

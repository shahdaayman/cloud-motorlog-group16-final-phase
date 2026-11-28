const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {adminOnly}=require('../backend/shared/auth');
const {resolveRoles,resolveUsername}=require('../backend/services/vehicles/admin-roles');
const root=path.join(__dirname,'..');

test('admin middleware returns 403 for an authenticated non-admin',()=>{
 let error;adminOnly({user:{isAdmin:false}},{},value=>{error=value;});
 assert.equal(error.status,403);assert.equal(error.code,'FORBIDDEN');
});

test('admin middleware permits a verified administrator claim',()=>{
 let error='not-called';adminOnly({user:{isAdmin:true}},{},value=>{error=value;});
 assert.equal(error,undefined);
});

test('admin and user interfaces are separate entry points',()=>{
 const user=fs.readFileSync(path.join(root,'frontend/index.html'),'utf8');
 const admin=fs.readFileSync(path.join(root,'frontend/admin/index.html'),'utf8');
 assert.doesNotMatch(user,/id="admin-nav"/);assert.match(admin,/Dashboard Overview/);assert.match(admin,/Security & Access/);
});

test('admin mutations contain self and last-admin protections',()=>{
 const routes=fs.readFileSync(path.join(root,'backend/services/vehicles/admin-routes.js'),'utf8');
 assert.match(routes,/Cannot disable your own account/);assert.match(routes,/Cannot remove your own administrator privileges/);assert.match(routes,/Cannot disable the last active administrator/);assert.match(routes,/Cannot remove the last active administrator/);
});

test('admin login routing uses the backend-validated session role',()=>{
 const app=fs.readFileSync(path.join(root,'frontend/js/app.js'),'utf8');
 assert.match(app,/await get\('\/api\/auth\/session'\)/);assert.match(app,/profile\.isAdmin===true/);assert.match(app,/window\.location\.assign\('\/admin\/'\)/);
});

function fakeCognito({groupFailure=false}={}){return {async send(command){const name=command.constructor.name;if(name==='ListUsersCommand')return {Users:[{Username:'internal-admin-name',Attributes:[{Name:'sub',Value:'admin-sub'},{Name:'email',Value:'admin@example.com'}]},{Username:'different-user-name',Attributes:[{Name:'sub',Value:'user-sub'},{Name:'email',Value:'user@example.com'}]}]};if(name==='ListUsersInGroupCommand'){if(groupFailure)throw Object.assign(new Error('unsupported'),{name:'UnsupportedOperation'});return {Users:[{Username:'internal-admin-name',Attributes:[{Name:'sub',Value:'admin-sub'}]}]};}if(name==='AdminListGroupsForUserCommand'){if(command.input.Username==='internal-admin-name')return {Groups:[{GroupName:'Admin'}]};return {Groups:[]};}throw new Error(`Unexpected command ${name}`);}};}

test('Cognito role resolver identifies Admin and User by sub, not email username assumptions',async()=>{
 const roles=await resolveRoles(fakeCognito(),'pool',[{id:'admin-sub',email:'admin@example.com'},{id:'user-sub',email:'user@example.com'}]);
 assert.equal(roles[0].role,'Admin');assert.equal(roles[0].cognitoUsername,'internal-admin-name');assert.equal(roles[1].role,'User');
 assert.equal(await resolveUsername(fakeCognito(),'pool','user-sub'),'different-user-name');
});

test('role resolver uses bounded per-user fallback when group listing is unsupported',async()=>{
 const roles=await resolveRoles(fakeCognito({groupFailure:true}),'pool',[{id:'admin-sub'},{id:'user-sub'}]);
 assert.deepEqual(roles.map(x=>x.role),['Admin','User']);
});

test('missing Cognito identity is explicitly unavailable and never treated as User',async()=>{
 const [role]=await resolveRoles(fakeCognito(),'pool',[{id:'missing-sub',email:'orphan@example.com'}]);
 assert.equal(role.role,'Unavailable');assert.match(role.roleError,/not found/i);
});

test('frontend identifies current admin, disables unsafe actions, and wraps long values',()=>{
 const js=fs.readFileSync(path.join(root,'frontend/js/admin.js'),'utf8');const css=fs.readFileSync(path.join(root,'frontend/css/admin-fixes.css'),'utf8');
 assert.match(js,/CURRENT ADMIN/);assert.match(js,/Role unavailable/);assert.match(js,/Promote to Admin/);assert.match(js,/Accepted by SES/);assert.match(js,/Last queued notification/);
 assert.match(css,/overflow-wrap:anywhere/);assert.match(css,/min-width:0/);
});

test('admin mutations use a branded confirmation dialog instead of browser confirm',()=>{
 const html=fs.readFileSync(path.join(root,'frontend/admin/index.html'),'utf8');const js=fs.readFileSync(path.join(root,'frontend/js/admin.js'),'utf8');
 assert.match(html,/id="confirm-dialog"/);assert.match(js,/function confirmAction/);assert.doesNotMatch(js,/\bconfirm\s*\(/);
});

test('no frontend feature uses browser-native alert, confirm, or prompt dialogs',()=>{
 const directory=path.join(root,'frontend/js');
 for(const file of fs.readdirSync(directory).filter(name=>name.endsWith('.js'))){const source=fs.readFileSync(path.join(directory,file),'utf8');assert.doesNotMatch(source,/\b(?:alert|confirm|prompt)\s*\(/,`${file} contains a browser-native dialog`);}
 const userHtml=fs.readFileSync(path.join(root,'frontend/index.html'),'utf8');const adminHtml=fs.readFileSync(path.join(root,'frontend/admin/index.html'),'utf8');
 assert.match(userHtml,/id="confirm-dialog"/);assert.match(adminHtml,/id="confirm-dialog"/);
});

test('authenticated sessions survive refresh and are cleared on logout',()=>{
 const app=fs.readFileSync(path.join(root,'frontend/js/app.js'),'utf8');const admin=fs.readFileSync(path.join(root,'frontend/js/admin.js'),'utf8');const store=fs.readFileSync(path.join(root,'frontend/js/session-store.js'),'utf8');
 assert.match(store,/session\.setItem\('motorlog_session_token'/);assert.match(store,/motorlog_persistent_token/);assert.match(app,/async function restoreSession/);assert.match(app,/claims\.exp\*1000<=Date\.now\(\)/);assert.match(app,/clearStoredSession\(\)/);
 assert.match(admin,/MotorlogSessionStore\.read/);assert.match(admin,/MotorlogSessionStore\.clear/);
 assert.match(admin,/claims\.exp\*1000<=Date\.now\(\)/);assert.match(admin,/claims\['cognito:groups'\].*includes\('Admin'\)/);
 assert.doesNotMatch(app,/restoreSession[\s\S]{0,300}logout\s*\(/);
});

test('Cognito setup configures seven-hour access and ID tokens',()=>{
 const setup=fs.readFileSync(path.join(root,'scripts/setup-auth.js'),'utf8');
 assert.match(setup,/AccessTokenValidity:7/);assert.match(setup,/IdTokenValidity:7/);assert.match(setup,/AccessToken:'hours'/);assert.match(setup,/UpdateUserPoolClientCommand/);
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {requireDeleteConfirmation,RELATED_TABLES}=require('../backend/services/vehicles/account-deletion');
const db=require('../backend/shared/db');

test('account deletion requires an exact explicit confirmation',()=>{
  assert.throws(()=>requireDeleteConfirmation({confirmation:'delete'}),error=>error.status===400);
  assert.throws(()=>requireDeleteConfirmation({}),error=>error.status===400);
  assert.doesNotThrow(()=>requireDeleteConfirmation({confirmation:'DELETE'}));
});

test('account cleanup covers every owner-indexed application table in dependency order',()=>{
  assert.deepEqual(RELATED_TABLES,['Maintenance','Fuel','Expenses','Reminders','Vehicles']);
});

test('owner cleanup paginates, batches at 25, and retries unprocessed writes',async()=>{
  const original=db.client.send.bind(db.client);let queryPage=0,batchCalls=0,maxBatch=0;
  db.client.send=async command=>{
    if(command.constructor.name==='QueryCommand'){
      queryPage++;
      const count=queryPage===1?30:2;
      return {Items:Array.from({length:count},(_,i)=>({id:`${queryPage}-${i}`,ownerId:'owner-a'})),...(queryPage===1?{LastEvaluatedKey:{id:'next'}}:{})};
    }
    if(command.constructor.name==='BatchWriteCommand'){
      batchCalls++;const requests=Object.values(command.input.RequestItems)[0];maxBatch=Math.max(maxBatch,requests.length);
      if(batchCalls===1)return {UnprocessedItems:{[Object.keys(command.input.RequestItems)[0]]:requests.slice(0,1)}};
      return {UnprocessedItems:{}};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  };
  try{assert.equal(await db.deleteByOwner('Vehicles','owner-a'),32);assert.equal(queryPage,2);assert.ok(batchCalls>=4);assert.equal(maxBatch,25);}finally{db.client.send=original;}
});

test('routes enforce canonical identity, recent authentication, safety checks, and sanitized events',()=>{
  const root=path.join(__dirname,'..');
  const admin=fs.readFileSync(path.join(root,'backend/services/vehicles/admin-routes.js'),'utf8');
  const auth=fs.readFileSync(path.join(root,'backend/services/vehicles/auth-routes.js'),'utf8');
  const deletion=fs.readFileSync(path.join(root,'backend/services/vehicles/account-deletion.js'),'utf8');
  assert.match(admin,/router\.delete\('\/users\/:id'/);assert.match(admin,/USER_DELETE/);
  assert.match(auth,/router\.delete\('\/auth\/account'/);assert.match(auth,/req\.user\.sub/);assert.match(auth,/RECENT_AUTH_REQUIRED/);
  assert.match(deletion,/Cannot delete your own account from the Admin Dashboard/);assert.match(deletion,/Cannot delete the last active administrator/);
  assert.match(deletion,/resolveUsername/);assert.match(deletion,/AdminDeleteUserCommand/);
});

test('frontends use typed branded deletion dialogs and clear deleted-user preferences',()=>{
  const root=path.join(__dirname,'..');
  const user=fs.readFileSync(path.join(root,'frontend/js/app.js'),'utf8');
  const admin=fs.readFileSync(path.join(root,'frontend/js/admin.js'),'utf8');
  assert.match(user,/Account Settings/);assert.match(user,/Danger Zone/);assert.match(user,/delete-account/);assert.match(user,/motorlog_remembered_email/);
  assert.match(admin,/Delete User/);assert.match(admin,/Current Account/);assert.match(admin,/data-user-delete/);
  assert.match(user,/input\.value!==['"]DELETE['"]/);assert.match(admin,/input\.value!==['"]DELETE['"]/);
});

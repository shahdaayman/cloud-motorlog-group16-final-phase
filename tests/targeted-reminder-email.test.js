const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {parseArguments,validateTarget}=require('../scripts/test-targeted-reminder-email');

const today='2026-11-18',email='approved@example.com';
const user={id:'owner-1',email,status:'Active'};
const reminder={id:'reminder-1',ownerId:user.id,status:'Open',dueDate:'2026-11-17'};
test('targeted email test requires explicit approval arguments',()=>{
  assert.deepEqual(parseArguments(['--reminder-id','r1','--approved-email',email,'--approve-send']),{approved:true,reminderId:'r1',email});
  assert.throws(()=>parseArguments(['--unknown']),/Unknown argument/);
});
test('target validation accepts only the exact active owner and overdue open reminder',()=>{
  assert.equal(validateTarget({reminder,user,email,today}),true);
  assert.throws(()=>validateTarget({reminder,user,email:'other@example.com',today}),/does not match/);
  assert.throws(()=>validateTarget({reminder:{...reminder,status:'Completed'},user,email,today}),/not open/);
  assert.throws(()=>validateTarget({reminder:{...reminder,dueDate:today},user,email,today}),/not date-overdue/);
  assert.throws(()=>validateTarget({reminder,user:{...user,status:'Disabled'},email,today}),/not active/);
});
test('target validation blocks duplicate notification periods',()=>{
  assert.throws(()=>validateTarget({reminder:{...reminder,lastNotifiedOn:today},user,email,today}),/already claimed/);
  assert.throws(()=>validateTarget({reminder:{...reminder,lastEmailSentOn:today},user,email,today}),/already claimed/);
});
test('targeted script verifies disabled schedule, empty queue, SQS, SES, relay, and sanitized evidence',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','scripts/test-targeted-reminder-email.js'),'utf8');
  assert.match(source,/schedule\.State!=='DISABLED'/);assert.match(source,/Notification queue is not empty/);
  assert.match(source,/SendMessageCommand/);assert.match(source,/lastEmailSentOn===today/);assert.match(source,/Delivered message via Gmail SMTP/);
  assert.match(source,/recipientHash/);assert.doesNotMatch(source,/const evidence=\{[^}]*\bemail\s*:/s);
});

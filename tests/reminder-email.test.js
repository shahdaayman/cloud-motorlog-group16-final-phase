const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {SUBJECT,buildReminderEmail}=require('../backend/services/reminders/reminder-email');

test('professional reminder email provides HTML and plain-text alternatives with real data',()=>{
  const message=buildReminderEmail({reminder:{title:'Brake inspection',dueDate:'2026-11-12',dueMileageKm:85000,notes:'Check front pads and rotors.'},vehicle:{nickname:'Family Car'}});
  assert.equal(message.subject,'Motorlog — Maintenance Due Tomorrow');assert.equal(SUBJECT,message.subject);
  for(const value of ['Brake inspection','Family Car','12 November 2026','85,000 km','Check front pads and rotors.']){assert.match(message.html,new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));assert.match(message.text,new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));}
  assert.match(message.html,/role="presentation"/);assert.match(message.html,/style="/);assert.match(message.html,/background:#101b2e/);assert.match(message.html,/DUE TOMORROW/);
});
test('optional reminder values are omitted instead of invented',()=>{
  const message=buildReminderEmail({reminder:{title:'Oil change',dueDate:'9999-12-31',dueMileageKm:null,notes:''},vehicle:{nickname:'Roadster'}});
  assert.doesNotMatch(message.text,/Due date:/);assert.doesNotMatch(message.text,/Mileage target:/);assert.doesNotMatch(message.text,/Reminder notes:/);
  assert.doesNotMatch(message.html,/>Due date</);assert.doesNotMatch(message.html,/>Mileage target</);assert.doesNotMatch(message.html,/>Reminder notes</);
});
test('all user-generated HTML is escaped',()=>{
  const message=buildReminderEmail({reminder:{title:'<img src=x onerror=alert(1)>',dueDate:'2026-11-01',notes:'<script>steal()</script> & more'},vehicle:{nickname:'<b>Car</b>'}});
  assert.doesNotMatch(message.html,/<script>|<img|<b>Car/);assert.match(message.html,/&lt;img/);assert.match(message.html,/&lt;script&gt;/);assert.match(message.html,/&lt;b&gt;Car&lt;\/b&gt;/);
});
test('SES workflow sends UTF-8 HTML and text without secrets or authentication data',()=>{
  const worker=fs.readFileSync(path.join(__dirname,'..','backend/services/reminders/worker.js'),'utf8');
  assert.match(worker,/Html:\{Data:renderedEmail\.html,Charset:'UTF-8'\}/);assert.match(worker,/Text:\{Data:renderedEmail\.text,Charset:'UTF-8'\}/);
  assert.doesNotMatch(worker,/const message=buildReminderEmail/);
  assert.match(worker,/lastEmailSentOn===job\.today/);assert.match(worker,/lastEmailSentOn:job\.today/);
  const output=buildReminderEmail({reminder:{title:'Inspection'},vehicle:{nickname:'Test car'}});assert.doesNotMatch(output.html+output.text,/password|access.?token|otp|smtp|secret/i);
});
test('reminder output cannot be misclassified as a Cognito authentication email by the bridge',()=>{
  const output=buildReminderEmail({reminder:{title:'Annual inspection',dueDate:'2026-11-01',dueMileageKm:85000},vehicle:{nickname:'Test car'}});
  const body=`${output.text} ${output.html}`,content=`${output.subject} ${body}`.toLowerCase();
  assert.equal(/\{####\}|\b\d{4,8}\b/.test(body),true,'dates exercise the bridge code heuristic');
  assert.equal(/sign[ -]?in|login|log in|mfa|multi-factor|authentication code/.test(content),false);
  assert.match(output.text,/Open Motorlog/);assert.doesNotMatch(output.html,/Sign in to Motorlog/i);
});

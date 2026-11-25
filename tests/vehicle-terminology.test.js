const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');

test('vehicle UI calls make Brand while preserving the make API and storage property',()=>{
  const frontend=fs.readFileSync(path.join(root,'frontend/js/app.js'),'utf8');
  const routes=fs.readFileSync(path.join(root,'backend/services/vehicles/routes.js'),'utf8');
  assert.match(frontend,/\['make','Brand','text',true\]/);
  assert.doesNotMatch(frontend,/\['make','Make','text',true\]/);
  assert.match(routes,/body\.make/);
  assert.match(routes,/out\.make/);
  assert.match(routes,/v\.str\(body\.make,'Brand',1,60\)/);
});

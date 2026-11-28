const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy-api.ps1'), 'utf8');

test('API policy discovery handles only an expected missing resource', () => {
  assert.match(source, /get-policy[\s\S]+NotFoundErrorCodes @\('ResourceNotFoundException'\)/);
  assert.match(source, /Lambda permission not found; creating/);
  assert.doesNotMatch(source, /get-policy[^\n]+catch\s*\{\s*\}/);
});

test('correct permissions are reused and incorrect same-SID permissions are replaced', () => {
  assert.match(source, /Policy-Matches/);
  assert.match(source, /Status EXISTS "Lambda permission/);
  assert.match(source, /remove-permission[\s\S]+add-permission/);
  assert.match(source, /Lambda permission verification failed/);
});

test('stage deployment is missing, changed, or safely reused', () => {
  assert.match(source, /if\(-not \$existing\.Count\)[\s\S]+create-deployment/);
  assert.match(source, /elseif\(\$changed -or -not \$deploymentCurrent\)[\s\S]+create-deployment/);
  assert.match(source, /get-deployment[\s\S]+deploymentDescription/);
  assert.match(source, /stage is current/);
  assert.match(source, /get-stage[\s\S]+does not reference deployment/);
});

test('deployment failures remain fatal and health success is content-verified', () => {
  assert.doesNotMatch(source, /create-deployment[^\n]+2>\s*\$null/);
  assert.match(source, /StatusCode -ne 200/);
  assert.match(source, /health\.status -ne 'ok'/);
  assert.match(source, /health\.service -ne 'vehicles'/);
  assert.match(source, /health\.runtime -ne 'lambda'/);
});

test('repeat runs compare methods, integrations, permissions and gateway responses', () => {
  assert.match(source, /get-method/);
  assert.match(source, /get-integration/);
  assert.match(source, /get-gateway-response/);
  assert.match(source, /Stable-Hash/);
});

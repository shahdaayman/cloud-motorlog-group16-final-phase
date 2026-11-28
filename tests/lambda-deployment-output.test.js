const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const common = path.join(root, 'scripts', 'cloud-common.ps1');

function runDiscovery(scenario) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'motorlog-aws-test-'));
  fs.writeFileSync(path.join(bin, 'aws.cmd'), '@node "%~dp0fake-aws.js" %*\r\n');
  fs.writeFileSync(path.join(bin, 'fake-aws.js'), `
if (process.env.FAKE_AWS_SCENARIO === 'exists') {
  console.log('{"Role":{"Arn":"arn:aws:iam::000000000000:role/test"}}');
  process.exit(0);
}
if (process.env.FAKE_AWS_SCENARIO === 'missing') {
  console.error('An error occurred (NoSuchEntity) when calling the GetRole operation: Role not found');
  process.exit(254);
}
console.error('An error occurred (AccessDenied) when calling the GetRole operation: denied');
process.exit(253);
`);
  const escapedCommon = common.replace(/'/g, "''");
  const command = `. '${escapedCommon}'; try { $r=Invoke-AwsExistenceCheck -Arguments @('iam','get-role','--role-name','test') -NotFoundErrorCodes @('NoSuchEntity'); Write-Output ("EXISTS="+$r.Exists); exit 0 } catch { Write-Error $_; exit 17 }`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', command], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FAKE_AWS_SCENARIO: scenario, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  fs.rmSync(bin, { recursive: true, force: true });
  return result;
}

test('expected missing IAM resource is data, with no AWS error noise', () => {
  const result = runDiscovery('missing');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /EXISTS=False/);
  assert.equal(result.stderr, '');
});

test('existing IAM resource is detected', () => {
  const result = runDiscovery('exists');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /EXISTS=True/);
  assert.equal(result.stderr, '');
});

test('genuine AWS CLI failure remains visible and nonzero', () => {
  const result = runDiscovery('denied');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AccessDenied/);
  assert.match(result.stderr, /exit code 253/);
});

test('deployment scripts use scoped discovery and verify Lambda state and roles', () => {
  const lambdas = fs.readFileSync(path.join(root, 'scripts', 'deploy-lambdas.ps1'), 'utf8');
  const iam = fs.readFileSync(path.join(root, 'scripts', 'deploy-iam-security.ps1'), 'utf8');
  assert.match(lambdas, /\[CREATE\].*Lambda/);
  assert.match(lambdas, /\[UPDATE\].*Lambda/);
  assert.match(lambdas, /State -ne 'Active'/);
  assert.match(lambdas, /configuration\.Role -ne \$serviceRoleArn/);
  assert.match(lambdas, /CodeSha256/);
  assert.match(lambdas, /Test-EnvironmentMatches/);
  assert.match(lambdas, /\[EXISTS\].*already current/);
  assert.match(iam, /already uses/);
  assert.doesNotMatch(lambdas, /2>\s*\$null/);
  assert.doesNotMatch(iam, /2>\s*\$null/);
});

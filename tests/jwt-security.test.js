const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ISSUER = 'https://cognito-idp.test.local/test-pool';
const CLIENT_ID = 'motorlog-test-client';
const TRUSTED_KID = 'trusted-test-key';
const UNTRUSTED_KID = 'untrusted-test-key';

let jose;
let trustedPrivateKey;
let untrustedPrivateKey;
let verifyToken;
let jwksServer;

function baseClaims(overrides = {}) {
  return {
    sub: 'security-test-user',
    token_use: 'access',
    client_id: CLIENT_ID,
    ...overrides,
  };
}

async function signedToken(claims = {}, options = {}) {
  const key = options.key || trustedPrivateKey;
  const kid = options.kid || TRUSTED_KID;
  const issuer = options.issuer || ISSUER;
  const token = new jose.SignJWT(baseClaims(claims))
    .setProtectedHeader({alg: 'RS256', kid, typ: 'JWT'})
    .setIssuer(issuer)
    .setIssuedAt();
  if (options.expiration !== false) token.setExpirationTime(options.expiration || '5m');
  return token.sign(key);
}

function mutateSegment(token, segmentIndex) {
  const segments = token.split('.');
  const bytes = Buffer.from(segments[segmentIndex], 'base64url');
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  segments[segmentIndex] = bytes.toString('base64url');
  return segments.join('.');
}

test.before(async () => {
  jose = await import('jose');
  const trusted = await jose.generateKeyPair('RS256', {extractable: true});
  const untrusted = await jose.generateKeyPair('RS256', {extractable: true});
  trustedPrivateKey = trusted.privateKey;
  untrustedPrivateKey = untrusted.privateKey;
  const trustedJwk = await jose.exportJWK(trusted.publicKey);
  Object.assign(trustedJwk, {kid: TRUSTED_KID, alg: 'RS256', use: 'sig'});

  jwksServer = http.createServer((req, res) => {
    if (req.url !== '/.well-known/jwks.json') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({keys: [trustedJwk]}));
  });
  await new Promise((resolve, reject) => {
    jwksServer.once('error', reject);
    jwksServer.listen(0, '127.0.0.1', resolve);
  });
  const address = jwksServer.address();
  process.env.COGNITO_USER_POOL_ID = 'test-pool';
  process.env.COGNITO_APP_CLIENT_ID = CLIENT_ID;
  process.env.COGNITO_ISSUER = ISSUER;
  process.env.COGNITO_JWKS_URL = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
  ({verifyToken} = require('../backend/shared/auth'));
});

test.after(async () => {
  await new Promise((resolve, reject) => jwksServer.close(error => error ? reject(error) : resolve()));
});

test('valid RS256-signed access token is accepted', async () => {
  const payload = await verifyToken(await signedToken());
  assert.equal(payload.sub, 'security-test-user');
  assert.equal(payload.token_use, 'access');
  assert.equal(payload.client_id, CLIENT_ID);
});

test('JWT with a modified payload is rejected', async () => {
  const token = await signedToken();
  const segments = token.split('.');
  const payload = JSON.parse(Buffer.from(segments[1], 'base64url'));
  payload.sub = 'attacker';
  segments[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  await assert.rejects(verifyToken(segments.join('.')));
});

test('JWT with a modified signature is rejected', async () => {
  await assert.rejects(verifyToken(mutateSegment(await signedToken(), 2)));
});

test('JWT signed by an untrusted key is rejected', async () => {
  const token = await signedToken({}, {key: untrustedPrivateKey, kid: UNTRUSTED_KID});
  await assert.rejects(verifyToken(token));
});

test('expired JWT is rejected', async () => {
  await assert.rejects(verifyToken(await signedToken({}, {expiration: '1 second ago'})));
});

test('JWT with an incorrect issuer is rejected', async () => {
  await assert.rejects(verifyToken(await signedToken({}, {issuer: 'https://issuer.invalid/wrong-pool'})));
});

test('JWT with the wrong Cognito app client ID is rejected', async () => {
  await assert.rejects(verifyToken(await signedToken({client_id: 'wrong-client'})));
});

test('ID token used instead of access token is rejected', async () => {
  await assert.rejects(verifyToken(await signedToken({token_use: 'id', aud: CLIENT_ID, client_id: undefined})));
});

test('JWT using alg none is rejected', async () => {
  const header = Buffer.from(JSON.stringify({alg: 'none', typ: 'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({...baseClaims(), iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 300})).toString('base64url');
  await assert.rejects(verifyToken(`${header}.${payload}.`));
});

test('malformed JWT is rejected', async () => {
  await assert.rejects(verifyToken('not-a-jwt'));
});

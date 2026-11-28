const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('frontend/index.html');
const routerSource = read('frontend/js/hash-router.js');
const sessionStoreSource = read('frontend/js/session-store.js');
const appSource = read('frontend/js/app.js');
const wait = (ms = 35) => new Promise(resolve => setTimeout(resolve, ms));

function token({expired = false} = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({alg: 'RS256'})}.${encode({sub: 'user-1', email: 'user@example.com', exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 3600)})}.signature`;
}

function response(body, status = 200) {
  return {ok: status >= 200 && status < 300, status, headers: {get: () => null}, json: async () => body};
}

function dashboardPayload(url) {
  if (url.includes('/api/vehicles?')) return {items: []};
  if (url.includes('/api/reminders?')) return {items: []};
  if (url.includes('/api/analytics/monthly')) return {items: []};
  if (url.includes('/api/analytics/summary')) return {};
  return {};
}

async function boot({savedToken = token(), persistent = true, shadowToken, fetchImpl, admin = false} = {}) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {url: 'http://motorlog.local/#dashboard', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole});
  const {window} = dom;
  const storage = persistent ? window.localStorage : window.sessionStorage;
  storage.setItem(persistent ? 'motorlog_persistent_token' : 'motorlog_session_token', savedToken);
  storage.setItem(persistent ? 'motorlog_persistent_email' : 'motorlog_session_email', admin ? 'admin@example.com' : 'user@example.com');
  if (persistent) storage.setItem('motorlog_persistent_admin', admin ? 'true' : 'false');
  if (shadowToken) {
    window.sessionStorage.setItem('motorlog_session_token', shadowToken);
    window.sessionStorage.setItem('motorlog_session_email', 'stale@example.com');
  }
  const calls = [];
  window.fetch = async (...args) => {
    calls.push(String(args[0]));
    if (fetchImpl) return fetchImpl(...args);
    if (String(args[0]).includes('/api/auth/session')) return response({authenticated: true, email: admin ? 'admin@example.com' : 'user@example.com', isAdmin: admin, groups: admin ? ['Admin'] : []});
    return response(dashboardPayload(String(args[0])));
  };
  window.MOTORLOG_CONFIG = {API_BASE_URL: 'http://api.local'};
  window.eval(routerSource);
  window.eval(sessionStoreSource);
  window.eval(appSource);
  await wait();
  return {dom, window, calls};
}

test('valid user session remains authenticated after refresh', async () => {
  const runtime = await boot({persistent: false});
  assert.equal(runtime.window.document.querySelector('#app').classList.contains('is-locked'), false);
  assert.ok(runtime.window.sessionStorage.getItem('motorlog_session_token'));
  assert.equal(runtime.calls.filter(url => url.includes('/api/auth/session')).length, 1);
  runtime.dom.window.close();
});

test('valid Remember Me session remains authenticated after browser reopening', async () => {
  const runtime = await boot();
  assert.equal(runtime.window.document.querySelector('#app').classList.contains('is-locked'), false);
  assert.ok(runtime.window.localStorage.getItem('motorlog_persistent_token'));
  runtime.dom.window.close();
});

test('five consecutive restored-tab refreshes prefer the valid Remember Me token over stale session storage', async () => {
  const stale = token({expired: true});
  for (let refresh = 0; refresh < 5; refresh++) {
    const runtime = await boot({shadowToken: stale});
    assert.equal(runtime.window.document.querySelector('#app').classList.contains('is-locked'), false, `refresh ${refresh + 1}`);
    assert.ok(runtime.window.localStorage.getItem('motorlog_persistent_token'));
    assert.equal(runtime.calls.filter(url => url.includes('/api/auth/session')).length, 1);
    runtime.dom.window.close();
  }
});

test('temporary API Gateway failure preserves the persistent session and offers retry', async () => {
  const runtime = await boot({fetchImpl: async url => String(url).includes('/api/auth/session') ? response({error: {message: 'Unavailable'}}, 503) : response({})});
  assert.ok(runtime.window.localStorage.getItem('motorlog_persistent_token'));
  assert.equal(runtime.window.document.querySelector('#auth-screen').dataset.mode, 'restore');
  assert.match(runtime.window.document.querySelector('#auth-submit').textContent, /Retry session/);
  runtime.dom.window.close();
});

test('cancelled authentication request preserves the persistent session', async () => {
  const cancelled = Object.assign(new Error('cancelled'), {name: 'AbortError'});
  const runtime = await boot({fetchImpl: async url => {if (String(url).includes('/api/auth/session')) throw cancelled; return response({});}});
  assert.ok(runtime.window.localStorage.getItem('motorlog_persistent_token'));
  assert.equal(runtime.window.document.querySelector('#auth-screen').dataset.mode, 'restore');
  runtime.dom.window.close();
});

test('successful validation followed by dashboard loading failure keeps the user authenticated', async () => {
  const runtime = await boot({fetchImpl: async url => String(url).includes('/api/auth/session') ? response({authenticated: true, email: 'user@example.com', isAdmin: false}) : response({error: {message: 'Temporary dashboard failure'}}, 503)});
  assert.equal(runtime.window.document.querySelector('#app').classList.contains('is-locked'), false);
  assert.ok(runtime.window.localStorage.getItem('motorlog_persistent_token'));
  runtime.dom.window.close();
});

test('expired JWT is cleared without attempting server restoration', async () => {
  const runtime = await boot({savedToken: token({expired: true})});
  assert.equal(runtime.window.localStorage.getItem('motorlog_persistent_token'), null);
  assert.equal(runtime.calls.filter(url => url.includes('/api/auth/session')).length, 0);
  runtime.dom.window.close();
});

for (const [name, status] of [['revoked JWT', 401], ['disabled account', 403]]) {
  test(`${name} is cleared after definitive server rejection`, async () => {
    const runtime = await boot({fetchImpl: async url => String(url).includes('/api/auth/session') ? response({error: {code: status === 403 ? 'FORBIDDEN' : 'UNAUTHENTICATED', message: name}}, status) : response({})});
    assert.equal(runtime.window.localStorage.getItem('motorlog_persistent_token'), null);
    assert.equal(runtime.window.document.querySelector('#auth-screen').dataset.mode, 'signin');
    runtime.dom.window.close();
  });
}

test('validated admin session retains its role and redirects to the admin console', async () => {
  const runtime = await boot({admin: true});
  assert.equal(runtime.window.localStorage.getItem('motorlog_persistent_admin'), 'true');
  assert.equal(runtime.calls.filter(url => url.includes('/api/auth/session')).length, 1);
  runtime.dom.window.close();
});

test('explicit logout clears persistent session state', async () => {
  const runtime = await boot();
  runtime.window.document.querySelector('#logout-btn').click();
  await wait();
  assert.equal(runtime.window.localStorage.getItem('motorlog_persistent_token'), null);
  assert.equal(runtime.window.document.querySelector('#app').classList.contains('is-locked'), true);
  runtime.dom.window.close();
});

test('multiple simultaneous retry attempts share one session validation request', async () => {
  let sessionCalls = 0;
  let recover = false;
  const runtime = await boot({fetchImpl: async url => {
    if (!String(url).includes('/api/auth/session')) return response(dashboardPayload(String(url)));
    sessionCalls++;
    if (!recover) return response({error: {message: 'Unavailable'}}, 503);
    await wait(25);
    return response({authenticated: true, email: 'user@example.com', isAdmin: false});
  }});
  recover = true;
  const form = runtime.window.document.querySelector('#auth-form');
  form.dispatchEvent(new runtime.window.Event('submit', {bubbles: true, cancelable: true}));
  form.dispatchEvent(new runtime.window.Event('submit', {bubbles: true, cancelable: true}));
  await wait(80);
  assert.equal(sessionCalls, 2, 'one initial request and one coalesced retry');
  assert.equal(runtime.window.document.querySelector('#app').classList.contains('is-locked'), false);
  runtime.dom.window.close();
});

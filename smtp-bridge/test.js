'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { partsForDelivery } = require('./message');

test('Cognito sign-in email becomes HTML without changing its code', () => {
  const result = partsForDelivery({ subject: 'Motorlog sign-in verification code', text: 'Your authentication code is 123456.' });
  assert.equal(result.kind, 'login');
  assert.match(result.html, /123456/);
  assert.match(result.text, /123456/);
  assert.match(result.html, /Motorlog/i);
});

test('HTML colors and dimensions are never mistaken for the Cognito code', () => {
  const html = '<html><body style="color:#697891;max-width:1200px"><p>Enter this sign-in code:</p><strong>87654321</strong></body></html>';
  const result = partsForDelivery({ subject: 'Motorlog sign-in verification code', text: html });
  assert.equal(result.kind, 'login');
  assert.match(result.html, /87654321/);
  assert.doesNotMatch(result.html, />697891</);
});

test('ordinary HTML messages are preserved', () => {
  const html = '<html><body><p>Maintenance reminder</p></body></html>';
  const result = partsForDelivery({ subject: 'Reminder', html });
  assert.equal(result.html, html);
  assert.equal(result.kind, null);
});

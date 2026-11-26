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

test('ordinary HTML messages are preserved', () => {
  const html = '<html><body><p>Maintenance reminder</p></body></html>';
  const result = partsForDelivery({ subject: 'Reminder', html });
  assert.equal(result.html, html);
  assert.equal(result.kind, null);
});

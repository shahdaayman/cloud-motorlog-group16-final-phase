'use strict';

const { SMTPServer } = require('smtp-server');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const { partsForDelivery } = require('./message');

const user = process.env.SMTP_EMAIL;
const password = process.env.SMTP_APP_PASSWORD;
if (!user || !password) {
  console.error('SMTP_EMAIL and SMTP_APP_PASSWORD must be configured.');
  process.exit(1);
}

const allowAnyRecipient = process.env.SMTP_ALLOW_ANY_RECIPIENT === 'true';
const allowed = (process.env.SMTP_ALLOWED_RECIPIENTS || '')
  .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
if (!allowAnyRecipient && !allowed.length) {
  console.error('Set SMTP_ALLOW_ANY_RECIPIENT=true or configure SMTP_ALLOWED_RECIPIENTS.');
  process.exit(1);
}
const allowedSet = new Set(allowed);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_UPSTREAM_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_UPSTREAM_PORT || 587),
  secure: false,
  requireTLS: true,
  authMethod: 'LOGIN',
  auth: { user, pass: password },
  connectionTimeout: 20000,
  greetingTimeout: 20000,
  socketTimeout: 30000,
});

const server = new SMTPServer({
  name: 'motorlog-html-delivery',
  banner: 'Motorlog local SMTP HTML delivery bridge',
  secure: false,
  authOptional: true,
  hideSTARTTLS: true,
  disabledCommands: ['AUTH', 'STARTTLS'],
  size: 256 * 1024,
  logger: false,
  onRcptTo(address, session, done) {
    if (!allowAnyRecipient && !allowedSet.has(address.address.toLowerCase())) {
      return done(new Error('Recipient is not in SMTP_ALLOWED_RECIPIENTS.'));
    }
    done();
  },
  async onData(stream, session, done) {
    try {
      const message = await simpleParser(stream);
      const recipients = session.envelope.rcptTo.map(item => item.address.toLowerCase());
      if (!recipients.length || recipients.length > 5 ||
          (!allowAnyRecipient && !recipients.every(item => allowedSet.has(item)))) {
        return done(new Error('Recipient blocked or recipient count exceeded.'));
      }
      const { subject, html, text, converted } = partsForDelivery(message);
      if (!text && !html) return done(new Error('Empty email body.'));
      await transporter.sendMail({
        from: { name: 'Motorlog', address: user },
        to: recipients,
        subject: String(subject || message.subject || 'Motorlog notification').slice(0, 200),
        text,
        ...(html ? { html } : {}),
        envelope: { from: user, to: recipients },
      });
      console.log(`Delivered message via Gmail SMTP (HTML upgraded: ${converted ? 'yes' : 'no'}).`);
      done();
    } catch (error) {
      console.error('Delivery failed:', error.code || error.name || 'SMTP_ERROR');
      done(new Error('Upstream SMTP delivery failed.'));
    }
  },
});

server.listen(1025, '0.0.0.0', () => {
  console.log('Motorlog HTML delivery bridge listening on internal Docker port 1025.');
});

function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

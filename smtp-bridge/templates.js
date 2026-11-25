'use strict';

const SUBJECTS = {
  signup: 'Welcome to Motorlog — Verify Your Email',
  login: 'Motorlog — Your Sign-In Verification Code',
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function classifyAuthenticationEmail(mail) {
  const subject = String(mail.subject || '');
  const body = `${mail.text || ''} ${mail.html || ''}`;
  const content = `${subject} ${body}`.toLowerCase();
  if (!/\{####\}|\b\d{4,8}\b/.test(body)) return null;
  if (/sign[ -]?in|login|log in|mfa|multi-factor|authentication code/.test(content)) return 'login';
  if (/confirm|confirmation|verify|verification|welcome|sign[ -]?up|register/.test(content)) return 'signup';
  return null;
}

function extractCode(mail) {
  const match = `${mail.text || ''} ${mail.html || ''}`.match(/\{####\}|\b\d{4,8}\b/);
  return match ? match[0] : null;
}

function textTemplate(kind, code) {
  const signup = kind === 'signup';
  return [
    'MOTORLOG', '', signup ? 'Welcome to Motorlog' : 'Confirm your sign-in',
    signup ? 'Use this verification code to confirm your email address:' : 'Use this one-time verification code to finish signing in:',
    '', code, '',
    signup
      ? 'Enter this code in Motorlog to finish creating your account. The code expires automatically; request a new one if it is no longer accepted.'
      : 'Enter the code promptly. It expires automatically and can only be used for this authentication attempt.',
    '', 'Never share this code. If you did not request it, you can safely ignore this email.', '',
    'Motorlog · Your vehicle life, organized',
  ].join('\n');
}

function htmlTemplate(kind, code) {
  const signup = kind === 'signup';
  const title = signup ? 'Welcome to Motorlog' : 'Confirm your sign-in';
  const intro = signup
    ? 'Use this code to confirm your email address and finish creating your account.'
    : 'Use this one-time verification code to finish signing in to Motorlog.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(SUBJECTS[kind])}</title></head>
<body style="margin:0;padding:0;background:#eef3f5;font-family:Arial,Helvetica,sans-serif;color:#172b3a">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef3f5"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 30px rgba(13,35,52,.1)">
<tr><td style="background:#0d2334;padding:28px 36px;border-bottom:4px solid #27d3a2;font-size:25px;font-weight:700;color:#fff">motorlog<span style="color:#27d3a2">.</span></td></tr>
<tr><td style="padding:42px 36px 18px"><h1 style="margin:0 0 16px;font-size:30px;color:#0d2334">${title}</h1><p style="margin:0;font-size:16px;line-height:1.65;color:#526674">${intro}</p></td></tr>
<tr><td style="padding:14px 36px 22px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eafbf6;border:1px solid #bcefdc;border-radius:14px"><tr><td align="center" style="padding:24px 16px 10px;font-size:11px;font-weight:700;letter-spacing:1.7px;text-transform:uppercase;color:#367565">Your verification code</td></tr><tr><td align="center" style="padding:0 12px 24px;font-family:monospace;font-size:38px;font-weight:700;letter-spacing:8px;color:#0d2334">${escapeHtml(code)}</td></tr></table></td></tr>
<tr><td style="padding:0 36px 38px;font-size:14px;line-height:1.65;color:#526674">This code expires automatically and can only be used for this authentication attempt. Never share it with anyone.</td></tr>
<tr><td align="center" style="background:#0d2334;padding:24px 30px;font-size:12px;color:#91a7b5">Motorlog · Your vehicle life, organized<br>This is an automated security email.</td></tr>
</table></td></tr></table></body></html>`;
}

function renderAuthenticationEmail(kind, code) {
  if (!SUBJECTS[kind] || !code) throw new Error('A known email type and Cognito code are required.');
  return { subject: SUBJECTS[kind], text: textTemplate(kind, code), html: htmlTemplate(kind, code) };
}

module.exports = { SUBJECTS, classifyAuthenticationEmail, extractCode, renderAuthenticationEmail };

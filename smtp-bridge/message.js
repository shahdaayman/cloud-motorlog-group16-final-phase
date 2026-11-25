'use strict';

const { classifyAuthenticationEmail, extractCode, renderAuthenticationEmail } = require('./templates');

function looksLikeHtml(value) {
  return typeof value === 'string' && /^\s*(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(value);
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|tr|div|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}

function partsForDelivery(mail) {
  const kind = classifyAuthenticationEmail(mail);
  const code = kind && extractCode(mail);
  if (kind && code) return { ...renderAuthenticationEmail(kind, code), converted: true, kind };
  const plain = typeof mail.text === 'string' ? mail.text : '';
  const providedHtml = typeof mail.html === 'string' ? mail.html : '';
  const markupFromPlain = !providedHtml && looksLikeHtml(plain) && /motorlog/i.test(plain);
  const html = providedHtml || (markupFromPlain ? plain : null);
  let text = markupFromPlain ? stripHtml(plain) : plain;
  if (!text && html) text = stripHtml(html);
  return { subject: String(mail.subject || 'Motorlog notification'), html, text, converted: markupFromPlain, kind: null };
}

module.exports = { looksLikeHtml, partsForDelivery };

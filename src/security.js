'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'peopleops_session';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signValue(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createSessionToken(user, secret, ttlSeconds = 60 * 60 * 8) {
  const payload = {
    uid: user.id,
    role: user.role,
    csrf: crypto.randomBytes(18).toString('base64url'),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${signValue(encoded, secret)}`;
}

function readSessionToken(token, secret) {
  try {
    const [encoded, signature] = String(token || '').split('.');
    if (!encoded || !signature) return null;
    const expected = signValue(encoded, secret);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.uid || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const index = part.indexOf('=');
        return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function sessionCookie(token, secure = false) {
  const flags = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=28800'
  ];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

function clearSessionCookie(secure = false) {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSessionToken,
  readSessionToken,
  parseCookies,
  sessionCookie,
  clearSessionCookie
};

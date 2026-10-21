import crypto from 'node:crypto';

// Signed cookie values: base64url(JSON payload) "." base64url(HMAC-SHA256).
// Every role/tenant gets its own key, derived with HKDF from COOKIE_SECRET, so a cookie
// minted for branch A cannot verify for branch B even with an identical payload.

const SALT = 'smart-pager/v2';
const keys = new Map();

export function deriveKey(secret, info) {
  const id = `${info}|${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = Buffer.from(crypto.hkdfSync('sha256', secret, SALT, info, 32));
    keys.set(id, key);
  }
  return key;
}

export function signValue(secret, info, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', deriveKey(secret, info)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Returns the payload, or null when the value is missing, malformed or signed with another key. */
export function verifyValue(secret, info, value) {
  if (typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = crypto.createHmac('sha256', deriveKey(secret, info)).update(body).digest();
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export const staffCookieName = (branchId) => `sp_staff_${branchId}`;
export const staffKeyInfo = (branchId) => `staff:${branchId}`;

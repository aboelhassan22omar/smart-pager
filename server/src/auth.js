import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 16384;
const KEYLEN = 32;

export const PIN_RE = /^\d{4,8}$/;
export const SESSION_MAX_AGE = 30 * 24 * 3600;
export const cookieName = (shopId) => `sp_bar_${shopId}`;

export async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pin, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPin(pin, stored) {
  if (typeof pin !== 'string' || typeof stored !== 'string') return false;
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(pin, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n) });
  return crypto.timingSafeEqual(actual, expected);
}

// Changes whenever the PIN changes, which invalidates every existing session.
export const pinFingerprint = (pinHash) =>
  crypto.createHash('sha256').update(pinHash).digest('base64url').slice(0, 16);

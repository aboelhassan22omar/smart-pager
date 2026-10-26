import crypto from 'node:crypto';
import { deriveKey } from './cookies.js';

// Credentials the super must be able to read back (branch PIN, owner password), sealed with
// AES-256-GCM under a key derived from COOKIE_SECRET. The hash stays the only thing logins check;
// this copy is for display. Values from before this existed (or after a COOKIE_SECRET change)
// open to null and the dashboard says so.

const KEY_INFO = 'vault:v1';
const PREFIX = 'v1';

export function seal(secret, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, KEY_INFO), iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [PREFIX, iv, body, cipher.getAuthTag()].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** The sealed text, or null when missing, malformed or sealed under another secret. */
export function unseal(secret, sealed) {
  if (typeof sealed !== 'string') return null;
  const [prefix, iv, body, tag] = sealed.split('.');
  if (prefix !== PREFIX || !iv || body === undefined || !tag) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret, KEY_INFO), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

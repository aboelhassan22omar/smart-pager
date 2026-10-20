import crypto from 'node:crypto';

export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const dayFormats = new Map();

// Calendar day (YYYY-MM-DD) in the shop timezone; order numbers reset when it changes.
export function dayIn(tz, date = new Date()) {
  let fmt = dayFormats.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(tz, fmt);
  }
  return fmt.format(date);
}

import crypto from 'node:crypto';

export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const partFormats = new Map();

/** Epoch ms of local midnight (in `tz`) of the day that contains `now`. */
export function startOfDayIn(tz, now = Date.now()) {
  let fmt = partFormats.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partFormats.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(now)).map((x) => [x.type, Number(x.value)]));
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = wallAsUtc - Math.floor(now / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day) - offset;
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

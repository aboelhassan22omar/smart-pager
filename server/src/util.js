import crypto from 'node:crypto';

export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const partFormats = new Map();

function wallParts(tz, ts) {
  let fmt = partFormats.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    partFormats.set(tz, fmt);
  }
  const p = {};
  for (const x of fmt.formatToParts(new Date(ts))) p[x.type] = x.type === 'weekday' ? x.value : Number(x.value);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
  return { ...p, offset };
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Epoch ms of the start of the local hour (in `tz`) that contains `ts` (DST- and :30-safe). */
export function hourStartIn(tz, ts) {
  const { offset } = wallParts(tz, ts);
  return ts - ((((ts + offset) % 3_600_000) + 3_600_000) % 3_600_000);
}

/** Local weekday (0 = Sunday) and hour (0-23) of `ts` in `tz`. */
export function localSlot(tz, ts) {
  const p = wallParts(tz, ts);
  return { weekday: WEEKDAYS[p.weekday], hour: p.hour };
}

/** Epoch ms of local midnight of a YYYY-MM-DD day in `tz`. */
export function dayStartIn(tz, day) {
  return startOfDayIn(tz, Date.parse(`${day}T12:00:00Z`));
}

/** Epoch ms of local midnight (in `tz`) of the day that contains `now`. */
export function startOfDayIn(tz, now = Date.now()) {
  const p = wallParts(tz, now);
  return Date.UTC(p.year, p.month - 1, p.day) - p.offset;
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

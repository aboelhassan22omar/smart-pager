import crypto from 'node:crypto';
import { passwordFields, pinFields } from './auth.js';
import { dayIn, startOfDayIn } from './util.js';

// The public demo café (/demo): one brand with one branch that every visitor of the ad link
// shares. It is created on the first visit, never expires, and its settings can't be changed
// from the demo (see demoLocked). Its owner dashboard always has two weeks of sample orders.

export const DEMO_ID = 'demo';
export const DEMO_NAME = 'كافيه الديمو';
const DEMO_OWNER = 'demo.visitor';
const SEED_DAYS = 14;
const SEED_PREFIX = 'seed-';
export const DEMO_LOCKED = 'دي نسخة الديمو: الإعدادات مقفولة هنا، وبتتغيّر عادي في النسخة بتاعتك';

export const isDemo = (id) => id === DEMO_ID;

let creating = null;

/** The demo branch context and its owner, created on first use. */
export async function ensureDemo(deps) {
  const { control, tenants, config } = deps;
  const ready = () => {
    const ctx = tenants.get(DEMO_ID);
    const first = control.ownersOfBrand(DEMO_ID)[0];
    const owner = first && control.getOwner(first.id); // the full row (session version)
    return ctx?.store.getShop() && owner ? { ctx, owner } : null;
  };
  const existing = ready();
  if (existing) return existing;
  creating ??= create(deps).finally(() => {
    creating = null;
  });
  await creating;
  topUpDemo({ tenants, config });
  return ready();
}

async function create({ control, tenants, config }) {
  if (!control.getBrand(DEMO_ID)) control.createBrand({ id: DEMO_ID, name: DEMO_NAME });
  if (!control.getBranch(DEMO_ID)) {
    // No trial and no paid_until: active with no end date.
    control.createBranch({ id: DEMO_ID, brandId: DEMO_ID, name: DEMO_NAME, area: 'تجربة' });
    for (const feature of ['review', 'loyalty', 'promo']) control.setFeature(DEMO_ID, feature, true);
  }
  const ctx = tenants.get(DEMO_ID);
  if (!ctx.store.getShop()) {
    const pin = String(crypto.randomInt(100000, 1000000));
    const cols = await pinFields(config.cookieSecret, pin);
    ctx.store.initSettings({ pinHash: cols.pin_hash, pinSealed: cols.pin_sealed, qrMode: 'both' });
    ctx.store.updateShop({
      expire_hours: 1,
      preparing_message: 'طلبك بيتحضّر دلوقتي. هنرن عليك أول ما يجهز',
      ready_message: 'طلبك جاهز، اتفضّل استلمه من الكاشير',
      loyalty_every: 5,
      loyalty_reward_text: 'مشروب ببلاش',
      promo_text: 'خصم ١٠٪ على أي حلو مع القهوة النهارده',
    });
  }
  if (!control.ownersOfBrand(DEMO_ID).length && !control.ownerByUsername(DEMO_OWNER)) {
    const fields = await passwordFields(config.cookieSecret, crypto.randomBytes(9).toString('base64url'));
    control.createOwner({ brandId: DEMO_ID, username: DEMO_OWNER, ...fields });
  }
}

// ---------------------------------------------------------------------------
// Sample history: closed orders and ratings for each of the last SEED_DAYS days.
// Deterministic per day, and only added for days that don't have it yet.
// ---------------------------------------------------------------------------

function rng(seedText) {
  let a = crypto.createHash('sha256').update(seedText).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Relative traffic per local hour: a morning coffee rush, lunch, and a busy evening.
const HOUR_WEIGHT = [0, 0, 0, 0, 0, 0, 0, 0, 2, 5, 7, 5, 4, 5, 6, 4, 3, 4, 6, 8, 9, 8, 5, 2];
const COMMENTS = {
  5: ['القهوة تحفة والرقم رن أول ما الطلب جهز', 'سريعين جدًا', null, null, null],
  4: ['حلو، بس الزحمة كانت كتير', null, null],
  3: ['الطلب اتأخر شوية', null],
  2: ['استنيت كتير النهارده'],
};

function seedDay(store, day, dayStart) {
  const rand = rng(`demo|${day}`);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const busy = weekday === 4 || weekday === 5 ? 1.35 : 1; // Thursday/Friday nights
  const total = Math.round((45 + rand() * 30) * busy);
  const weightSum = HOUR_WEIGHT.reduce((s, w) => s + w, 0);
  const orders = [];
  for (let i = 0; i < total; i++) {
    let pick = rand() * weightSum;
    let hour = 0;
    while (pick > HOUR_WEIGHT[hour]) pick -= HOUR_WEIGHT[hour++];
    const createdAt = dayStart + hour * 3_600_000 + Math.floor(rand() * 3_600_000);
    orders.push(createdAt);
  }
  orders.sort((a, b) => a - b);

  const insert = store.db.prepare(`INSERT OR IGNORE INTO orders (id, number, status, created_at, ready_at, closed_at, notify_count)
                                   VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const feedback = store.db.prepare('INSERT OR IGNORE INTO feedback (order_id, rating, comment, created_at) VALUES (?, ?, ?, ?)');
  orders.forEach((createdAt, i) => {
    const id = `${SEED_PREFIX}${day}-${String(i + 1).padStart(4, '0')}`;
    const roll = rand();
    if (roll < 0.04) {
      insert.run(id, i + 1, 'cancelled', createdAt, null, createdAt + 120_000, 0);
      return;
    }
    // Prep 3-9 minutes, with a slow tail at rush hour that makes some orders late.
    const prep = (3 + rand() * 6 + (rand() < 0.12 ? 4 + rand() * 6 : 0)) * 60_000;
    const readyAt = createdAt + Math.round(prep);
    const pickedAt = readyAt + Math.round((0.4 + rand() * 2.5) * 60_000);
    insert.run(id, i + 1, 'picked', createdAt, readyAt, pickedAt, rand() < 0.15 ? 2 : 1);
    if (rand() < 0.18) {
      const r = rand();
      const rating = r < 0.62 ? 5 : r < 0.88 ? 4 : r < 0.96 ? 3 : 2;
      const options = COMMENTS[rating];
      feedback.run(id, rating, options[Math.floor(rand() * options.length)], pickedAt + 60_000);
    }
  });
  return orders.length ? orders[0] : null;
}

/** Adds the sample history for any of the last SEED_DAYS days that lack it (cheap when done). */
export function topUpDemo({ tenants, config }, now = Date.now()) {
  const ctx = tenants.get(DEMO_ID);
  if (!ctx?.store.getShop()) return 0;
  const { db } = ctx.store;
  const has = db.prepare('SELECT 1 FROM orders WHERE id = ?');
  let earliest = null;
  let added = 0;
  db.exec('BEGIN');
  try {
    // Past days only: today's numbers are the visitors' own orders.
    for (let d = SEED_DAYS; d >= 1; d--) {
      const dayStart = startOfDayIn(config.tz, now - d * 86_400_000);
      const day = dayIn(config.tz, new Date(dayStart + 12 * 3_600_000));
      if (has.get(`${SEED_PREFIX}${day}-0001`)) continue;
      const first = seedDay(ctx.store, day, dayStart);
      if (first != null) {
        earliest = earliest == null ? first : Math.min(earliest, first);
        added++;
      }
    }
    // Let the hourly rollups pick the new (past) orders up.
    if (earliest != null) {
      const cursor = Number(db.prepare("SELECT value FROM meta WHERE key = 'rollup_at'").get()?.value ?? 0);
      if (cursor >= earliest) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('rollup_at', ?)").run(String(earliest - 1));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return added;
}

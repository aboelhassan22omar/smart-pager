import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { loyaltyHtml } from '../public/js/loyalty-card.js';
import { aheadText, etaText } from '../public/js/queue-text.js';
import { hashPin } from '../src/auth.js';
import { openStorage } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { hashDevice } from '../src/loyalty.js';
import { provisionBrand, provisionBranch } from '../src/provision.js';
import { etaStats, percentile, queueFor } from '../src/queue.js';
import { parsePlaceId, upgradeLegacyReview } from '../src/upgrades.js';
import { ADMIN_TOKEN, client, sse, startServer } from './helpers.js';

const MIN = 60_000;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const admin = { headers: { 'x-admin-token': ADMIN_TOKEN } };
const keyOf = (state) => new URL(state.qr.staticUrl).searchParams.get('k');

/** Inserts `n` finished orders with prep times between `fromMin` and `toMin`, `daysAgo` back. */
function seedHistory(dbFile, { n, fromMin, toMin, at }) {
  const db = new DatabaseSync(dbFile);
  const ins = db.prepare("INSERT INTO orders (id, number, status, created_at, ready_at, closed_at) VALUES (?, ?, 'picked', ?, ?, ?)");
  for (let i = 0; i < n; i++) {
    const created = at - i * 7 * 86_400_000 / Math.max(1, n) - 3 * MIN;
    const prep = (fromMin + ((toMin - fromMin) * i) / Math.max(1, n - 1)) * MIN;
    ins.run(`hist-${i}-${Math.random().toString(36).slice(2, 10)}`, i + 1, created, created + prep, created + prep + MIN);
  }
  db.close();
}

// ---------------------------------------------------------------------------
// Phase 4: queue position + ETA
// ---------------------------------------------------------------------------

describe('queue position and ETA', () => {
  test('copy helpers', () => {
    assert.equal(aheadText(0), 'طلبك الجاي');
    assert.equal(aheadText(1), 'قدامك طلب واحد');
    assert.equal(aheadText(2), 'قدامك طلبين');
    assert.equal(aheadText(7), 'قدامك 7 طلبات');
    const now = 1_000_000;
    assert.equal(etaText(null, now), '');
    assert.equal(etaText({ lowAt: now + 5 * MIN, highAt: now + 8 * MIN }, now), 'حوالي 5–8 دقايق');
    assert.equal(etaText({ lowAt: now - MIN, highAt: now + 30_000 }, now), 'حوالي 1 دقايق');
    assert.equal(etaText({ lowAt: now - 5 * MIN, highAt: now - MIN }, now), 'خلاص قرّب');
    assert.equal(percentile([1, 2, 3, 4, 5], 0.25), 2);
    assert.equal(percentile([1, 2, 3, 4, 5], 0.75), 4);
  });

  test('ETA uses the same weekday+hour, falls back to 14 days, needs 20 samples', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-eta-'));
    const config = loadConfig({ DATA_DIR: dir, TZ: 'Africa/Cairo' });
    const { control, tenants } = openStorage(config, quiet);
    try {
      const deps = { config, control, tenants };
      provisionBrand(deps, { id: 'etax', name: 'ETA' });
      await provisionBranch(deps, { brandId: 'etax', id: 'etax-a', name: 'A', pin: '1234' });
      const ctx = tenants.get('etax-a');
      const file = path.join(dir, 'tenants', 'etax', 'etax-a', 'pager.db');
      const now = Date.UTC(2026, 9, 21, 12, 30);

      assert.equal(etaStats(ctx, { tz: config.tz, now }), null, 'no history');
      seedHistory(file, { n: 19, fromMin: 4, toMin: 10, at: now - 2 * 86_400_000 });
      assert.equal(etaStats(ctx, { tz: config.tz, now }), null, '19 samples is not enough');
      seedHistory(file, { n: 6, fromMin: 4, toMin: 10, at: now - 3 * 86_400_000 });
      const fallback = etaStats(ctx, { tz: config.tz, now });
      assert.ok(fallback && fallback.n === 25, 'falls back to all 14 days');
      assert.ok(fallback.p25 < fallback.p75);

      // 20 orders exactly one week back, same weekday + hour, all ~20 minutes: preferred.
      const db = new DatabaseSync(file);
      const ins = db.prepare("INSERT INTO orders (id, number, status, created_at, ready_at) VALUES (?, 1, 'ready', ?, ?)");
      for (let i = 0; i < 20; i++) {
        const c = now - 7 * 86_400_000 + i * 1000;
        ins.run(`same-${i}`.padEnd(18, 'x'), c, c + 20 * MIN);
      }
      db.close();
      const same = etaStats(ctx, { tz: config.tz, now });
      assert.equal(same.n, 20);
      assert.equal(same.p25, 20 * MIN);

      const order = { status: 'preparing', created_at: now };
      assert.deepEqual(queueFor(ctx, order, same), { ahead: 0, eta: { lowAt: now + 20 * MIN, highAt: now + 20 * MIN } });
      assert.equal(queueFor(ctx, { status: 'ready', created_at: now }, same), null);
    } finally {
      tenants.closeAll();
      control.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('over HTTP + SSE', () => {
    let server;
    let api;
    let staff;
    let k;
    before(async () => {
      server = await startServer({ CLAIM_RATE_PER_MIN: '1000' });
      api = client(server.url);
      await api.post('/api/admin/shops', { id: 'queue-cafe', name: 'Queue', pin: '1234', qrMode: 'static' }, admin);
      staff = client(server.url);
      await staff.post('/api/bar/login', { shopId: 'queue-cafe', pin: '1234' });
      k = keyOf((await staff.get('/api/bar/queue-cafe/state')).data);
    });
    after(async () => {
      await server?.stop();
    });

    test('position counts earlier preparing orders and is pushed when it changes', async () => {
      const claim = async () => (await api.post('/api/b/queue-cafe/claim', { k })).data;
      const first = await claim();
      const second = await claim();
      const third = await claim();
      assert.deepEqual(first.queue, { ahead: 0, eta: null }, 'no history -> position only');
      assert.equal(third.queue.ahead, 2);

      const stream = await sse(`${server.url}/api/b/queue-cafe/orders/${third.id}/events`);
      assert.equal((await stream.next('order')).data.queue.ahead, 2);
      await staff.post(`/api/bar/queue-cafe/orders/${first.id}/advance`);
      assert.equal((await stream.next('queue')).data.ahead, 1);
      await staff.post(`/api/bar/queue-cafe/orders/${second.id}/status`, { status: 'cancelled' });
      assert.equal((await stream.next('queue')).data.ahead, 0);
      await staff.post(`/api/bar/queue-cafe/orders/${first.id}/advance`); // picked: third's position unchanged
      await assert.rejects(stream.next('queue', () => true, 600), /timed out/, 'no event when nothing changed');
      stream.close();

      const fetched = (await api.get(`/api/b/queue-cafe/orders/${third.id}`)).data;
      assert.equal(fetched.queue.ahead, 0);
      await staff.post(`/api/bar/queue-cafe/orders/${third.id}/advance`);
      assert.equal((await api.get(`/api/b/queue-cafe/orders/${third.id}`)).data.queue, null, 'no queue once ready');
    });
  });
});

// ---------------------------------------------------------------------------
// Shared server for the owner-toggled features (phases 5-7)
// ---------------------------------------------------------------------------

const SUPER_PASSWORD = 'growth-super-pass';
const BRAND = 'grow';
const BR = 'grow-a';
const PLACE = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

async function growthServer(env = {}) {
  const server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD), CLAIM_RATE_PER_MIN: '1000', ...env });
  const su = client(server.url);
  await su.post('/api/super/login', { password: SUPER_PASSWORD });
  for (const id of [BRAND, 'rival']) await su.post('/api/super/brands', { id, name: id });
  await su.post(`/api/super/brands/${BRAND}/branches`, { id: BR, name: 'Grow A', pin: '1234' });
  await su.post('/api/super/brands/rival/branches', { id: 'rival-a', name: 'Rival A', pin: '1234' });
  await su.post(`/api/super/brands/${BRAND}/owners`, { username: 'grow.owner', password: 'grow-owner-pass' });
  const owner = client(server.url);
  await owner.post('/api/brand/login', { username: 'grow.owner', password: 'grow-owner-pass' });
  const staff = client(server.url);
  await staff.post('/api/bar/login', { shopId: BR, pin: '1234' });
  await staff.post(`/api/bar/${BR}/settings`, { qrMode: 'static' });
  const k = keyOf((await staff.get(`/api/bar/${BR}/state`)).data);
  const ownerSettings = (body, branch = BR) => owner.post(`/api/brand/${BRAND}/branches/${branch}/settings`, body);
  const branchDb = () => new DatabaseSync(path.join(server.dataDir, 'tenants', BRAND, BR, 'pager.db'));
  return { server, su, owner, staff, k, ownerSettings, branchDb };
}

// ---------------------------------------------------------------------------
// Phase 5: internal feedback + Google review (no gating)
// ---------------------------------------------------------------------------

describe('Google place id parsing + legacy upgrade', () => {
  test('parsePlaceId accepts an id or a placeid= link, rejects the rest', () => {
    assert.equal(parsePlaceId(PLACE), PLACE);
    assert.equal(parsePlaceId(`  https://search.google.com/local/writereview?placeid=${PLACE}  `), PLACE);
    assert.equal(parsePlaceId(''), null);
    assert.equal(parsePlaceId(null), null);
    assert.equal(parsePlaceId('https://g.page/r/abc/review'), undefined);
    assert.equal(parsePlaceId('<script>'), undefined);
    assert.equal(parsePlaceId('short'), undefined);
  });

  test('v1 review links switch the feature on once, and keep a place id when the link has one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-legacy-'));
    const config = loadConfig({ DATA_DIR: dir });
    const { control, tenants } = openStorage(config, quiet);
    try {
      const deps = { config, control, tenants };
      provisionBrand(deps, { id: 'leg', name: 'Legacy' });
      for (const id of ['leg-a', 'leg-b', 'leg-c']) await provisionBranch(deps, { brandId: 'leg', id, name: id, pin: '1234' });
      tenants.get('leg-a').store.updateShop({ google_review_url: `https://search.google.com/local/writereview?placeid=${PLACE}` });
      tenants.get('leg-b').store.updateShop({ google_review_url: 'https://g.page/r/CbX1abc/review' });

      upgradeLegacyReview({ control, tenants });
      const a = tenants.get('leg-a').store.getShop();
      assert.equal(a.google_place_id, PLACE);
      assert.equal(a.ff_review, 1);
      const b = tenants.get('leg-b').store.getShop();
      assert.equal(b.google_place_id, null);
      assert.equal(b.ff_review, 1, 'a link without a place id still keeps working');
      assert.equal(tenants.get('leg-c').store.getShop().ff_review, 0, 'no link, nothing changes');

      // Runs once: an owner turning it off afterwards is not overridden on the next boot.
      control.setFeature('leg-a', 'review', false);
      upgradeLegacyReview({ control, tenants });
      assert.equal(tenants.get('leg-a').store.getShop().ff_review, 0);
    } finally {
      tenants.closeAll();
      control.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('feedback + Google review over HTTP', () => {
  let g;
  let anon;
  before(async () => {
    g = await growthServer();
    anon = client(g.server.url);
  });
  after(async () => {
    await g?.server.stop();
  });

  const claim = async () => (await anon.post(`/api/b/${BR}/claim`, { k: g.k })).data;
  const pick = (id) => g.staff.post(`/api/bar/${BR}/orders/${id}/status`, { status: 'picked' });
  const feedback = (id, body) => anon.post(`/api/b/${BR}/orders/${id}/feedback`, body);
  const shop = async () => (await anon.get(`/api/b/${BR}`)).data;

  test('off by default: no stars, no Google button, feedback refused', async () => {
    const pub = await shop();
    assert.equal(pub.feedback, false);
    assert.equal(pub.googleReviewUrl, null);
    const order = await claim();
    await pick(order.id);
    assert.equal((await feedback(order.id, { rating: 5 })).status, 404);
  });

  test('owner sets the place id and turns review on; other brands are 404/401', async () => {
    assert.equal((await g.ownerSettings({ googlePlaceId: 'https://g.page/r/x' })).data.field, 'googlePlaceId');
    assert.equal((await g.ownerSettings({ features: { review: true } }, 'rival-a')).status, 404);
    assert.equal((await g.owner.post('/api/brand/rival/branches/rival-a/settings', { features: { review: true } })).status, 401);
    assert.equal((await g.staff.post(`/api/brand/${BRAND}/branches/${BR}/settings`, { features: { review: true } })).status, 401);

    const res = await g.ownerSettings({ googlePlaceId: `https://search.google.com/local/writereview?placeid=${PLACE}`, features: { review: true } });
    assert.equal(res.status, 200);
    const pub = await shop();
    assert.equal(pub.feedback, true);
    assert.equal(pub.googleReviewUrl, `https://search.google.com/local/writereview?placeid=${PLACE}`);
    assert.equal((await anon.get('/api/b/rival-a')).data.googleReviewUrl, null);
  });

  test('feedback: picked orders only, rating 1-5, once per order, within 48h', async () => {
    const order = await claim();
    assert.equal((await feedback(order.id, { rating: 4 })).status, 409, 'not picked yet');
    await pick(order.id);
    assert.equal((await feedback(order.id, { rating: 0 })).data.field, 'rating');
    assert.equal((await feedback(order.id, { rating: 6 })).data.field, 'rating');
    assert.equal((await feedback(order.id, { rating: 2.5 })).data.field, 'rating');
    assert.equal((await feedback(order.id, { rating: 3, comment: 'x'.repeat(501) })).data.field, 'comment');
    assert.equal((await feedback(order.id, { rating: 2, comment: '  القهوة كانت باردة  ' })).status, 201);
    assert.equal((await feedback(order.id, { rating: 5 })).status, 409, 'once per order');
    assert.deepEqual((await anon.get(`/api/b/${BR}/orders/${order.id}`)).data.feedback, { rating: 2 });

    const old = await claim();
    await pick(old.id);
    const db = g.branchDb();
    db.prepare('UPDATE orders SET closed_at = ? WHERE id = ?').run(Date.now() - 49 * 3_600_000, old.id);
    db.close();
    assert.equal((await feedback(old.id, { rating: 5 })).status, 409, 'past 48h');
  });

  test('the owner sees ratings; low ones show in the report and on the super dashboard', async () => {
    const overview = (await g.owner.get(`/api/brand/${BRAND}/overview`)).data;
    const branch = overview.branches.find((b) => b.id === BR);
    assert.equal(branch.ratings7d, 1);
    assert.equal(branch.avgRating7d, 2);
    assert.equal(branch.lowRatings7d.length, 1);
    assert.equal(branch.toggles.review, true);
    assert.equal(branch.googlePlaceId, PLACE);

    const day = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const report = (await g.owner.get(`/api/brand/${BRAND}/analytics?from=${day(-1)}&to=${day(1)}`)).data;
    assert.equal(report.feedback.count, 1);
    assert.equal(report.feedback.latest[0].comment, 'القهوة كانت باردة');

    const sup = (await g.su.get('/api/super/overview')).data;
    const sb = sup.brands.find((b) => b.id === BRAND).branches.find((b) => b.id === BR);
    assert.equal(sb.lowRatings7d.length, 1);
  });

  test('super force-off hides the feature even with the owner toggle on', async () => {
    await g.su.post(`/api/super/branches/${BR}/features`, { feature: 'review', forcedOff: true });
    assert.equal((await shop()).googleReviewUrl, null);
    const order = await claim();
    await pick(order.id);
    assert.equal((await feedback(order.id, { rating: 5 })).status, 404);
    await g.su.post(`/api/super/branches/${BR}/features`, { feature: 'review', forcedOff: false });
    assert.equal((await shop()).feedback, true);
  });
});

// ---------------------------------------------------------------------------
// Phase 6: loyalty stamp card
// ---------------------------------------------------------------------------

describe('loyalty card markup', () => {
  test('shows "N من M", the rule, and the waiting reward', () => {
    const card = { every: 5, stamps: 3, rewardText: 'قهوة <b>ببلاش</b>', rewards: 0 };
    const html = loyaltyHtml(card);
    assert.match(html, /3 من 5/);
    assert.equal((html.match(/class="stamp is-on"/g) ?? []).length, 3);
    assert.equal((html.match(/class="stamp( is-on)?"/g) ?? []).length, 5);
    assert.ok(!html.includes('<b>'), 'reward text is escaped');
    assert.match(loyaltyHtml(card, { orderReward: { text: 'قهوة', redeemed: false } }), /قولها للكاشير/);
    assert.match(loyaltyHtml(card, { orderReward: { text: 'قهوة', redeemed: true } }), /استلمت مكافأتك/);
    assert.match(loyaltyHtml({ ...card, rewards: 1 }), /طلبك الجاي/);
  });
});

describe('loyalty store: stamps, stacking rewards, detach on close', () => {
  test('rewards stack, attach oldest first, and come back when an order closes unredeemed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-loyal-'));
    const config = loadConfig({ DATA_DIR: dir });
    const { control, tenants } = openStorage(config, quiet);
    try {
      const deps = { config, control, tenants };
      provisionBrand(deps, { id: 'loy', name: 'Loy' });
      await provisionBranch(deps, { brandId: 'loy', id: 'loy-a', name: 'A', pin: '1234' });
      const { store } = tenants.get('loy-a');
      const { static_key: k } = store.getShop();
      store.updateShop({ qr_mode: 'static' });
      const claim = (deviceHash) => store.claim({ k }, { deviceHash }).order;
      const pickAndStamp = (order) => store.stamp(store.setStatus(order, 'picked'), 2);

      for (let i = 0; i < 4; i++) pickAndStamp(claim('dev-a')); // 4 pickups, every 2 -> 2 rewards
      assert.deepEqual(store.loyaltyCard('dev-a'), { stamps: 0, rewards: 2 });

      const o1 = claim('dev-a');
      const o2 = claim('dev-a');
      assert.ok(o1.reward_id && o2.reward_id && o1.reward_id < o2.reward_id, 'oldest reward first, both attach');
      assert.equal(claim('dev-a').reward_id, null, 'no third reward');

      // Cancelled without redeeming: the reward detaches and goes to the next order.
      const cancelled = store.setStatus(o1, 'cancelled');
      assert.equal(cancelled.reward_id, null);
      assert.equal(claim('dev-a').reward_id, o1.reward_id);

      // Redeemed: gone for good. A picked order is stamped once only.
      assert.equal(store.redeem(store.getOrder(o2.id)), true);
      assert.equal(store.redeem(store.getOrder(o2.id)), false);
      const picked = store.setStatus(store.getOrder(o2.id), 'picked');
      assert.equal(picked.reward_redeemed_at > 0, true, 'redeemed reward stays on the picked order');
      assert.equal(store.stamp(picked, 2), false);
      assert.equal(store.stamp(store.getOrder(o2.id), 2), false, 'already stamped');
      assert.equal(store.loyaltyCard('dev-a').rewards, 1);
      assert.equal(store.stamp(store.setStatus(claim(null), 'picked'), 2), false, 'no device, no stamp');
    } finally {
      tenants.closeAll();
      control.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loyalty over HTTP', () => {
  let g;
  let phone;
  before(async () => {
    g = await growthServer();
    phone = client(g.server.url);
  });
  after(async () => {
    await g?.server.stop();
  });

  const claimBy = (c, headers = {}) => c.post(`/api/b/${BR}/claim`, { k: g.k }, { headers });
  const loyalty = (c, headers = {}) => c.get(`/api/b/${BR}/loyalty`, { headers });
  const staffPost = (id, action, body) => g.staff.post(`/api/bar/${BR}/orders/${id}/${action}`, body);

  test('off by default: no device token, no card', async () => {
    const res = await claimBy(client(g.server.url));
    assert.equal(res.data.deviceToken, undefined);
    assert.ok(!res.headers.getSetCookie().join(';').includes('sp_dev_'));
    assert.equal(res.data.reward, null);
    assert.deepEqual((await loyalty(phone)).data, { enabled: false });
    assert.equal((await phone.get(`/api/b/${BR}`)).data.loyalty, null);
  });

  test('owner rule is validated; a reward text is required to turn it on', async () => {
    assert.equal((await g.ownerSettings({ loyaltyEvery: 21 })).data.field, 'loyaltyEvery');
    assert.equal((await g.ownerSettings({ loyaltyEvery: 1 })).data.field, 'loyaltyEvery');
    assert.equal((await g.ownerSettings({ loyaltyRewardText: 'x'.repeat(61) })).data.field, 'loyaltyRewardText');
    assert.equal((await g.ownerSettings({ features: { loyalty: true } })).data.field, 'loyaltyRewardText');
    const res = await g.ownerSettings({ loyaltyEvery: 2, loyaltyRewardText: 'قهوة ببلاش', features: { loyalty: true } });
    assert.equal(res.status, 200);
    assert.deepEqual((await phone.get(`/api/b/${BR}`)).data.loyalty, { every: 2, rewardText: 'قهوة ببلاش' });
  });

  test('device token: httpOnly cookie scoped to the branch API, stored only as a hash', async () => {
    const res = await claimBy(phone);
    assert.match(res.data.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`sp_dev_${BR}=`));
    assert.ok(cookie, 'device cookie set');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, new RegExp(`Path=/api/b/${BR}(;|$)`));
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Max-Age=34560000/);
    phone.token = res.data.deviceToken;
    phone.firstOrder = res.data.id;

    const db = g.branchDb();
    const rows = db.prepare('SELECT token_hash FROM loyalty_devices').all();
    const dump = JSON.stringify(db.prepare('SELECT * FROM orders').all());
    db.close();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, phone.token);
    assert.ok(!dump.includes(phone.token), 'raw token never stored');
  });

  test('a stamp only when staff mark the order picked, once per order', async () => {
    const id = phone.firstOrder;
    assert.equal((await loyalty(phone)).data.stamps, 0, 'claiming gives no stamp');
    await staffPost(id, 'advance'); // ready
    assert.equal((await loyalty(phone)).data.stamps, 0);
    const stream = await sse(`${g.server.url}/api/b/${BR}/orders/${id}/events`);
    await stream.next('order');
    await staffPost(id, 'advance'); // picked
    assert.equal((await stream.next('loyalty')).data.stamps, 1, 'pushed to the customer page');
    stream.close();
    assert.equal((await staffPost(id, 'status', { status: 'picked' })).status, 409, 'closed: no second stamp');
    assert.equal((await loyalty(phone)).data.stamps, 1);

    // The localStorage mirror works without the cookie.
    const sameDevice = client(g.server.url);
    assert.equal((await loyalty(sameDevice, { 'x-device-token': phone.token })).data.stamps, 1);
    assert.equal((await loyalty(client(g.server.url))).data.stamps, 0, 'unknown device');
  });

  test('reaching N earns a reward; the next claim carries it; staff redeem it once', async () => {
    const second = (await claimBy(phone)).data;
    await staffPost(second.id, 'status', { status: 'picked' });
    assert.deepEqual(
      { stamps: (await loyalty(phone)).data.stamps, rewards: (await loyalty(phone)).data.rewards },
      { stamps: 0, rewards: 1 },
    );

    const third = (await claimBy(phone)).data;
    assert.deepEqual(third.reward, { text: 'قهوة ببلاش', redeemed: false });
    const bar = (await g.staff.get(`/api/bar/${BR}/state`)).data.orders.find((o) => o.id === third.id);
    assert.deepEqual(bar.reward, { text: 'قهوة ببلاش', redeemed: false }, 'bar shows the gift');
    assert.equal((await phone.post(`/api/bar/${BR}/orders/${third.id}/redeem`)).status, 401, 'staff only');
    const redeemed = await staffPost(third.id, 'redeem');
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.data.reward.redeemed, true);
    assert.equal((await staffPost(third.id, 'redeem')).status, 409, 'once');
    assert.equal((await loyalty(phone)).data.rewards, 0);
  });

  test('3 claims per device per 15 minutes', async () => {
    const res = await claimBy(phone);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 60);
    assert.equal((await claimBy(client(g.server.url))).status, 200, 'another device is fine');
  });

  test('turning it off hides everything and keeps the data', async () => {
    const before = (await loyalty(client(g.server.url), { 'x-device-token': phone.token })).data;
    await g.ownerSettings({ features: { loyalty: false } });
    assert.deepEqual((await loyalty(phone)).data, { enabled: false });
    assert.equal((await phone.get(`/api/b/${BR}`)).data.loyalty, null);
    const res = await claimBy(client(g.server.url));
    assert.equal(res.data.deviceToken, undefined);
    await g.ownerSettings({ features: { loyalty: true } });
    const after = (await loyalty(client(g.server.url), { 'x-device-token': phone.token })).data;
    assert.deepEqual(after, before);
  });

  test('device hashes are per branch', () => {
    const config = { cookieSecret: 'secret' };
    const token = 'a'.repeat(43);
    assert.notEqual(hashDevice(config, 'grow-a', token), hashDevice(config, 'rival-a', token));
  });
});

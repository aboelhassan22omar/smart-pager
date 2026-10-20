import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { ADMIN_TOKEN, client, PNG_1X1, sse, startServer } from './helpers.js';

const admin = { headers: { 'x-admin-token': ADMIN_TOKEN } };
const nonceOf = (state) => new URL(state.qr.dynamicUrl).searchParams.get('n');
const cookieHeader = (c) => [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');

// ---------------------------------------------------------------------------
// Cross-tenant isolation: authenticate as branch A / brand X, attack B and Y.
// ---------------------------------------------------------------------------

describe('cross-tenant isolation', () => {
  let server;
  let api;
  // A and B share brand X; C belongs to brand Y.
  const A = 'brandx-a';
  const B = 'brandx-b';
  const C = 'brandy-c';
  const staff = {};
  const orders = {};

  const state = async (id) => (await staff[id].get(`/api/bar/${id}/state`)).data;
  const claim = async (id) => {
    const res = await api.post(`/api/b/${id}/claim`, { n: nonceOf(await state(id)) });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data;
  };

  before(async () => {
    server = await startServer();
    api = client(server.url);
    for (const [id, name] of [['brandx', 'Brand X'], ['brandy', 'Brand Y']]) {
      assert.equal((await api.post('/api/admin/brands', { id, name }, admin)).status, 201);
    }
    for (const [brandId, id] of [['brandx', A], ['brandx', B], ['brandy', C]]) {
      const res = await api.post('/api/admin/branches', { brandId, id, name: id, area: id.split('-')[1], pin: '1234' }, admin);
      assert.equal(res.status, 201, JSON.stringify(res.data));
      staff[id] = client(server.url);
      assert.equal((await staff[id].post('/api/bar/login', { shopId: id, pin: '1234' })).status, 200);
    }
    for (const id of [A, B, C]) orders[id] = await claim(id);
  });

  after(async () => {
    await server?.stop();
  });

  test('branch ids must carry their brand prefix', async () => {
    const bad = await api.post('/api/admin/branches', { brandId: 'brandx', id: 'brandy-z', name: 'z', pin: '1234' }, admin);
    assert.equal(bad.status, 400);
    assert.equal(bad.data.field, 'id');
    const unknown = await api.post('/api/admin/branches', { brandId: 'nobrand', id: 'nobrand-a', name: 'x', pin: '1234' }, admin);
    assert.equal(unknown.status, 404);
  });

  test('customer routes: an order id from A is 404 under every other branch', async () => {
    const id = orders[A].id;
    assert.equal((await api.get(`/api/b/${A}/orders/${id}`)).status, 200, 'sanity: found under its own branch');
    for (const other of [B, C]) {
      assert.equal((await api.get(`/api/b/${other}/orders/${id}`)).status, 404, other);
      assert.equal((await api.get(`/api/b/${other}/orders/${id}/events`)).status, 404, other);
      assert.equal((await api.request('POST', `/api/b/${other}/orders/${id}/review-click`, {
        body: '', headers: { 'content-type': 'text/plain' },
      })).status, 404, other);
      assert.equal((await api.post(`/api/b/${other}/subscribe`, {
        orderId: id, kind: 'live_activity', payload: { token: 'ab'.repeat(40) },
      })).status, 404, other);
    }
    assert.equal((await api.get('/api/b/no-such-branch')).status, 404);
  });

  test("staff routes: A's session gets 401 on every route of B (same brand) and C (other brand)", async () => {
    const a = staff[A];
    for (const other of [B, C]) {
      const oid = orders[other].id;
      const base = `/api/bar/${other}`;
      const calls = [
        a.get(`${base}/state`),
        a.get(`${base}/events`),
        a.get(`${base}/qr.svg?kind=dynamic`),
        a.post(`${base}/orders/${oid}/advance`),
        a.post(`${base}/orders/${oid}/status`, { status: 'cancelled' }),
        a.post(`${base}/orders/${oid}/renotify`),
        a.post(`${base}/settings`, { name: 'hijacked' }),
        a.request('POST', `${base}/logo`, { body: PNG_1X1, headers: { 'content-type': 'image/png' } }),
        a.del(`${base}/logo`),
      ];
      for (const res of await Promise.all(calls)) assert.equal(res.status, 401, `${other}: ${JSON.stringify(res.data)}`);
    }
    assert.equal((await api.get(`/api/b/${B}`)).data.name, B, 'B untouched');
    assert.equal((await api.get(`/api/b/${B}/orders/${orders[B].id}`)).data.status, 'preparing');
  });

  test("A's cookie value renamed for B does not verify (per-branch HKDF keys)", async () => {
    const [, value] = [...staff[A].jar].find(([k]) => k === `sp_staff_${A}`);
    const res = await api.get(`/api/bar/${B}/state`, { headers: { cookie: `sp_staff_${B}=${value}` } });
    assert.equal(res.status, 401);
  });

  test("A's staff cannot touch B's orders through A's own routes", async () => {
    const a = staff[A];
    const oid = orders[B].id;
    assert.equal((await a.post(`/api/bar/${A}/orders/${oid}/advance`)).status, 404);
    assert.equal((await a.post(`/api/bar/${A}/orders/${oid}/status`, { status: 'cancelled' })).status, 404);
    assert.equal((await a.post(`/api/bar/${A}/orders/${oid}/renotify`)).status, 404);
  });

  test("media is served only from the requested branch's folder", async () => {
    const up = await staff[A].request('POST', `/api/bar/${A}/logo`, { body: PNG_1X1, headers: { 'content-type': 'image/png' } });
    const file = up.data.shop.logoUrl.split('/').pop();
    assert.equal((await fetch(`${server.url}/media/b/${A}/${file}`)).status, 200);
    assert.equal((await fetch(`${server.url}/media/b/${B}/${file}`)).status, 404);
    assert.equal((await fetch(`${server.url}/media/b/${C}/${file}`)).status, 404);
    for (const evil of ['..%2Fpager.db', '..%2F..%2F..%2Fcontrol.db', 'logo-1.png', '%2E%2E%2Fpager.db']) {
      assert.equal((await fetch(`${server.url}/media/b/${A}/${evil}`)).status, 404, evil);
    }
  });

  test('SSE: streams of A receive nothing from B or C', async () => {
    const order = await claim(A);
    const customer = await sse(`${server.url}/api/b/${A}/orders/${order.id}/events`);
    const bar = await sse(`${server.url}/api/bar/${A}/events`, { cookie: cookieHeader(staff[A]) });
    await customer.next('order');
    await bar.next('hello');

    for (const other of [B, C]) {
      const o = await claim(other);
      await staff[other].post(`/api/bar/${other}/orders/${o.id}/advance`);
      await staff[other].post(`/api/bar/${other}/orders/${orders[other].id}/renotify`).catch(() => {});
    }
    await assert.rejects(customer.next('order', () => true, 800), /timed out/);
    await assert.rejects(bar.next('order', () => true, 400), /timed out/);
    await assert.rejects(bar.next('nonce', () => true, 200), /timed out/);

    await staff[A].post(`/api/bar/${A}/orders/${order.id}/advance`);
    assert.equal((await customer.next('order')).data.status, 'ready', 'sanity: own events still arrive');
    assert.equal((await bar.next('order', (d) => d.order.id === order.id)).data.order.status, 'ready');
    customer.close();
    bar.close();
  });

  test('claim rate limits are per branch', async () => {
    const ip = '10.77.77.77';
    let last;
    for (let i = 0; i < 7; i++) last = await api.post(`/api/b/${A}/claim`, { n: 'x' }, { ip });
    assert.equal(last.status, 429);
    assert.equal((await api.post(`/api/b/${B}/claim`, { n: 'x' }, { ip })).status, 403, 'B has its own budget');
  });
});

// ---------------------------------------------------------------------------
// Handle cache + idle-branch nonce expiry
// ---------------------------------------------------------------------------

describe('branch database handles and nonce age', () => {
  let server;
  let api;
  before(async () => {
    server = await startServer({ TENANT_DB_CACHE: '1', NONCE_ROTATE_SECONDS: '5' });
    api = client(server.url);
  });
  after(async () => {
    await server?.stop();
  });

  test('branches keep working when the LRU holds a single open database', async () => {
    const ids = ['lru-one', 'lru-two', 'lru-three'];
    const staffs = {};
    for (const id of ids) {
      assert.equal((await api.post('/api/admin/shops', { id, name: id, pin: '1234', qrMode: 'static' }, admin)).status, 201);
      staffs[id] = client(server.url);
      await staffs[id].post('/api/bar/login', { shopId: id, pin: '1234' });
    }
    for (let round = 0; round < 2; round++) {
      for (const id of ids) {
        const st = (await staffs[id].get(`/api/bar/${id}/state`)).data;
        const k = new URL(st.qr.staticUrl).searchParams.get('k');
        const o = await api.post(`/api/b/${id}/claim`, { k });
        assert.equal(o.status, 200);
        assert.equal(o.data.number, round + 1, `${id} keeps its own numbering`);
      }
    }
  });

  test('a branch with no open QR screen does not rotate, and its old nonce stops working', async () => {
    assert.equal((await api.post('/api/admin/shops', { id: 'idle-cafe', name: 'Idle', pin: '1234' }, admin)).status, 201);
    const s = client(server.url);
    await s.post('/api/bar/login', { shopId: 'idle-cafe', pin: '1234' });
    const before = nonceOf((await s.get('/api/bar/idle-cafe/state')).data);
    await new Promise((r) => setTimeout(r, 10_500)); // > 2 x NONCE_ROTATE_SECONDS
    assert.equal(nonceOf((await s.get('/api/bar/idle-cafe/state')).data), before, 'not rotated without a screen');
    assert.equal((await api.post('/api/b/idle-cafe/claim', { n: before })).status, 403, 'too old to claim');
  });
});

// ---------------------------------------------------------------------------
// One-time migration from the v1 single database
// ---------------------------------------------------------------------------

const V1_SCHEMA = (checked) => `
CREATE TABLE shops (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, logo TEXT, pin_hash TEXT NOT NULL,
  qr_mode TEXT NOT NULL DEFAULT 'dynamic', qr_nonce TEXT NOT NULL, qr_prev_nonce TEXT, qr_rotated_at INTEGER NOT NULL,
  static_key TEXT NOT NULL, next_number INTEGER NOT NULL DEFAULT 1, number_day TEXT, max_number INTEGER NOT NULL DEFAULT 999,
  expire_hours INTEGER NOT NULL DEFAULT 3, preparing_message TEXT NOT NULL DEFAULT 'p', ready_message TEXT NOT NULL DEFAULT 'r',
  created_at INTEGER NOT NULL, accent_color TEXT, google_review_url TEXT, review_clicks INTEGER NOT NULL DEFAULT 0);
CREATE TABLE orders (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops (id) ON DELETE CASCADE, number INTEGER NOT NULL,
  status TEXT NOT NULL ${checked ? "CHECK (status IN ('preparing', 'ready', 'picked', 'expired', 'cancelled'))" : ''},
  created_at INTEGER NOT NULL, ready_at INTEGER, closed_at INTEGER, notify_count INTEGER NOT NULL DEFAULT 0, review_clicked_at INTEGER);
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (order_id, kind, payload));
`;

async function seedV1({ bogus = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-v1-'));
  fs.mkdirSync(path.join(dir, 'logos'));
  fs.writeFileSync(path.join(dir, 'logos', 'old-cafe-1700000000000.png'), PNG_1X1);
  const db = new DatabaseSync(path.join(dir, 'pager.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V1_SCHEMA(!bogus));
  const pin = await hashPin('4321');
  const now = Date.now();
  const shop = db.prepare(`INSERT INTO shops (id, name, logo, pin_hash, qr_mode, qr_nonce, qr_rotated_at, static_key, created_at, accent_color, review_clicks)
                           VALUES (?, ?, ?, ?, 'static', 'nonce', ?, ?, ?, ?, ?)`);
  shop.run('old-cafe', 'Old Café', 'old-cafe-1700000000000.png', pin, now, 'static-old', now - 2000, '#1a73e8', 3);
  shop.run('other-cafe', 'Other', null, pin, now, 'static-other', now - 1000, null, 0);
  const order = db.prepare('INSERT INTO orders (id, shop_id, number, status, created_at) VALUES (?, ?, ?, ?, ?)');
  order.run('oldcafe-order-aaaaaaaa', 'old-cafe', 7, 'preparing', now);
  order.run('oldcafe-order-bbbbbbbb', 'old-cafe', 8, 'picked', now);
  order.run('othercafe-order-cccccc', 'other-cafe', 1, bogus ? 'bogus' : 'ready', now);
  db.prepare('INSERT INTO subscriptions (order_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
    .run('oldcafe-order-aaaaaaaa', 'live_activity', JSON.stringify({ token: 'ab'.repeat(40), app: 'clip' }), now);
  db.close();
  return dir;
}

describe('migration from the v1 database', () => {
  test('splits every shop into its own branch database, keeps the data, retires pager.db', async () => {
    const dataDir = await seedV1();
    const server = await startServer({}, { dataDir });
    try {
      const api = client(server.url);
      assert.ok(fs.existsSync(path.join(dataDir, 'control.db')));
      assert.ok(fs.existsSync(path.join(dataDir, 'pager.db.migrated')));
      assert.ok(!fs.existsSync(path.join(dataDir, 'pager.db')));
      assert.ok(!fs.existsSync(path.join(dataDir, '.v2-staging')));
      const backups = fs.readdirSync(path.join(dataDir, 'backups')).filter((d) => d.startsWith('pre-v2-'));
      assert.equal(backups.length, 1);
      assert.ok(fs.existsSync(path.join(dataDir, 'backups', backups[0], 'pager.db')));

      for (const id of ['old-cafe', 'other-cafe']) {
        assert.ok(fs.existsSync(path.join(dataDir, 'tenants', id, id, 'pager.db')), id);
      }
      const shop = (await api.get('/api/b/old-cafe')).data;
      assert.equal(shop.name, 'Old Café');
      assert.match(shop.logoUrl, /^\/media\/b\/old-cafe\/logo-1700000000000\.png$/);
      assert.equal((await fetch(server.url + shop.logoUrl)).status, 200, 'logo moved to the branch media folder');
      assert.equal(shop.accent.color.length, 7);

      assert.equal((await api.get('/api/b/old-cafe/orders/oldcafe-order-aaaaaaaa')).data.number, 7);
      assert.equal((await api.get('/api/b/old-cafe/orders/oldcafe-order-bbbbbbbb')).data.status, 'picked');
      assert.equal((await api.get('/api/b/other-cafe/orders/oldcafe-order-aaaaaaaa')).status, 404, 'split, not shared');
      assert.equal((await api.get('/api/b/other-cafe/orders/othercafe-order-cccccc')).data.status, 'ready');

      const staff = client(server.url);
      assert.equal((await staff.post('/api/bar/login', { shopId: 'old-cafe', pin: '4321' })).status, 200, 'PIN kept');
      const st = (await staff.get('/api/bar/old-cafe/state')).data;
      assert.equal(st.orders.length, 1);
      assert.equal(st.shop.reviewClicks, 3);
      assert.equal(new URL(st.qr.staticUrl).searchParams.get('k'), 'static-old', 'printed QR codes keep working');

      const branchDb = new DatabaseSync(path.join(dataDir, 'tenants', 'old-cafe', 'old-cafe', 'pager.db'));
      assert.equal(Number(branchDb.prepare('SELECT COUNT(*) AS c FROM subscriptions').get().c), 1);
      branchDb.close();
    } finally {
      await server.stop();
    }
  });

  test('aborts on a row mismatch, refuses to start, and leaves pager.db untouched', async () => {
    const dataDir = await seedV1({ bogus: true });
    const before = fs.readFileSync(path.join(dataDir, 'pager.db'));
    const { code, output } = await startServer({}, { dataDir, expectExit: true });
    try {
      assert.notEqual(code, 0, output);
      assert.ok(fs.existsSync(path.join(dataDir, 'pager.db')), 'v1 database kept');
      assert.deepEqual(fs.readFileSync(path.join(dataDir, 'pager.db')), before, 'byte for byte');
      assert.ok(!fs.existsSync(path.join(dataDir, 'control.db')));
      assert.ok(!fs.existsSync(path.join(dataDir, 'tenants')));
      assert.ok(!fs.existsSync(path.join(dataDir, '.v2-staging')));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

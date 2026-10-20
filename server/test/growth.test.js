import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { aheadText, etaText } from '../public/js/queue-text.js';
import { openStorage } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { provisionBrand, provisionBranch } from '../src/provision.js';
import { etaStats, percentile, queueFor } from '../src/queue.js';
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

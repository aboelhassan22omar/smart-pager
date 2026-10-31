import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { client, sse, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';

describe('demo café (/demo)', () => {
  let server;
  let su;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    su = client(server.url);
    assert.equal((await su.post('/api/super/login', { password: SUPER_PASSWORD })).status, 200);
  });
  after(() => server?.stop());

  test('one link signs the visitor in as the cashier and the owner of the demo café', async () => {
    const v = client(server.url);
    const page = await v.get('/demo');
    assert.equal(page.status, 200);
    assert.match(page.data, /كافيه الديمو/);

    const info = await v.get('/api/demo');
    assert.equal(info.data.shopId, 'demo');
    const state = await v.get('/api/bar/demo/state');
    assert.equal(state.status, 200, 'cashier session from the link');
    assert.equal(state.data.plan.status, 'active', 'never runs out');
    const overview = await v.get('/api/brand/demo/overview');
    assert.equal(overview.status, 200, 'owner session from the link');
    assert.equal(overview.data.demo, true);
    assert.equal(overview.data.branches.length, 1);

    // Two weeks of sample history for the owner's dashboard, nothing open on the cashier.
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const report = await v.get(`/api/brand/demo/analytics?from=${from}&to=${to}`);
    assert.equal(report.status, 200);
    assert.ok(report.data.total.orders > 300, `sample orders: ${report.data.total.orders}`);
    assert.ok(report.data.feedback.count > 30, 'sample ratings');
    assert.equal(state.data.orders.length, 0);
  });

  test('the customer link from the page gets a number the cashier can ring', async () => {
    const v = client(server.url);
    await v.get('/demo');
    const { customerPath } = (await v.get('/api/demo')).data;
    const k = new URL(customerPath, server.url).searchParams.get('k');
    const customer = client(server.url);
    const order = await customer.post('/api/b/demo/claim', { k });
    assert.equal(order.status, 200);
    const ready = await v.post(`/api/bar/demo/orders/${order.data.id}/advance`);
    assert.equal(ready.data.status, 'ready');
    const qr = await v.get('/api/demo/qr.svg');
    assert.match(qr.data, /<svg/);
  });

  test('visitors cannot change the shared café', async () => {
    const v = client(server.url);
    await v.get('/demo');
    const bar = await v.post('/api/bar/demo/settings', { readyMessage: 'تم' });
    assert.equal(bar.status, 403);
    const pin = await v.post('/api/bar/demo/settings', { currentPin: '000000', newPin: '1234' });
    assert.equal(pin.status, 403);
    const owner = await v.post('/api/brand/demo/branches/demo/settings', { name: 'اسم تاني' });
    assert.equal(owner.status, 403);
    assert.equal((await v.get('/api/brand/demo/overview')).data.branches[0].name, 'كافيه الديمو');
  });

  test('the super sees how many have the demo open now, and visits per day', async () => {
    const before = (await su.get('/api/super/overview')).data.live.demo;
    const v = client(server.url);
    await v.get('/demo');
    await v.get('/demo'); // a reload: one more visit, same visitor
    const live = await sse(`${server.url}/api/demo/live`);
    try {
      let demo;
      for (let i = 0; i < 20; i++) {
        demo = (await su.get('/api/super/overview')).data.live.demo;
        if (demo.open > before.open) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(demo.open, before.open + 1);
      assert.equal(demo.today.visits, before.today.visits + 2);
      assert.equal(demo.today.visitors, before.today.visitors + 1);
    } finally {
      live.close();
    }
  });

  test('the super sees cashier and QR screens open per branch', async () => {
    const v = client(server.url);
    await v.get('/demo');
    const cookie = [...v.jar].map(([k, val]) => `${k}=${val}`).join('; ');
    const bar = await sse(`${server.url}/api/bar/demo/events`, { cookie });
    const qr = await sse(`${server.url}/api/bar/demo/events?screen=qr`, { cookie });
    try {
      await bar.next('hello');
      await qr.next('hello');
      const overview = (await su.get('/api/super/overview')).data;
      const demo = overview.brands.find((b) => b.id === 'demo').branches[0];
      assert.deepEqual(demo.screenKinds, { bar: 1, qr: 1 });
      // The demo's own screens are visitors, not cafés: they stay out of the totals.
      assert.equal(overview.live.bar, 0);
      assert.equal(overview.live.qr, 0);
    } finally {
      bar.close();
      qr.close();
    }
  });
});

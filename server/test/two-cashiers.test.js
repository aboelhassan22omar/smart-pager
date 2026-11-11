import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { client, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';

// Two cashier screens on one branch tapping the same order at the same moment.
describe('two cashier screens on one branch', () => {
  let server;
  let one;
  let two;
  let k;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    const su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
    await su.post('/api/super/brands', { id: 'duo', name: 'Duo' });
    await su.post('/api/super/brands/duo/branches', { id: 'duo-a', name: 'Duo', pin: '1234', qrMode: 'static' });
    one = client(server.url);
    two = client(server.url);
    await one.post('/api/bar/login', { shopId: 'duo-a', pin: '1234' });
    await two.post('/api/bar/login', { shopId: 'duo-a', pin: '1234' });
    k = new URL((await one.get('/api/bar/duo-a/state')).data.qr.staticUrl).searchParams.get('k');
  });
  after(() => server?.stop());

  const claim = async () => (await client(server.url).post('/api/b/duo-a/claim', { k })).data;

  test('both tap "advance" on the same order: it becomes ready once, not picked', async () => {
    const order = await claim();
    const [a, b] = await Promise.all([one, two].map((c) => c.post(`/api/bar/duo-a/orders/${order.id}/advance`, { from: 'preparing' })));
    const statuses = [a, b].map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409], 'one goes through, the other is told');
    const refused = a.status === 409 ? a : b;
    assert.equal(refused.data.order.status, 'ready', 'the refused screen gets the order as it is now');
    const now = (await one.get('/api/bar/duo-a/state')).data.orders.find((o) => o.id === order.id);
    assert.equal(now.status, 'ready');
  });

  test('every change bumps the revision, so a screen can drop an older view', async () => {
    const order = await claim();
    const r1 = (await one.post(`/api/bar/duo-a/orders/${order.id}/advance`, { from: 'preparing' })).data;
    const r2 = (await two.post(`/api/bar/duo-a/orders/${order.id}/status`, { status: 'preparing', from: 'ready' })).data;
    assert.ok(r2.rev > r1.rev && r1.rev > order.rev);
  });

  test('without `from` (older screens, the apps) it works as before', async () => {
    const order = await claim();
    assert.equal((await one.post(`/api/bar/duo-a/orders/${order.id}/advance`)).data.status, 'ready');
    assert.equal((await two.post(`/api/bar/duo-a/orders/${order.id}/advance`)).data.status, 'picked');
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { client, sse, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';

// A ready order rings again (the page chimes, push re-alerts) until it is picked up.
describe('ready orders ring again until picked up', () => {
  let server;
  let bar;
  let k;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD), READY_REPEAT_SECONDS: '1,2' });
    const su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
    await su.post('/api/super/brands', { id: 'ring', name: 'Ring' });
    await su.post('/api/super/brands/ring/branches', { id: 'ring-a', name: 'Ring', pin: '1234', qrMode: 'static' });
    bar = client(server.url);
    await bar.post('/api/bar/login', { shopId: 'ring-a', pin: '1234' });
    k = new URL((await bar.get('/api/bar/ring-a/state')).data.qr.staticUrl).searchParams.get('k');
  });
  after(() => server?.stop());

  const claim = async () => (await client(server.url).post('/api/b/ring-a/claim', { k })).data;
  const setStatus = (id, status) => bar.post(`/api/bar/ring-a/orders/${id}/status`, { status });

  test('rings at each repeat while ready', async () => {
    const order = await claim();
    const events = await sse(`${server.url}/api/b/ring-a/orders/${order.id}/events`);
    await setStatus(order.id, 'ready');
    const first = await events.next('renotify', () => true, 4000);
    assert.equal(first.data.status, 'ready');
    await events.next('renotify', () => true, 4000);
    events.close();
  });

  test('stops once picked up', async () => {
    const order = await claim();
    const events = await sse(`${server.url}/api/b/ring-a/orders/${order.id}/events`);
    await setStatus(order.id, 'ready');
    await setStatus(order.id, 'picked');
    await assert.rejects(events.next('renotify', () => true, 2500), /timed out/);
    events.close();
  });
});

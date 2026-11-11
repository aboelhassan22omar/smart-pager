import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { client, sse, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';

// Order QR mode: the cashier (or the POS) rings an order up, the customer screen shows that
// order's own QR, and every phone that scans it follows the same order.
describe('a QR per order', () => {
  let server;
  let owner;
  let bar;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    const su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
    await su.post('/api/super/brands', { id: 'oqr', name: 'Order QR' });
    await su.post('/api/super/brands/oqr/branches', { id: 'oqr-a', name: 'Order QR', pin: '1234', qrMode: 'static' });
    await su.post('/api/super/brands/oqr/owners', { username: 'oqr.owner', password: 'oqr-owner-pass' });
    owner = client(server.url);
    await owner.post('/api/brand/login', { username: 'oqr.owner', password: 'oqr-owner-pass' });
    bar = client(server.url);
    await bar.post('/api/bar/login', { shopId: 'oqr-a', pin: '1234' });
  });
  after(() => server?.stop());

  const settings = (body) => owner.post('/api/brand/oqr/branches/oqr-a/settings', body);
  const phone = () => client(server.url);
  const join = (c, orderId, clientId) => c.post(`/api/b/oqr-a/orders/${orderId}/join`, {}, { headers: { 'x-client-id': clientId } });

  test('off by default: no orders from the cashier', async () => {
    assert.equal((await bar.post('/api/bar/oqr-a/orders')).status, 409);
  });

  test('on: the cashier rings an order up, the screen gets its QR, phones join it', async () => {
    assert.equal((await settings({ orderQr: true })).status, 200);
    assert.equal((await bar.get('/api/bar/oqr-a/state')).data.shop.orderQr, true);
    const events = await sse(`${server.url}/api/bar/oqr-a/events?screen=qr`, { cookie: [...bar.jar].map(([k, v]) => `${k}=${v}`).join('; ') });

    const created = await bar.post('/api/bar/oqr-a/orders');
    assert.equal(created.status, 200);
    assert.equal(created.data.number, 1);
    const shown = await events.next('order-qr');
    assert.equal(shown.data.id, created.data.id);
    events.close();

    const svg = await bar.request('GET', `/api/bar/oqr-a/qr.svg?order=${created.data.id}`);
    assert.equal(svg.status, 200);
    assert.match(svg.data, /<svg/);

    const a = await join(phone(), created.data.id, 'aaaaaaaaaaaaaaaaaaaa');
    const b = await join(phone(), created.data.id, 'bbbbbbbbbbbbbbbbbbbb');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200, 'a second phone follows the same order');
    assert.equal(a.data.id, b.data.id);
    assert.equal(a.data.number, 1);
  });

  test('sharing off: the first phone keeps the order, another one is turned away', async () => {
    await settings({ orderQr: true, orderShare: false });
    const { data: order } = await bar.post('/api/bar/oqr-a/orders');
    assert.equal((await join(phone(), order.id, 'cccccccccccccccccccc')).status, 200);
    assert.equal((await join(phone(), order.id, 'cccccccccccccccccccc')).status, 200, 'the same phone again');
    const other = await join(phone(), order.id, 'dddddddddddddddddddd');
    assert.equal(other.status, 409);
    await settings({ orderShare: true });
  });

  test('a closed order has no QR any more', async () => {
    const { data: order } = await bar.post('/api/bar/oqr-a/orders');
    await bar.post(`/api/bar/oqr-a/orders/${order.id}/status`, { status: 'cancelled' });
    assert.equal((await bar.request('GET', `/api/bar/oqr-a/qr.svg?order=${order.id}`)).status, 404);
  });

  test('with the POS linked, a counter order becomes an order right away; a delivery does not', async () => {
    const { url } = (await bar.get('/api/bar/oqr-a/pos')).data;
    const path = new URL(url).pathname;
    await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order_number: 27 }) });
    await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order_number: 28, type: 'delivery' }) });
    const numbers = (await bar.get('/api/bar/oqr-a/state')).data.orders.map((o) => o.number);
    assert.ok(numbers.includes(27), 'the POS order is on the cashier screen');
    assert.ok(!numbers.includes(28), 'the delivery is not');
  });
});

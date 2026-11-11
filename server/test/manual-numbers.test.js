import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { client, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';

// Takeaway numbers typed by the cashier: the POS numbers dine-in, delivery and takeaway in one
// row; receipt 27 gets the pager's next number, 3, and the next customer to scan lands on it.
describe('takeaway numbers typed by the cashier', () => {
  let server;
  let owner;
  let bar;
  let k;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    const su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
    await su.post('/api/super/brands', { id: 'take', name: 'Take' });
    await su.post('/api/super/brands/take/branches', { id: 'take-a', name: 'Take', pin: '1234', qrMode: 'static' });
    await su.post('/api/super/brands/take/owners', { username: 'take.owner', password: 'take-owner-pass' });
    owner = client(server.url);
    await owner.post('/api/brand/login', { username: 'take.owner', password: 'take-owner-pass' });
    bar = client(server.url);
    await bar.post('/api/bar/login', { shopId: 'take-a', pin: '1234' });
    k = new URL((await bar.get('/api/bar/take-a/state')).data.qr.staticUrl).searchParams.get('k');
  });
  after(() => server?.stop());

  const typed = (receipt) => bar.post('/api/bar/take-a/receipts', { receipt });
  const scan = (body = {}, clientId = `c${Math.random().toString(36).slice(2).padEnd(20, 'x')}`) => client(server.url)
    .post('/api/b/take-a/claim', { k, canPick: true, ...body }, { headers: { 'x-client-id': clientId } });
  const setManual = (on) => owner.post('/api/brand/take/branches/take-a/settings', { manualNumbers: on });

  test('off by default: typing a receipt is refused', async () => {
    assert.equal((await typed('27')).status, 409);
  });

  test('the owner turns it on; the cashier screen and the owner page say so', async () => {
    assert.equal((await setManual(true)).status, 200);
    assert.equal((await bar.get('/api/bar/take-a/state')).data.shop.manualNumbers, true);
  });

  test('nothing typed: a scan gets a number from the count, as always', async () => {
    const res = await scan();
    assert.equal(res.status, 200);
    assert.deepEqual([res.data.number, res.data.receipt], [1, null]);
  });

  test('receipt 27 gets the next number, 2, then 41 gets 3; Arabic digits are fine', async () => {
    const a = await typed('27');
    assert.equal(a.status, 200);
    assert.deepEqual([a.data.receipt, a.data.number, a.data.repeated], ['27', 2, false]);
    const b = await typed('٤١');
    assert.deepEqual([b.data.receipt, b.data.number], ['41', 3]);
    assert.equal(b.data.counter.waiting, 2);
    assert.equal((await typed('27')).data.number, 2, 'the same receipt again keeps its number');
    assert.equal((await typed('27x')).status, 400);
  });

  test('the next customer to scan lands on the oldest typed receipt, nothing to choose', async () => {
    const first = await scan();
    assert.equal(first.status, 200);
    assert.equal(first.data.choose, undefined);
    assert.deepEqual([first.data.number, first.data.ref, first.data.receipt], [2, null, '27']);
    const second = await scan();
    assert.deepEqual([second.data.number, second.data.receipt], [3, '41']);
    const tile = (await bar.get('/api/bar/take-a/state')).data.orders.find((o) => o.id === second.data.id);
    assert.equal(tile.receipt, '41', 'the cashier tile shows the receipt under the number');
    const later = await scan();
    assert.deepEqual([later.data.number, later.data.receipt], [4, null], 'none left: the count again');
  });

  test("the QR on the receipt opens that receipt's number", async () => {
    assert.equal((await typed('60')).data.number, 5);
    const res = await client(server.url).post('/api/b/take-a/claim', { k, receipt: '60' }, { headers: { 'x-client-id': 'r'.repeat(20) } });
    assert.equal(res.status, 200);
    assert.deepEqual([res.data.number, res.data.receipt], [5, '60']);
  });

  test('− takes back a typed receipt nobody scanned', async () => {
    assert.equal((await typed('55')).data.number, 6);
    const counter = (await bar.post('/api/bar/take-a/counter', { delta: -1 })).data;
    assert.equal(counter.next, 6);
    assert.equal(counter.waiting ?? 0, 0);
    assert.equal((await typed('56')).data.number, 6, 'the number is given again');
  });

  test('a typed receipt cancelled: not scanned, it stops waiting; scanned, its order is cancelled', async () => {
    const cancel = (receipt) => bar.post('/api/bar/take-a/receipts/cancel', { receipt });
    const added = (await typed('70')).data;
    const res = await cancel('70');
    assert.equal(res.status, 200);
    assert.equal(res.data.number, added.number);
    assert.equal(res.data.counter.waiting ?? 0, added.counter.waiting - 1);
    const after = await scan();
    assert.notEqual(after.data.receipt, '70', 'the next customer does not get the cancelled receipt');

    await typed('71');
    const mine = (await scan()).data;
    assert.equal(mine.receipt, '71');
    const res2 = await cancel('٧١');
    assert.equal(res2.data.order.status, 'cancelled');
    const seen = (await client(server.url).get(`/api/b/take-a/orders/${mine.id}`)).data;
    assert.equal(seen.status, 'cancelled', 'the customer sees it');
    assert.equal((await cancel('99')).status, 404);
  });

  test('with order QR mode the order exists right away', async () => {
    await owner.post('/api/brand/take/branches/take-a/settings', { orderQr: true });
    const res = await typed('90');
    assert.equal(res.status, 200);
    assert.equal(res.data.order.receipt, '90');
    assert.ok(res.data.order.number > 0);
    const open = (await bar.get('/api/bar/take-a/state')).data.orders.map((o) => o.receipt);
    assert.ok(open.includes('90'));
    await owner.post('/api/brand/take/branches/take-a/settings', { orderQr: false });
  });

  test('turned off: scanning gives a number from the count again', async () => {
    await setManual(false);
    const res = await scan();
    assert.equal(res.status, 200);
    assert.equal(typeof res.data.number, 'number');
    assert.equal(res.data.receipt, null);
  });
});

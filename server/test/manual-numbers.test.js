import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { client, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';

// Takeaway numbers typed by the cashier: the POS numbers dine-in, delivery and takeaway in one
// row; receipt 27 gets takeaway number 3, and its customer picks receipt 27 when scanning.
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

  test('a scan before the receipt is typed waits instead of taking a number', async () => {
    const res = await scan();
    assert.equal(res.status, 409);
    assert.equal(res.data.wait, true);
  });

  test('receipt 27 gets takeaway number 1, then 41 gets 2; Arabic digits are fine', async () => {
    const a = await typed('27');
    assert.equal(a.status, 200);
    assert.deepEqual([a.data.receipt, a.data.number, a.data.repeated], ['27', 1, false]);
    const b = await typed('٤١');
    assert.deepEqual([b.data.receipt, b.data.number], ['41', 2]);
    assert.equal(b.data.counter.waiting, 2);
    assert.equal((await typed('27')).data.number, 1, 'the same receipt again keeps its number');
    assert.equal((await typed('27x')).status, 400);
  });

  test('the customer picks their receipt, even when only one is waiting, and gets its number', async () => {
    const choose = await scan();
    assert.equal(choose.status, 200);
    assert.deepEqual([...choose.data.choose].sort(), ['27', '41']);
    const mine = await scan({ pick: '41' });
    assert.equal(mine.status, 200);
    assert.deepEqual([mine.data.number, mine.data.ref, mine.data.receipt], [2, null, '41']);
    const last = await scan();
    assert.deepEqual(last.data.choose, ['27'], 'one left: still asked, it may be someone else\'s');
    const tile = (await bar.get('/api/bar/take-a/state')).data.orders.find((o) => o.id === mine.data.id);
    assert.equal(tile.receipt, '41', 'the cashier tile shows the receipt under the number');
  });

  test('the QR on the receipt opens that receipt\'s number', async () => {
    const res = await client(server.url).post('/api/b/take-a/claim', { k, receipt: '27' }, { headers: { 'x-client-id': 'r'.repeat(20) } });
    assert.equal(res.status, 200);
    assert.deepEqual([res.data.number, res.data.receipt], [1, '27']);
  });

  test('− takes back a typed receipt nobody scanned', async () => {
    assert.equal((await typed('55')).data.number, 3);
    const counter = (await bar.post('/api/bar/take-a/counter', { delta: -1 })).data;
    assert.equal(counter.next, 3);
    assert.equal(counter.waiting ?? 0, 0);
    assert.equal((await typed('56')).data.number, 3, 'the number is given again');
  });

  test('with order QR mode the order exists right away', async () => {
    await owner.post('/api/brand/take/branches/take-a/settings', { orderQr: true });
    const res = await typed('90');
    assert.equal(res.status, 200);
    assert.equal(res.data.order.receipt, '90');
    assert.equal(res.data.order.number, 4);
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

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { parseNumber, readOrders } from '../src/pos.js';
import { client, sse, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';
let seq = 0;

// Payloads shaped like each system's documentation.
const loyverse = (number, diningOption = 'Dine in', extra = {}) => ({
  merchant_id: '5fk4f446-01d2-8787-4fd5-7b7b1995df85',
  type: 'receipts.update',
  created_at: '2026-11-05T17:23:48.562Z',
  receipts: [{
    receipt_number: `2-${number}`, receipt_type: 'SALE', order: 'O-1598498', cancelled_at: null, dining_option: diningOption,
    customer_id: '7fa4f446-01d2-8787-4fd5-7b7b1995df85', line_items: [{ quantity: 2, sku: '10001' }], ...extra,
  }],
});
const foodics = (number, type) => ({
  timestamp: 1788000000,
  event: 'customer.order.created',
  business: { name: 'Cafe', reference: 123456 },
  order: { id: '8f9a3c2e-1111-4222-8333-abcdefabcdef', number, type, status: 4, reference: '00987', customer: { phone: '0100000', name: 'X' } },
});

describe('reading orders from POS payloads', () => {
  test('numbers: receipts with prefixes, plain numbers, never ids', () => {
    assert.equal(parseNumber('2-1008'), 1008);
    assert.equal(parseNumber('INV-0045'), 45);
    assert.equal(parseNumber(77), 77);
    assert.equal(parseNumber('Order 00001-001-0042'), 42);
    assert.equal(parseNumber('123456'), 3456, 'keeps the last 4 digits');
    assert.equal(parseNumber('8f9a3c2e-1111-4222-8333-abcdefabc123'), null);
    assert.equal(parseNumber('abc'), null);
    assert.equal(parseNumber(0), null);
    assert.equal(parseNumber(1.5), null);
  });

  test('Loyverse: the receipt inside the envelope, with its dining option', () => {
    assert.deepEqual(readOrders(loyverse(1008)), [{ number: 1008, ref: '2-1008', delivery: false, cancelled: false }]);
    assert.equal(readOrders(loyverse(1009, 'Delivery'))[0].delivery, true);
    assert.equal(readOrders(loyverse(1010, 'Dine in', { cancelled_at: '2026-11-05T18:00:00Z' }))[0].cancelled, true);
    assert.equal(readOrders(loyverse(1011, 'Dine in', { receipt_type: 'REFUND' }))[0].cancelled, true);
  });

  test('Foodics: order.number (not the business or customer number); delivery needs the code on the link', () => {
    const [order] = readOrders(foodics(55, 3), { deliveryCode: '3' });
    assert.deepEqual(order, { number: 55, ref: null, delivery: true, cancelled: false });
    assert.equal(readOrders(foodics(55, 3))[0].delivery, false, 'a bare number means nothing without the code');
    assert.equal(readOrders(foodics(56, 1), { deliveryCode: '3' })[0].delivery, false);
  });

  test('other shapes: flat, Arabic, several orders, nothing usable', () => {
    assert.deepEqual(readOrders({ order_number: '12', order_type: 'توصيل' }), [{ number: 12, ref: null, delivery: true, cancelled: false }]);
    assert.equal(readOrders({ ticketNo: 'T-9', channel: 'Talabat' })[0].delivery, true);
    assert.equal(readOrders({ pos_reference: 'Order 00001-001-0042' })[0].number, 42);
    assert.deepEqual(readOrders({ orders: [{ number: 1 }, { number: 2, status: 'cancelled' }] }).map((o) => [o.number, o.cancelled]), [[1, false], [2, true]]);
    assert.deepEqual(readOrders({ hello: 'world', customer: { number: 5 } }), []);
  });
});

describe('the POS link', () => {
  let server;
  let su;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD), CLAIM_RATE_PER_MIN: '1000' });
    su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
  });
  after(() => server?.stop());

  async function newBranch() {
    const id = `pos${++seq}`;
    await su.post('/api/super/brands', { id, name: id });
    await su.post(`/api/super/brands/${id}/branches`, { id, name: id, pin: '1234', qrMode: 'static' });
    const bar = client(server.url);
    await bar.post('/api/bar/login', { shopId: id, pin: '1234' });
    const state = async () => (await bar.get(`/api/bar/${id}/state`)).data;
    const k = new URL((await state()).qr.staticUrl).searchParams.get('k');
    const pos = (await bar.get(`/api/bar/${id}/pos`)).data;
    const path = new URL(pos.url).pathname;
    const anon = client(server.url);
    return {
      id,
      bar,
      path,
      state,
      counter: async () => (await state()).counter,
      send: (payload, query = '') => anon.post(`${path}${query}`, payload),
      scan: async (extra = {}) => (await client(server.url).post(`/api/b/${id}/claim`, { k, ...extra })),
      status: async () => (await bar.get(`/api/bar/${id}/pos`)).data.last,
    };
  }

  test('delivery moves the count by itself; the next customer gets the right number', async () => {
    const b = await newBranch();
    assert.equal((await b.send({ number: 1, type: 'delivery' })).data.orders[0].result, 'delivery');
    assert.equal((await b.send({ number: 2, type: 'delivery' })).data.orders[0].result, 'delivery');
    assert.deepEqual(await b.counter(), { next: 3, last: 2 });
    assert.equal((await b.scan()).data.number, 3);
  });

  test('a dine-in number waits for its customer: the scan gets the number on the receipt', async () => {
    const b = await newBranch();
    assert.equal((await b.send({ number: 41, type: 'dine_in' })).data.orders[0].result, 'waiting');
    assert.deepEqual(await b.counter(), { next: 42, last: 41, waiting: 1 });
    assert.equal((await b.scan()).data.number, 41);
    assert.deepEqual(await b.counter(), { next: 42, last: 41 });
  });

  test('someone did not scan: the next customer picks their number, and the count stays right', async () => {
    const b = await newBranch();
    await b.send({ number: 10, type: 'takeaway' }); // never scans
    await b.send({ number: 11, type: 'dine_in' });
    const asked = await b.scan({ canPick: true });
    assert.deepEqual(asked.data, { choose: ['10', '11'] }, 'labels, as printed on the receipts');
    assert.equal((await b.state()).orders.length, 0, 'no order until they pick');
    const picked = await b.scan({ canPick: true, pick: 11 });
    assert.equal(picked.data.number, 11);
    const again = await b.scan({ canPick: true, pick: 11 });
    assert.equal(again.status, 409, 'a number is given once');
    assert.equal((await b.scan({ canPick: true, pick: 'new' })).data.number, 12, 'not on the list: the count goes on');
    assert.equal((await b.scan({ pick: 'abc' })).status, 400);
  });

  test('apps that cannot show a choice get the newest number', async () => {
    const b = await newBranch();
    await b.send({ number: 20 });
    await b.send({ number: 21 });
    assert.equal((await b.scan()).data.number, 21);
  });

  test('the scan came first: the late POS call matches it and nothing is offered twice', async () => {
    const b = await newBranch();
    await b.send({ number: 7, type: 'delivery' });
    assert.equal((await b.scan()).data.number, 8);
    assert.equal((await b.send({ number: 8, type: 'dine_in' })).data.orders[0].result, 'repeated');
    assert.deepEqual(await b.counter(), { next: 9, last: 8 });
  });

  test('a number with an open order is matched even if the POS is the one who reports it first', async () => {
    const b = await newBranch();
    const scanned = await b.scan();
    assert.equal(scanned.data.number, 1);
    // The link was opened after the scan on another system: same number, no second offer.
    assert.equal((await b.send({ number: 1 })).data.orders[0].result, 'repeated');
    assert.deepEqual(await b.counter(), { next: 2, last: 1 });
  });

  test('the same order sent again changes nothing; a cancelled one is not offered', async () => {
    const b = await newBranch();
    await b.send(loyverse(30));
    assert.equal((await b.send(loyverse(30))).data.orders[0].result, 'repeated');
    assert.equal((await b.counter()).waiting, 1);
    await b.send(loyverse(30, 'Dine in', { cancelled_at: '2026-11-05T18:00:00Z' }));
    assert.deepEqual(await b.counter(), { next: 31, last: 30 }, 'the POS does not reuse it, so the count stays');
    assert.equal((await b.scan()).data.number, 31);
  });

  test('a refund has its own receipt number and does not move the count', async () => {
    const b = await newBranch();
    await b.send(loyverse(30, 'Delivery'));
    await b.send(loyverse(31, 'Dine in', { receipt_type: 'REFUND' }));
    assert.deepEqual(await b.counter(), { next: 31, last: 30 });
  });

  test('late calls do not pull the count back; a restarted POS does', async () => {
    const b = await newBranch();
    await b.send({ number: 100, type: 'delivery' });
    await b.send({ number: 99, type: 'delivery' });
    assert.equal((await b.counter()).next, 101);
    await b.send({ number: 3, type: 'delivery' });
    assert.equal((await b.counter()).next, 4);
  });

  test('numbers past the biggest number raise it instead of wrapping', async () => {
    const b = await newBranch();
    await b.send({ number: 1500, type: 'delivery' });
    assert.equal((await b.counter()).next, 1501);
    assert.equal((await b.state()).shop.maxNumber, 9999);
    assert.equal((await b.scan()).data.number, 1501);
  });

  test('+ and − still work with a POS linked, and − drops the waiting number', async () => {
    const b = await newBranch();
    await b.send({ number: 5 });
    assert.equal((await b.counter()).waiting, 1);
    assert.deepEqual((await b.bar.post(`/api/bar/${b.id}/counter`, { delta: -1 })).data, { next: 5, last: 4 });
    assert.equal((await b.bar.post(`/api/bar/${b.id}/counter`, { delta: 1 })).data.next, 6);
  });

  test('Foodics link: the delivery code comes from the link', async () => {
    const b = await newBranch();
    assert.equal((await b.send(foodics(60, 3), '?delivery=3')).data.orders[0].result, 'delivery');
    assert.equal((await b.send(foodics(61, 1), '?delivery=3')).data.orders[0].result, 'waiting');
  });

  test('forms and plain GET links work too', async () => {
    const b = await newBranch();
    const anon = client(server.url);
    const form = await anon.request('POST', b.path, { body: 'number=15&type=delivery', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.data.orders[0].result, 'delivery');
    assert.equal((await anon.get(`${b.path}?number=16&type=delivery`)).data.orders[0].number, 16);
    const noType = await anon.request('POST', b.path, { body: '{"number":17,"type":"delivery"}' });
    assert.equal(noType.data.orders[0].number, 17, 'no content type at all');
    assert.deepEqual((await anon.get(b.path)).data, { ok: true }, 'opening it in a browser changes nothing');
    assert.equal((await b.counter()).next, 18);
  });

  test('a test call moves nothing', async () => {
    const b = await newBranch();
    const res = await b.send({ test: true, number: 123, type: 'delivery' });
    assert.equal(res.data.ok, true);
    assert.equal(res.data.test, true);
    assert.deepEqual(await b.counter(), { next: 1, last: null });
    assert.equal(await b.status(), null);
  });

  test('settings show the last order, or the field names of what could not be read (no values)', async () => {
    const b = await newBranch();
    assert.equal(await b.status(), null);
    await b.send({ number: 9, type: 'delivery' });
    assert.equal((await b.status()).number, 9);
    assert.equal((await b.status()).delivery, true);
    const res = await b.send({ guest_phone: '01000000000', total: 'x' });
    assert.equal(res.status, 200, 'answers 200 so the system does not retry forever');
    assert.equal(res.data.ok, false);
    const last = await b.status();
    assert.equal(last.unread, true);
    assert.deepEqual(last.keys, ['guest_phone', 'total']);
    assert.equal(JSON.stringify(last).includes('01000000000'), false);
  });

  test('bad or old tokens get nothing, tokens never reach the public pages, and rotating cuts the old link', async () => {
    const b = await newBranch();
    const other = await newBranch();
    assert.equal((await client(server.url).post(`/api/pos/${b.id}/wrong-token`, { number: 1 })).status, 404);
    const otherToken = other.path.split('/').pop();
    assert.equal((await client(server.url).post(`/api/pos/${b.id}/${otherToken}`, { number: 1 })).status, 404, 'a token works on its own branch only');
    assert.equal((await client(server.url).post('/api/pos/nope/x', { number: 1 })).status, 404);

    const token = b.path.split('/').pop();
    const pub = (await client(server.url).get(`/api/b/${b.id}`)).data;
    assert.equal(JSON.stringify(pub).includes(token), false);
    assert.equal(JSON.stringify(await b.state()).includes(token), false);
    assert.equal((await client(server.url).get(`/api/bar/${b.id}/pos`)).status, 401, 'the link is behind the branch login');

    const rotated = (await b.bar.post(`/api/bar/${b.id}/pos/rotate`, {})).data;
    assert.notEqual(new URL(rotated.url).pathname, b.path);
    assert.equal((await b.send({ number: 1 })).status, 404);
    assert.equal((await client(server.url).post(new URL(rotated.url).pathname, { number: 1 })).status, 200);
  });

  test('the cashier screen follows the POS right away', async () => {
    const b = await newBranch();
    const cookie = [...b.bar.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const stream = await sse(`${server.url}/api/bar/${b.id}/events`, { cookie });
    try {
      await stream.next('hello');
      await b.send({ number: 50, type: 'delivery' });
      assert.deepEqual((await stream.next('counter')).data, { next: 51, last: 50 });
    } finally {
      stream.close();
    }
  });

  test('the demo café: the link shows but can not be changed', async () => {
    const v = client(server.url);
    await v.get('/demo');
    assert.equal((await v.get('/api/bar/demo/pos')).status, 200);
    assert.equal((await v.post('/api/bar/demo/pos/rotate', {})).status, 403);
    const info = (await v.get('/api/demo')).data;
    assert.equal(info.theme['--accent'].length, 7, 'the demo wears a color');
    assert.ok(info.theme['--bg'] !== '#17191d');
  });

  test('a branch color reaches every page data source; choosing the default stays chosen', async () => {
    const b = await newBranch();
    assert.equal((await b.state()).shop.theme, null);
    assert.equal((await b.state()).shop.themeVersion, 0, 'not read from a logo yet');
    const res = await b.bar.post(`/api/bar/${b.id}/settings`, { accentColor: '#b5121b' });
    assert.ok(res.data.shop.theme['--bg']);
    assert.ok((await client(server.url).get(`/api/b/${b.id}`)).data.theme['--bg']);
    const owner = await su.post(`/api/super/brands/${b.id}/owners`, { username: `o${b.id}`, password: 'long-password-1' });
    const ownerClient = client(server.url);
    await ownerClient.post('/api/brand/login', { username: owner.data.owner.username, password: 'long-password-1' });
    assert.ok((await ownerClient.get(`/api/brand/${b.id}/overview`)).data.brand.theme['--bg']);
    const reset = await b.bar.post(`/api/bar/${b.id}/settings`, { accentColor: null });
    assert.equal(reset.data.shop.theme, null);
    assert.equal(reset.data.shop.themeVersion, 1, 'the logo is not read again over this choice');
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { client, sse, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';
let seq = 0;

describe('the count: + and − on the cashier screen', () => {
  let server;
  let su;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD), CLAIM_RATE_PER_MIN: '1000' });
    su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
  });
  after(() => server?.stop());

  async function newBranch(extra = {}) {
    const id = `count${++seq}`;
    await su.post('/api/super/brands', { id, name: id });
    const res = await su.post(`/api/super/brands/${id}/branches`, { id, name: id, pin: '1234', qrMode: 'static', ...extra });
    assert.equal(res.status, 201);
    const bar = client(server.url);
    assert.equal((await bar.post('/api/bar/login', { shopId: id, pin: '1234' })).status, 200);
    const state = (await bar.get(`/api/bar/${id}/state`)).data;
    const k = new URL(state.qr.staticUrl).searchParams.get('k');
    return {
      id,
      bar,
      state: async () => (await bar.get(`/api/bar/${id}/state`)).data,
      step: (delta) => bar.post(`/api/bar/${id}/counter`, { delta }),
      scan: async () => (await client(server.url).post(`/api/b/${id}/claim`, { k })).data,
    };
  }

  test('a new day starts with no last number and next number 1', async () => {
    const b = await newBranch();
    assert.deepEqual((await b.state()).counter, { next: 1, last: null });
  });

  test('+ skips a number: the next customer gets the one after it', async () => {
    const b = await newBranch();
    assert.equal((await b.scan()).number, 1);
    const res = await b.step(1); // number 2 went to a delivery order
    assert.deepEqual(res.data, { next: 3, last: 2 });
    assert.equal((await b.scan()).number, 3);
    assert.deepEqual((await b.state()).counter, { next: 4, last: 3 });
  });

  test('− takes one back and the number is given again', async () => {
    const b = await newBranch();
    await b.step(1);
    await b.step(1);
    assert.deepEqual((await b.step(-1)).data, { next: 2, last: 1 });
    assert.equal((await b.scan()).number, 2);
  });

  test('− stops at the start of the count', async () => {
    const b = await newBranch();
    const res = await b.step(-1);
    assert.equal(res.status, 409);
    assert.deepEqual((await b.state()).counter, { next: 1, last: null });
  });

  test('− refuses a number with an open order, and works once it is cancelled', async () => {
    const b = await newBranch();
    const order = await b.scan();
    const res = await b.step(-1);
    assert.equal(res.status, 409);
    assert.match(res.data.error, /رقم 1/);
    await b.bar.post(`/api/bar/${b.id}/orders/${order.id}/status`, { status: 'cancelled' });
    assert.deepEqual((await b.step(-1)).data, { next: 1, last: null });
  });

  test('+ wraps after the biggest number and never lands on an open one', async () => {
    const b = await newBranch();
    await b.bar.post(`/api/bar/${b.id}/settings`, { maxNumber: 10 });
    const first = await b.scan();
    assert.equal(first.number, 1);
    for (let i = 0; i < 8; i++) await b.step(1); // up to 9
    assert.equal((await b.state()).counter.last, 9);
    const wrapped = await b.step(1); // 10 is skipped, 1 is still open
    assert.equal(wrapped.status, 200);
    assert.equal(wrapped.data.next, 2);
    assert.equal((await b.scan()).number, 2);
  });

  test('only + and − are accepted, and only with the branch session', async () => {
    const b = await newBranch();
    for (const delta of [2, 0, '1', null]) assert.equal((await b.step(delta)).status, 400);
    assert.equal((await client(server.url).post(`/api/bar/${b.id}/counter`, { delta: 1 })).status, 401);
    const other = await newBranch();
    assert.equal((await other.bar.post(`/api/bar/${b.id}/counter`, { delta: 1 })).status, 401);
    assert.deepEqual((await b.state()).counter, { next: 1, last: null });
  });

  test('every open cashier screen gets the new count right away', async () => {
    const b = await newBranch();
    const cookie = [...b.bar.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const stream = await sse(`${server.url}/api/bar/${b.id}/events`, { cookie });
    try {
      await stream.next('hello');
      await b.step(1);
      assert.deepEqual((await stream.next('counter')).data, { next: 2, last: 1 });
      await b.scan();
      const created = await stream.next('order', (d) => d.action === 'created');
      assert.deepEqual(created.data.counter, { next: 3, last: 2 });
    } finally {
      stream.close();
    }
  });

  test('the demo café has + and − too', async () => {
    const v = client(server.url);
    await v.get('/demo');
    assert.equal((await v.post('/api/bar/demo/counter', { delta: 1 })).status, 200);
    assert.equal((await v.post('/api/bar/demo/counter', { delta: -1 })).status, 200);
  });
});

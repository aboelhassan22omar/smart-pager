import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { businessDay, businessDayStart, isTimeZone } from '../src/util.js';
import { client, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';
let seq = 0;

describe('the branch day', () => {
  // 2026-11-05 23:30 UTC = 2026-11-06 01:30 in Cairo (UTC+2).
  const lateNight = Date.UTC(2026, 10, 5, 23, 30);

  test('a branch open past midnight still counts 1:30am as the day before when its day starts at 6', () => {
    assert.equal(businessDay('Africa/Cairo', 0, lateNight), '2026-11-06');
    assert.equal(businessDay('Africa/Cairo', 6, lateNight), '2026-11-05');
    assert.equal(businessDayStart('Africa/Cairo', 6, lateNight), Date.UTC(2026, 10, 5, 4, 0));
  });

  test('each branch reads its own clock', () => {
    // 21:30 UTC: still the 5th in Cairo, already the 6th in Dubai.
    const t = Date.UTC(2026, 10, 5, 21, 30);
    assert.equal(businessDay('Africa/Cairo', 0, t), '2026-11-05');
    assert.equal(businessDay('Asia/Dubai', 0, t), '2026-11-06');
    assert.ok(isTimeZone('Asia/Riyadh'));
    assert.equal(isTimeZone('Mars/Base'), false);
    assert.equal(isTimeZone(''), false);
  });
});

describe('gaps around numbers and scans', () => {
  let server;
  let su;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
  });
  after(() => server?.stop());

  async function newBranch(extra = {}) {
    const id = `gap${++seq}`;
    await su.post('/api/super/brands', { id, name: id });
    const created = await su.post(`/api/super/brands/${id}/branches`, { id, name: id, pin: '1234', qrMode: 'static', ...extra });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const bar = client(server.url);
    await bar.post('/api/bar/login', { shopId: id, pin: '1234' });
    const state = async () => (await bar.get(`/api/bar/${id}/state`)).data;
    const k = new URL((await state()).qr.staticUrl).searchParams.get('k');
    const anon = client(server.url);
    let posPath = null;
    const pos = async (payload) => {
      posPath ??= new URL((await bar.get(`/api/bar/${id}/pos`)).data.url).pathname;
      return anon.post(posPath, payload);
    };
    const scan = (body = {}, { cid = `phone-${Math.random().toString(36).slice(2)}-xxxxxxxx`, ip } = {}) =>
      anon.post(`/api/b/${id}/claim`, { k, ...body }, { headers: { 'x-client-id': cid }, ip });
    return { id, bar, state, pos, scan, settings: (body) => bar.post(`/api/bar/${id}/settings`, body) };
  }

  test('timezone: chosen when the branch is made, changed from the super, validated', async () => {
    const b = await newBranch({ tz: 'Asia/Riyadh' });
    const branchOf = async () => (await su.get('/api/super/overview')).data.brands.find((x) => x.id === b.id).branches[0];
    assert.equal((await branchOf()).timezone, 'Asia/Riyadh');
    assert.equal((await b.state()).shop.timezone, 'Asia/Riyadh');
    assert.equal((await su.post(`/api/super/branches/${b.id}/timezone`, { tz: 'Mars/Base' })).status, 400);
    assert.equal((await su.post(`/api/super/branches/${b.id}/timezone`, { tz: 'Asia/Dubai' })).status, 200);
    assert.equal((await branchOf()).timezone, 'Asia/Dubai');
    assert.equal((await su.post(`/api/super/branches/${b.id}/timezone`, { tz: '' })).status, 200);
    assert.equal((await branchOf()).timezone, null, 'empty = the server time');
    await su.post('/api/super/brands', { id: 'tzbad', name: 'tzbad' });
    assert.equal((await su.post('/api/super/brands/tzbad/branches', { id: 'tzbad', name: 'x', pin: '1234', tz: 'Nope/Zone' })).data.field, 'tz');
  });

  test('changing the day start or the timezone mid-day keeps the count going', async () => {
    const b = await newBranch();
    await b.scan();
    await b.scan();
    assert.deepEqual((await b.state()).counter, { next: 3, last: 2 });
    for (const dayStartHour of [12, 6, 0]) {
      assert.equal((await b.settings({ dayStartHour })).status, 200);
      assert.equal((await b.state()).shop.dayStartHour, dayStartHour);
      assert.deepEqual((await b.state()).counter, { next: 3, last: 2 }, `start at ${dayStartHour}`);
    }
    await su.post(`/api/super/branches/${b.id}/timezone`, { tz: 'Pacific/Kiritimati' }); // UTC+14: often a day ahead
    assert.deepEqual((await b.state()).counter, { next: 3, last: 2 });
    assert.equal((await b.settings({ dayStartHour: 13 })).status, 400);
    assert.equal((await b.scan()).data.number, 3);
  });

  test('two POS terminals with the same number: both customers get their own receipt number', async () => {
    const b = await newBranch();
    const receipt = (number) => ({ receipts: [{ receipt_number: number, dining_option: 'Dine in', cancelled_at: null }] });
    assert.equal((await b.pos(receipt('1-1001'))).data.orders[0].result, 'waiting');
    assert.equal((await b.pos(receipt('2-1001'))).data.orders[0].result, 'waiting', 'not a repeat of terminal 1');
    assert.equal((await b.state()).counter.waiting, 2);

    const asked = await b.scan({ canPick: true });
    assert.deepEqual(asked.data, { choose: ['1-1001', '2-1001'] });
    const second = await b.scan({ canPick: true, pick: '2-1001' });
    assert.equal(second.data.number, 1001);
    assert.equal(second.data.ref, '2-1001');
    const first = await b.scan({ canPick: true });
    assert.equal(first.data.ref, '1-1001', 'the one left is given straight away');
    const open = (await b.state()).orders.map((o) => o.ref).sort();
    assert.deepEqual(open, ['1-1001', '2-1001']);
    assert.equal((await b.pos(receipt('2-1001'))).data.orders[0].result, 'repeated');
  });

  test('phones sharing one IP (mobile data) are not turned away; one phone still is', async () => {
    const b = await newBranch();
    const ip = '10.9.9.9';
    for (let i = 0; i < 12; i++) assert.equal((await b.scan({}, { ip })).status, 200, `phone ${i}`);
    const cid = 'one-phone-with-a-long-id';
    const statuses = [];
    for (let i = 0; i < 8; i++) statuses.push((await b.scan({}, { ip: '10.8.8.8', cid })).status);
    assert.deepEqual(statuses.slice(0, 6), Array(6).fill(200));
    assert.equal(statuses.at(-1), 429);
  });

  test('POS-only: no number without the POS, the customer waits for it, then gets the receipt number', async () => {
    const b = await newBranch();
    await b.pos({ test: true, number: 1 }); // creates the link
    assert.equal((await b.settings({ posOnly: true })).data.shop.posOnly, true);
    const early = await b.scan({ canPick: true });
    assert.equal(early.status, 409);
    assert.equal(early.data.wait, true);
    assert.equal((await b.scan({ canPick: true, pick: 'new' })).data.wait, true, '"my number is not here" waits too');
    await b.pos({ number: 77, type: 'takeaway' });
    assert.equal((await b.scan({ canPick: true })).data.number, 77);
    await b.pos({ number: 78, type: 'delivery' });
    assert.equal((await b.scan()).status, 409, 'a delivery never becomes a scan');
    assert.equal((await b.settings({ posOnly: false })).status, 200);
    assert.equal((await b.scan()).data.number, 79, 'off again: the count goes on');
  });

  test('POS-only does nothing until a POS link exists', async () => {
    const b = await newBranch();
    await b.settings({ posOnly: true });
    assert.equal((await b.scan()).data.number, 1);
  });

  test('the demo café keeps its settings locked', async () => {
    const v = client(server.url);
    await v.get('/demo');
    assert.equal((await v.post('/api/bar/demo/settings', { posOnly: true })).status, 403);
    assert.equal((await v.post('/api/bar/demo/settings', { dayStartHour: 6 })).status, 403);
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { findNumber, isCancel, isSkipped } from '../src/printer.js';
import { client, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';
const hash = (s) => s.padEnd(64, '0').slice(0, 64);
// GS v 0: the QR raster the agent adds before the cut.
const hasRaster = (b64) => Buffer.from(b64, 'base64').includes(Buffer.from([0x1d, 0x76, 0x30, 0x00]));

describe('reading receipts', () => {
  test('the receipt number, in English or Arabic, with Arabic digits too', () => {
    assert.equal(findNumber('CAFE X  Order No: 27  Total 55.00'), '27');
    assert.equal(findNumber('Invoice #1043'), '1043');
    assert.equal(findNumber('مطعم   رقم الفاتورة : ٢٧   الإجمالي'), '27');
    assert.equal(findNumber('فاتورة رقم 88'), '88');
    assert.equal(findNumber('Total 120.00 Cash 200'), null, 'no keyword, no number');
    assert.equal(findNumber('Ticket 12', { pattern: String.raw`Ticket\s+(\d+)` }), '12');
  });

  test('reports and cancel slips are told apart; a "no refunds" footer is a normal receipt', () => {
    assert.ok(isSkipped('Z REPORT 2026-11-12'));
    assert.ok(isSkipped('تقرير الوردية'));
    assert.ok(!isSkipped('Order No: 27'));
    assert.ok(isCancel('*** VOID *** Order No: 27'));
    assert.ok(isCancel('فاتورة مرتجع رقم الفاتورة 27'));
    assert.ok(!isCancel('Order No: 27 ... No refunds after 24 hours. لا يرد ولا يستبدل'));
  });
});

describe('the receipt printer agent, server side', () => {
  let server;
  let su;
  let bar;
  let token;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
    await su.post('/api/super/brands', { id: 'prn', name: 'Print' });
    await su.post('/api/super/brands/prn/branches', { id: 'prn-a', name: 'Print', pin: '1234', qrMode: 'static' });
    bar = client(server.url);
    await bar.post('/api/bar/login', { shopId: 'prn-a', pin: '1234' });
  });
  after(() => server?.stop());

  const job = (text, h = hash(Math.random().toString(16).slice(2))) => client(server.url)
    .post(`/api/pos/prn-a/${token}/printer/job`, { text, hash: h, size: text.length });
  const open = async () => (await bar.get('/api/bar/prn-a/state')).data.orders;

  test('the super turns it on: the install and remove commands carry the branch link', async () => {
    const res = await su.post('/api/super/branches/prn-a/printer', { enabled: true, printer: 'XP-80C' });
    assert.equal(res.status, 200);
    assert.equal(res.data.enabled, true);
    assert.match(res.data.commands.install, /irm '.+\/api\/pos\/prn-a\/[A-Za-z0-9_-]+\/printer\.ps1' \| iex/);
    assert.match(res.data.commands.remove, /printer-remove\.ps1/);
    token = res.data.commands.install.match(/\/api\/pos\/prn-a\/([A-Za-z0-9_-]+)\//)[1];
    assert.equal((await su.post('/api/super/branches/prn-a/printer', { enabled: true, pattern: '(' })).status, 400);
  });

  test('the scripts are served with the branch filled in', async () => {
    const install = await (await fetch(`${server.url}/api/pos/prn-a/${token}/printer.ps1`)).text();
    assert.match(install, /\$Branch = 'prn-a'/);
    assert.match(install, new RegExp(`\\$Token = '${token}'`));
    assert.match(install, /\$Wanted = 'XP-80C'/);
    assert.match(await (await fetch(`${server.url}/api/pos/prn-a/${token}/printer/agent.ps1`)).text(), /TcpListener/);
    assert.match(await (await fetch(`${server.url}/api/pos/prn-a/${token}/printer-remove.ps1`)).text(), /originalPort/);
    assert.equal((await fetch(`${server.url}/api/pos/prn-a/wrong-token/printer.ps1`)).status, 404);
  });

  test('a readable receipt: its order, with its number, and the QR to add', async () => {
    const res = await job('MY CAFE\nOrder No: 27\nLatte 45.00');
    assert.equal(res.status, 200);
    assert.equal(res.data.number, '27');
    assert.ok(hasRaster(res.data.append));
    assert.ok((await open()).some((o) => o.number === 27));
  });

  test('the same receipt again (reprint, a second copy): the same order, no new one', async () => {
    const before = (await open()).length;
    const again = await job('MY CAFE\nOrder No: 27\nCOPY');
    assert.equal(again.data.number, '27');
    assert.equal((await open()).length, before);
  });

  test('a receipt printed as a picture: the next number, printed big; its copy right after joins it', async () => {
    const first = await job('\u0001\u0002 garbage bytes of an image');
    assert.ok(first.data.append);
    assert.ok(Buffer.from(first.data.append, 'base64').toString('latin1').includes(`No. ${first.data.number}`));
    const copy = await job('other garbage of the kitchen copy');
    assert.equal(copy.data.number, first.data.number);
  });

  test('reports print as they are', async () => {
    const res = await job('Z REPORT\nTotal sales 5400');
    assert.equal(res.data.append, null);
    assert.equal(res.data.reason, 'skipped');
  });

  test('a cancel slip cancels that receipt\'s order and prints as it is', async () => {
    await job('MY CAFE\nOrder No: 31\nFalafel');
    assert.ok((await open()).some((o) => o.number === 31));
    const res = await job('*** VOID ***\nOrder No: 31');
    assert.equal(res.data.append, null);
    assert.equal(res.data.reason, 'cancelled');
    assert.ok(!(await open()).some((o) => o.number === 31));
    const view = (await su.get('/api/super/branches/prn-a/printer')).data;
    assert.equal(view.last.cancelled, true, 'the super sees what the last slip was');
  });

  test('turned off: everything prints as it is', async () => {
    await su.post('/api/super/branches/prn-a/printer', { enabled: false });
    const res = await job('Order No: 40');
    assert.equal(res.data.append, null);
  });

  test('cancelled at the POS after the customer scanned: the order is cancelled here too', async () => {
    const link = `/api/pos/prn-a/${token}`;
    const api = client(server.url);
    await api.post(link, { number: 77 });
    const k = new URL((await bar.get('/api/bar/prn-a/state')).data.qr.staticUrl).searchParams.get('k');
    const mine = (await client(server.url).post('/api/b/prn-a/claim', { k })).data;
    assert.equal(mine.number, 77);
    await api.post(link, { number: 77, status: 'cancelled' });
    const now = (await client(server.url).get(`/api/b/prn-a/orders/${mine.id}`)).data;
    assert.equal(now.status, 'cancelled');
  });
});

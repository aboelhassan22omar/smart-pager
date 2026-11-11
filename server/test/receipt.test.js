import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { client, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';

// The QR a POS prints on each receipt: /r/<branch>/<key>/<receipt number>.
describe('a QR on each receipt', () => {
  let server;
  let bar;
  let key;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    const su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
    await su.post('/api/super/brands', { id: 'rcpt', name: 'Receipt' });
    await su.post('/api/super/brands/rcpt/branches', { id: 'rcpt-a', name: 'Receipt', pin: '1234', qrMode: 'dynamic' });
    bar = client(server.url);
    await bar.post('/api/bar/login', { shopId: 'rcpt-a', pin: '1234' });
    key = new URL((await bar.get('/api/bar/rcpt-a/pos')).data.receiptUrl.replace('{order}', '0')).pathname.split('/')[3];
  });
  after(() => server?.stop());

  const open = (receipt, k = key) => fetch(`${server.url}/r/rcpt-a/${k}/${receipt}`, { redirect: 'manual' });
  const claim = (receipt, clientId) => client(server.url).post('/api/b/rcpt-a/claim', { k: key, receipt }, { headers: { 'x-client-id': clientId } });

  test('the settings page gives the link with {order} in it', async () => {
    const { receiptUrl } = (await bar.get('/api/bar/rcpt-a/pos')).data;
    assert.match(receiptUrl, /\/r\/rcpt-a\/[A-Za-z0-9_-]+\/\{order\}$/);
  });

  test('no POS link: the receipt number is the order number; a second phone joins it', async () => {
    const first = await open(27);
    assert.equal(first.status, 302);
    assert.match(first.headers.get('location'), /^\/s\/rcpt-a\?k=.+&r=27$/);
    const mine = await claim('27', 'aaaaaaaaaaaaaaaaaaaa');
    assert.equal(mine.status, 200);
    assert.equal(mine.data.number, 27, 'works even with the screen on the changing QR');

    const again = await open(27);
    assert.equal(again.headers.get('location'), `/s/rcpt-a?o=${mine.data.id}&j=1`, 'the same order for the next phone');
    const other = await claim('27', 'bbbbbbbbbbbbbbbbbbbb');
    assert.equal(other.data.id, mine.data.id, 'a claim on the same receipt is the same order');
  });

  test('a wrong key or receipt opens nothing', async () => {
    assert.equal((await open(28, 'wrong-key-0000000000')).status, 404);
    assert.equal((await open('abc')).status, 404);
  });

  test('with the POS sending orders: its number, after a short wait when it is not in yet', async () => {
    const { url } = (await bar.get('/api/bar/rcpt-a/pos')).data;
    const posPath = new URL(url).pathname;
    const send = (body) => fetch(server.url + posPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await send({ number: 40 });
    const early = await claim('41', 'cccccccccccccccccccc');
    assert.equal(early.status, 409, 'receipt 41 is not in yet');
    assert.equal(early.data.wait, true);
    await send({ number: 41 });
    const late = await claim('41', 'cccccccccccccccccccc');
    assert.equal(late.status, 200);
    assert.equal(late.data.number, 41);
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { client, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';

// «رسالة للإدارة»: a box at the bottom of the order page, on/off per branch; the owner reads
// the messages in the analytics.
describe('a message to the management', () => {
  let server;
  let owner;
  let bar;
  let k;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    const su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
    await su.post('/api/super/brands', { id: 'note', name: 'Note' });
    await su.post('/api/super/brands/note/branches', { id: 'note-a', name: 'Note A', pin: '1234', qrMode: 'static' });
    await su.post('/api/super/brands/note/owners', { username: 'note.owner', password: 'note-owner-pass' });
    owner = client(server.url);
    await owner.post('/api/brand/login', { username: 'note.owner', password: 'note-owner-pass' });
    bar = client(server.url);
    await bar.post('/api/bar/login', { shopId: 'note-a', pin: '1234' });
    k = new URL((await bar.get('/api/bar/note-a/state')).data.qr.staticUrl).searchParams.get('k');
  });
  after(() => server?.stop());

  const claim = async () => (await client(server.url).post('/api/b/note-a/claim', { k })).data;
  const send = (id, text) => client(server.url).post(`/api/b/note-a/orders/${id}/note`, { text });

  test('off by default: no box, and sending is refused', async () => {
    const order = await claim();
    assert.equal((await client(server.url).get('/api/b/note-a')).data.messageBox, false);
    assert.equal((await send(order.id, 'hello')).status, 404);
  });

  test('the owner turns it on; one message per order, while waiting or after pickup', async () => {
    assert.equal((await owner.post('/api/brand/note/branches/note-a/settings', { messageBox: true })).status, 200);
    assert.equal((await client(server.url).get('/api/b/note-a')).data.messageBox, true);
    const order = await claim();
    assert.equal((await send(order.id, '   ')).status, 400);
    assert.equal((await send(order.id, 'x'.repeat(501))).status, 400);
    assert.equal((await send(order.id, 'الأكل اتأخر شوية')).status, 201);
    assert.equal((await send(order.id, 'again')).status, 409);
    const view = (await client(server.url).get(`/api/b/note-a/orders/${order.id}`)).data;
    assert.equal(view.noteSent, true, 'the page shows "sent" after a reload');

    const picked = await claim();
    await bar.post(`/api/bar/note-a/orders/${picked.id}/status`, { status: 'picked' });
    assert.equal((await send(picked.id, 'شكراً، كان ممتاز')).status, 201);
  });

  test('a cancelled order takes no message', async () => {
    const order = await claim();
    await bar.post(`/api/bar/note-a/orders/${order.id}/status`, { status: 'cancelled' });
    assert.equal((await send(order.id, 'hi')).status, 409);
  });

  test('the owner reads them in the analytics, newest first', async () => {
    const day = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const report = (await owner.get(`/api/brand/note/analytics?from=${day(-1)}&to=${day(1)}`)).data;
    assert.equal(report.messages.count, 2);
    assert.deepEqual(report.messages.latest.map((m) => m.text), ['شكراً، كان ممتاز', 'الأكل اتأخر شوية']);
    assert.equal(report.messages.latest[0].branchName, 'Note A');
  });
});

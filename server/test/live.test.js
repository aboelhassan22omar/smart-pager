import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { client, sse, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';
const cookieHeader = (c) => [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');

// What the super does reaches open screens now, not on their next refresh; and every reply
// says which version the server runs, so open staff pages can take a new one by themselves.
describe('super actions reach open screens right away', () => {
  let server;
  let su;
  let bar;
  let k;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
    await su.post('/api/super/brands', { id: 'live', name: 'Live' });
    await su.post('/api/super/brands/live/branches', { id: 'live-a', name: 'Live', pin: '1234', qrMode: 'static' });
    bar = client(server.url);
    await bar.post('/api/bar/login', { shopId: 'live-a', pin: '1234' });
    k = new URL((await bar.get('/api/bar/live-a/state')).data.qr.staticUrl).searchParams.get('k');
  });
  after(() => server?.stop());

  test('every reply and the stream hello carry the build', async () => {
    const res = await fetch(`${server.url}/api/vapid-key`);
    assert.match(res.headers.get('x-build') ?? '', /^[0-9a-f]{12}$/);
    const stream = await sse(`${server.url}/api/bar/live-a/events`, { cookie: cookieHeader(bar) });
    const hello = await stream.next('hello');
    assert.equal(hello.data.build, res.headers.get('x-build'));
    stream.close();
  });

  test('reset: every cashier screen reloads, and a customer on a wiped order sees it closed', async () => {
    const order = (await client(server.url).post('/api/b/live-a/claim', { k })).data;
    const screen = await sse(`${server.url}/api/bar/live-a/events`, { cookie: cookieHeader(bar) });
    const customer = await sse(`${server.url}/api/b/live-a/orders/${order.id}/events`);
    await screen.next('hello');
    await customer.next('order');
    assert.equal((await su.post('/api/super/brands/live/reset-activity', { confirm: 'live' })).status, 200);
    await screen.next('reload');
    const gone = await customer.next('order', (d) => d.status === 'cancelled');
    assert.equal(gone.data.id, order.id);
    screen.close();
    customer.close();
  });

  test('a plan change (trial, payment...) tells the screens to fetch their state', async () => {
    const screen = await sse(`${server.url}/api/bar/live-a/events`, { cookie: cookieHeader(bar) });
    await screen.next('hello');
    assert.equal((await su.post('/api/super/branches/live-a/restart-trial', { days: 4 })).status, 200);
    await screen.next('state');
    const state = (await bar.get('/api/bar/live-a/state')).data;
    assert.equal(state.plan.daysLeft, 4);
    screen.close();
  });
});

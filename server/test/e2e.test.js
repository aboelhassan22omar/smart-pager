import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ADMIN_TOKEN, client, PNG_1X1, rawPost, sse, startServer } from './helpers.js';

let server;
let api;
let bar;

const SHOP = 'test-cafe';
const OTHER = 'other-cafe';

const nonceOf = (state) => new URL(state.qr.dynamicUrl).searchParams.get('n');
const keyOf = (state) => new URL(state.qr.staticUrl).searchParams.get('k');
const barState = async () => (await bar.get(`/api/bar/${SHOP}/state`)).data;
const cookieHeader = (c) => [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function claimDynamic() {
  const res = await api.post('/api/claim', { shopId: SHOP, n: nonceOf(await barState()) });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

before(async () => {
  server = await startServer();
  api = client(server.url);
  bar = client(server.url);
});

after(async () => {
  await server?.stop();
});

describe('admin API', () => {
  test('rejects missing or wrong token', async () => {
    const body = { id: SHOP, name: 'Test Café', pin: '1234' };
    assert.equal((await api.post('/api/admin/shops', body)).status, 401);
    assert.equal((await api.post('/api/admin/shops', body, { headers: { 'x-admin-token': 'nope' } })).status, 401);
  });

  test('validates input', async () => {
    const h = { headers: { 'x-admin-token': ADMIN_TOKEN } };
    assert.equal((await api.post('/api/admin/shops', { id: 'Bad Id', name: 'x', pin: '1234' }, h)).data.field, 'id');
    assert.equal((await api.post('/api/admin/shops', { id: 'okid', name: '', pin: '1234' }, h)).data.field, 'name');
    assert.equal((await api.post('/api/admin/shops', { id: 'okid', name: 'x', pin: '12' }, h)).data.field, 'pin');
  });

  test('creates shops and rejects duplicates', async () => {
    const h = { headers: { 'x-admin-token': ADMIN_TOKEN } };
    const res = await api.post('/api/admin/shops', { id: SHOP, name: 'Test Café', pin: '1234' }, h);
    assert.equal(res.status, 201);
    assert.equal(res.data.shop.id, SHOP);
    assert.equal(res.data.shop.qrMode, 'dynamic');
    assert.ok(res.data.urls.bar.endsWith(`/bar/${SHOP}`));
    assert.equal((await api.post('/api/admin/shops', { id: SHOP, name: 'Again', pin: '1234' }, h)).status, 409);
    assert.equal((await api.post('/api/admin/shops', { id: OTHER, name: 'Other', pin: '5678' }, h)).status, 201);

    const pub = await api.get(`/api/shops/${SHOP}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.data.name, 'Test Café');
    assert.equal(pub.data.pin_hash, undefined);
    assert.equal((await api.get('/api/shops/missing-shop')).status, 404);
  });
});

describe('PIN auth', () => {
  test('bar endpoints need a session', async () => {
    assert.equal((await api.get(`/api/bar/${SHOP}/state`)).status, 401);
  });

  test('wrong PIN is rejected, right PIN sets an httpOnly cookie', async () => {
    assert.equal((await bar.post('/api/bar/login', { shopId: SHOP, pin: '0000' })).status, 401);
    const res = await bar.post('/api/bar/login', { shopId: SHOP, pin: '1234' });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().join(';');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    const state = await bar.get(`/api/bar/${SHOP}/state`);
    assert.equal(state.status, 200);
    assert.equal(state.data.shop.id, SHOP);
    assert.deepEqual(state.data.orders, []);
  });

  test('a session for one shop does not open another', async () => {
    const res = await api.get(`/api/bar/${OTHER}/state`, { headers: { cookie: cookieHeader(bar).replaceAll(SHOP, OTHER) } });
    assert.equal(res.status, 401);
  });

  test('tampered cookie is rejected', async () => {
    const [name, value] = [...bar.jar][0];
    const res = await api.get(`/api/bar/${SHOP}/state`, { headers: { cookie: `${name}=${value.slice(0, -2)}xx` } });
    assert.equal(res.status, 401);
  });

  test('logout clears the session', async () => {
    const temp = client(server.url);
    await temp.post('/api/bar/login', { shopId: SHOP, pin: '1234' });
    assert.equal((await temp.get(`/api/bar/${SHOP}/state`)).status, 200);
    await temp.post(`/api/bar/${SHOP}/logout`);
    assert.equal((await temp.get(`/api/bar/${SHOP}/state`)).status, 401);
  });

  test('login is rate limited per IP', async () => {
    const ip = '10.99.99.99';
    let last;
    for (let i = 0; i < 6; i++) last = await api.post('/api/bar/login', { shopId: SHOP, pin: '9999' }, { ip });
    assert.equal(last.status, 429);
  });
});

describe('dynamic QR claim', () => {
  test('forged nonce is rejected', async () => {
    assert.equal((await api.post('/api/claim', { shopId: SHOP, n: 'forged-nonce-123' })).status, 403);
    assert.equal((await api.post('/api/claim', { shopId: SHOP })).status, 403);
    assert.equal((await api.post('/api/claim', { shopId: SHOP, n: '' })).status, 403);
  });

  test('claim rotates the nonce; previous nonce has a grace window', async () => {
    const n0 = nonceOf(await barState());
    const first = await api.post('/api/claim', { shopId: SHOP, n: n0 });
    assert.equal(first.status, 200);
    assert.equal(first.data.number, 1);
    assert.equal(first.data.status, 'preparing');
    assert.match(first.data.id, /^[A-Za-z0-9_-]{22}$/);

    const n1 = nonceOf(await barState());
    assert.notEqual(n1, n0);

    const grace = await api.post('/api/claim', { shopId: SHOP, n: n0 });
    assert.equal(grace.status, 200, 'previous nonce still valid once');
    assert.equal(grace.data.number, 2);

    assert.equal((await api.post('/api/claim', { shopId: SHOP, n: n0 })).status, 403, 'two rotations old');
  });

  test('static key is not accepted in dynamic mode', async () => {
    const shopKey = (await bar.post(`/api/bar/${SHOP}/settings`, { qrMode: 'both' })).data.qr;
    const k = new URL(shopKey.staticUrl).searchParams.get('k');
    await bar.post(`/api/bar/${SHOP}/settings`, { qrMode: 'dynamic' });
    assert.equal((await api.post('/api/claim', { shopId: SHOP, k })).status, 403);
  });

  test('bar SSE receives created orders and nonce events', async () => {
    const stream = await sse(`${server.url}/api/bar/${SHOP}/events`, { cookie: cookieHeader(bar) });
    assert.equal(stream.status, 200);
    await stream.next('hello');
    const order = await claimDynamic();
    const created = await stream.next('order', (d) => d.order.id === order.id);
    assert.equal(created.data.action, 'created');
    await stream.next('nonce');
    stream.close();
  });

  test('claim is rate limited per IP', async () => {
    const ip = '10.88.88.88';
    let last;
    for (let i = 0; i < 7; i++) last = await api.post('/api/claim', { shopId: SHOP, n: 'x' }, { ip });
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  });
});

describe('order lifecycle', () => {
  test('SSE ready event, re-notify, picked', async () => {
    const order = await claimDynamic();
    const stream = await sse(`${server.url}/api/orders/${order.id}/events`);
    assert.equal(stream.status, 200);
    assert.equal((await stream.next('order')).data.status, 'preparing');

    const ready = await bar.post(`/api/bar/${SHOP}/orders/${order.id}/advance`);
    assert.equal(ready.status, 200);
    assert.equal(ready.data.status, 'ready');
    const evReady = await stream.next('order', (d) => d.status === 'ready');
    assert.equal(evReady.data.notifyCount, 1);
    assert.equal(evReady.data.message, 'توجّه إلى الكاونتر لاستلام طلبك');
    assert.ok(evReady.data.readyAt);

    const again = await bar.post(`/api/bar/${SHOP}/orders/${order.id}/renotify`);
    assert.equal(again.data.notifyCount, 2);
    const evRenotify = await stream.next('renotify');
    assert.equal(evRenotify.data.notifyCount, 2);

    const picked = await bar.post(`/api/bar/${SHOP}/orders/${order.id}/advance`);
    assert.equal(picked.data.status, 'picked');
    assert.equal((await stream.next('order', (d) => d.status === 'picked')).data.message, 'بالهنا والشفا');
    stream.close();

    const fetched = await api.get(`/api/orders/${order.id}`);
    assert.equal(fetched.data.status, 'picked');
    assert.ok(fetched.data.closedAt);
    assert.equal((await bar.post(`/api/bar/${SHOP}/orders/${order.id}/advance`)).status, 409);
    assert.equal((await bar.post(`/api/bar/${SHOP}/orders/${order.id}/renotify`)).status, 409);
    assert.ok(!(await barState()).orders.some((o) => o.id === order.id), 'closed orders leave the grid');
  });

  test('renotify needs a ready order', async () => {
    const order = await claimDynamic();
    assert.equal((await bar.post(`/api/bar/${SHOP}/orders/${order.id}/renotify`)).status, 409);
  });

  test('status endpoint: back to preparing, cancel, validation', async () => {
    const order = await claimDynamic();
    const url = `/api/bar/${SHOP}/orders/${order.id}/status`;
    assert.equal((await bar.post(url, { status: 'ready' })).data.status, 'ready');
    const back = await bar.post(url, { status: 'preparing' });
    assert.equal(back.data.status, 'preparing');
    assert.equal(back.data.readyAt, null);
    assert.equal((await bar.post(url, { status: 'expired' })).status, 400);
    assert.equal((await bar.post(url, { status: 'cancelled' })).data.status, 'cancelled');
    assert.equal((await bar.post(url, { status: 'ready' })).status, 409);
  });

  test('bar actions require JSON and the right shop', async () => {
    const order = await claimDynamic();
    const res = await bar.request('POST', `/api/bar/${SHOP}/orders/${order.id}/advance`, {
      body: 'x',
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(res.status, 415);
    assert.equal((await bar.post(`/api/bar/${SHOP}/orders/notarealorderid000000/advance`)).status, 404);
  });

  test('unknown order ids 404', async () => {
    assert.equal((await api.get('/api/orders/does-not-exist-000000')).status, 404);
    assert.equal((await api.get('/api/orders/does-not-exist-000000/events')).status, 404);
  });
});

describe('static QR mode', () => {
  test('static mode accepts k, rejects n, and key rotation invalidates the old key', async () => {
    const res = await bar.post(`/api/bar/${SHOP}/settings`, { qrMode: 'static' });
    assert.equal(res.status, 200);
    const state = await barState();
    assert.equal(state.qr.dynamicUrl, null);
    const k0 = keyOf(state);

    assert.equal((await api.post('/api/claim', { shopId: SHOP, n: 'anything' })).status, 403);
    const claimed = await api.post('/api/claim', { shopId: SHOP, k: k0 });
    assert.equal(claimed.status, 200);
    assert.equal((await api.post('/api/claim', { shopId: SHOP, k: k0 })).status, 200, 'static key is reusable');

    await bar.post(`/api/bar/${SHOP}/settings`, { rotateStaticKey: true });
    const k1 = keyOf(await barState());
    assert.notEqual(k1, k0);
    assert.equal((await api.post('/api/claim', { shopId: SHOP, k: k0 })).status, 403);
    assert.equal((await api.post('/api/claim', { shopId: SHOP, k: k1 })).status, 200);
  });

  test('QR SVGs per kind, with download disposition', async () => {
    assert.equal((await bar.get(`/api/bar/${SHOP}/qr.svg?kind=dynamic`)).status, 409);
    const svg = await bar.get(`/api/bar/${SHOP}/qr.svg?kind=static&download=1`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(svg.headers.get('content-disposition'), /attachment; filename="test-cafe-qr-static.svg"/);
    assert.match(svg.data, /^<svg/);
    assert.equal((await api.get(`/api/bar/${SHOP}/qr.svg?kind=static`)).status, 401);
  });

  test('both mode accepts either code', async () => {
    await bar.post(`/api/bar/${SHOP}/settings`, { qrMode: 'both' });
    const state = await barState();
    assert.equal((await api.post('/api/claim', { shopId: SHOP, k: keyOf(state) })).status, 200);
    assert.equal((await api.post('/api/claim', { shopId: SHOP, n: nonceOf(state) })).status, 200);
    await bar.post(`/api/bar/${SHOP}/settings`, { qrMode: 'dynamic' });
  });
});

describe('settings', () => {
  const settings = (body) => bar.post(`/api/bar/${SHOP}/settings`, body);

  test('validates every field', async () => {
    assert.equal((await settings({ name: '   ' })).data.field, 'name');
    assert.equal((await settings({ preparingMessage: 'x'.repeat(141) })).data.field, 'preparingMessage');
    assert.equal((await settings({ readyMessage: '' })).data.field, 'readyMessage');
    assert.equal((await settings({ qrMode: 'sometimes' })).data.field, 'qrMode');
    assert.equal((await settings({ maxNumber: 5 })).data.field, 'maxNumber');
    assert.equal((await settings({ maxNumber: 12.5 })).status, 400);
    assert.equal((await settings({ expireHours: 48 })).data.field, 'expireHours');
    assert.equal((await settings({})).status, 400);
    assert.equal((await settings({ newPin: '12', currentPin: '1234' })).data.field, 'newPin');
    const wrongPin = await settings({ newPin: '4321', currentPin: '0000' });
    assert.equal(wrongPin.status, 403);
    assert.equal(wrongPin.data.field, 'currentPin');
  });

  test('saves fields and customers see new messages', async () => {
    const res = await settings({
      name: '  Test Café Two ',
      preparingMessage: 'بنعمل طلبك',
      readyMessage: 'تعالى خده',
      maxNumber: 50,
      expireHours: 2,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.shop.name, 'Test Café Two');
    assert.equal(res.data.shop.maxNumber, 50);
    assert.equal(res.data.shop.expireHours, 2);
    const order = await claimDynamic();
    assert.equal(order.message, 'بنعمل طلبك');
    assert.equal(order.shopName, 'Test Café Two');
  });

  test('changing the PIN keeps this session and signs out the others', async () => {
    const other = client(server.url);
    await other.post('/api/bar/login', { shopId: SHOP, pin: '1234' });
    assert.equal((await other.get(`/api/bar/${SHOP}/state`)).status, 200);

    const res = await settings({ currentPin: '1234', newPin: '24680' });
    assert.equal(res.status, 200);
    assert.equal((await bar.get(`/api/bar/${SHOP}/state`)).status, 200, 'current session re-issued');
    assert.equal((await other.get(`/api/bar/${SHOP}/state`)).status, 401, 'other sessions dropped');
    assert.equal((await other.post('/api/bar/login', { shopId: SHOP, pin: '1234' })).status, 401);
    assert.equal((await other.post('/api/bar/login', { shopId: SHOP, pin: '24680' })).status, 200);
  });
});

describe('logo upload', () => {
  const upload = (body, type) =>
    bar.request('POST', `/api/bar/${SHOP}/logo`, { body, headers: { 'content-type': type } });

  test('accepts PNG, serves it, and exposes it publicly', async () => {
    const res = await upload(PNG_1X1, 'image/png');
    assert.equal(res.status, 200);
    const { logoUrl } = res.data.shop;
    assert.match(logoUrl, /^\/media\/logos\/test-cafe-\d+\.png$/);
    const file = await fetch(server.url + logoUrl);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG_1X1);
    assert.equal((await api.get(`/api/shops/${SHOP}`)).data.logoUrl, logoUrl);
  });

  test('rejects SVG, spoofed content and oversize files', async () => {
    assert.equal((await upload('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml')).status, 415);
    assert.equal((await upload(Buffer.from('definitely not a png file'), 'image/png')).status, 400);
    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 0);
    PNG_1X1.copy(big);
    const status = await rawPost(`${server.url}/api/bar/${SHOP}/logo`, big, {
      'content-type': 'image/png',
      cookie: cookieHeader(bar),
    });
    assert.equal(status, 413);
    assert.equal((await api.request('POST', `/api/bar/${SHOP}/logo`, { body: PNG_1X1, headers: { 'content-type': 'image/png' } })).status, 401);
  });

  test('replacing and removing the logo', async () => {
    const first = (await api.get(`/api/shops/${SHOP}`)).data.logoUrl;
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
    const replaced = await upload(jpeg, 'image/jpeg');
    assert.match(replaced.data.shop.logoUrl, /\.jpg$/);
    assert.equal((await fetch(server.url + first)).status, 404, 'old file deleted');

    const removed = await bar.del(`/api/bar/${SHOP}/logo`);
    assert.equal(removed.status, 200);
    assert.equal(removed.data.shop.logoUrl, null);
    assert.equal((await fetch(server.url + replaced.data.shop.logoUrl)).status, 404);
  });
});

describe('subscribe', () => {
  const p256dh = crypto.createECDH('prime256v1').generateKeys().toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  const webpush = (endpoint, keys = { p256dh, auth }) => ({ endpoint, keys });

  test('validates web push subscriptions', async () => {
    const order = await claimDynamic();
    const sub = (payload) => api.post('/api/subscribe', { orderId: order.id, kind: 'webpush', payload });
    assert.equal((await sub(webpush('http://push.test.invalid/abc'))).status, 400, 'https only');
    assert.equal((await sub(webpush('https://evil.example.com/abc'))).status, 400, 'push host allow-list');
    assert.equal((await sub(webpush('not a url'))).status, 400);
    assert.equal((await sub(webpush('https://push.test.invalid/abc', { p256dh: 'short', auth }))).status, 400);
    assert.equal((await sub(webpush('https://push.test.invalid/abc', { p256dh, auth: 'x' }))).status, 400);
    assert.equal((await sub(webpush('https://push.test.invalid/abc'))).status, 200);
  });

  test('validates Live Activity tokens', async () => {
    const order = await claimDynamic();
    const sub = (payload) => api.post('/api/subscribe', { orderId: order.id, kind: 'live_activity', payload });
    assert.equal((await sub({ token: 'not-hex-zz' })).status, 400);
    assert.equal((await sub({ token: 'abcd' })).status, 400, 'too short');
    assert.equal((await sub({ token: crypto.randomBytes(40).toString('hex'), app: 'clip' })).status, 200);
    assert.equal((await api.post('/api/subscribe', { orderId: order.id, kind: 'sms', payload: {} })).status, 400);
  });

  test('rejects unknown and closed orders', async () => {
    assert.equal((await api.post('/api/subscribe', { orderId: 'nope-nope-nope-nope', kind: 'live_activity', payload: {} })).status, 404);
    const order = await claimDynamic();
    await bar.post(`/api/bar/${SHOP}/orders/${order.id}/status`, { status: 'cancelled' });
    const res = await api.post('/api/subscribe', {
      orderId: order.id,
      kind: 'live_activity',
      payload: { token: crypto.randomBytes(40).toString('hex') },
    });
    assert.equal(res.status, 409);
  });
});

describe('misc', () => {
  test('AASA is 404 without Apple env, pages strip the Apple placeholder', async () => {
    assert.equal((await api.get('/.well-known/apple-app-site-association')).status, 404);
    const page = await api.get(`/s/${SHOP}`);
    assert.equal(page.status, 200);
    assert.ok(!page.data.includes('APPLE_META'));
    assert.ok(!page.data.includes('apple-itunes-app'));
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  });

  test('VAPID key is generated and persisted', async () => {
    const res = await api.get('/api/vapid-key');
    assert.match(res.data.key, /^[A-Za-z0-9_-]{80,}$/);
  });

  test('raw HTML templates are not served directly', async () => {
    assert.equal((await api.get('/s.html')).status, 404);
  });

  test('order numbers skip numbers that are still open', async () => {
    const shop = 'wrap-cafe';
    await api.post('/api/admin/shops', { id: shop, name: 'Wrap', pin: '1111' }, { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const staff = client(server.url);
    await staff.post('/api/bar/login', { shopId: shop, pin: '1111' });
    await staff.post(`/api/bar/${shop}/settings`, { maxNumber: 10, qrMode: 'static' });
    const k = keyOf((await staff.get(`/api/bar/${shop}/state`)).data);
    const numbers = [];
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const o = (await api.post('/api/claim', { shopId: shop, k })).data;
      numbers.push(o.number);
      ids.push(o.id);
    }
    assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal((await api.post('/api/claim', { shopId: shop, k })).status, 503, 'all numbers open');
    await staff.post(`/api/bar/${shop}/orders/${ids[2]}/status`, { status: 'picked' });
    assert.equal((await api.post('/api/claim', { shopId: shop, k })).data.number, 3, 'wraps and reuses the freed number');
  });
});

describe('Apple env + timer rotation', () => {
  let apple;
  before(async () => {
    apple = await startServer({
      APPLE_TEAM_ID: 'TEAM123456',
      APPLE_APP_ID: '1234567890',
      NONCE_ROTATE_SECONDS: '5',
    });
  });
  after(async () => {
    await apple?.stop();
  });

  test('AASA lists the app and the App Clip; customer page gets the smart banner', async () => {
    const c = client(apple.url);
    const aasa = await c.get('/.well-known/apple-app-site-association');
    assert.equal(aasa.status, 200);
    assert.deepEqual(aasa.data.appclips.apps, ['TEAM123456.cc.aurexis.pager.Clip']);
    assert.deepEqual(aasa.data.applinks.details[0].appIDs, ['TEAM123456.cc.aurexis.pager']);
    const page = await c.get('/s/any-shop');
    assert.match(page.data, /<meta name="apple-itunes-app" content="app-id=1234567890, app-clip-bundle-id=cc.aurexis.pager.Clip, app-clip-display=card">/);
  });

  test('nonce rotates on a timer and the bar is told', async () => {
    const c = client(apple.url);
    await c.post('/api/admin/shops', { id: 'timer-cafe', name: 'Timer', pin: '1234' }, { headers: { 'x-admin-token': ADMIN_TOKEN } });
    await c.post('/api/bar/login', { shopId: 'timer-cafe', pin: '1234' });
    const before = (await c.get('/api/bar/timer-cafe/state')).data.qr.dynamicUrl;
    const stream = await sse(`${apple.url}/api/bar/timer-cafe/events`, { cookie: cookieHeader(c) });
    const ev = await stream.next('nonce', () => true, 9000);
    stream.close();
    assert.notEqual(ev.data.dynamicUrl, before);
    assert.equal(ev.data.rotateSeconds, 5);
  });
});

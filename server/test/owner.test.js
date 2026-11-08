import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { cleanEmail, cleanPhone } from '../src/contact.js';
import { client, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';

describe('owner contact: cleaning', () => {
  test('phone: Arabic digits, spaces and dashes as typed; empty is none', () => {
    assert.equal(cleanPhone('٠١٠ ١٢٣٤-٥٦٧٨'), '01012345678');
    assert.equal(cleanPhone('+20 (10) 1234 5678'), '+201012345678');
    assert.equal(cleanPhone('۰۱۰۱۲۳۴۵۶۷۸'), '01012345678');
    assert.equal(cleanPhone('  '), null);
    assert.equal(cleanPhone(null), null);
    for (const bad of ['123', 'call me', '0101234567890123', '01+0123456']) {
      assert.throws(() => cleanPhone(bad), (err) => err.status === 400 && err.extra.field === 'phone', bad);
    }
  });

  test('email: trimmed, checked, empty is none', () => {
    assert.equal(cleanEmail('  a@b.co '), 'a@b.co');
    assert.equal(cleanEmail(''), null);
    assert.throws(() => cleanEmail('not-an-email'), (err) => err.status === 400 && err.extra.field === 'email');
    assert.throws(() => cleanEmail(`${'a'.repeat(200)}@b.co`), (err) => err.status === 400);
  });
});

describe('owner contact: super and owner', () => {
  let server;
  let su;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
    await su.post('/api/super/brands', { id: 'phonebrand', name: 'Phone Brand' });
    await su.post('/api/super/brands/phonebrand/branches', { id: 'phonebrand-a', name: 'A', pin: '1234', qrMode: 'static' });
  });
  after(() => server?.stop());

  const ownerOf = async () => (await su.get('/api/super/overview')).data.brands.find((b) => b.id === 'phonebrand').owners[0];

  test('super: phone is optional at creation, checked, and shown with the email', async () => {
    const bad = await su.post('/api/super/brands/phonebrand/owners', { username: 'phone.owner', phone: '12' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.field, 'phone');
    assert.equal((await su.post('/api/super/brands/phonebrand/owners', { username: 'phone.owner', email: 'nope' })).status, 400);

    const created = await su.post('/api/super/brands/phonebrand/owners', {
      username: 'phone.owner', email: 'owner@example.com', phone: '٠١٠٠ ١٢٣ ٤٥٦٧', password: 'owner-pass-123',
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.owner.phone, '01001234567');
    const owner = await ownerOf();
    assert.equal(owner.email, 'owner@example.com');
    assert.equal(owner.phone, '01001234567');
  });

  test('super: edit changes email and phone without signing the owner out', async () => {
    const owner = client(server.url);
    await owner.post('/api/brand/login', { username: 'phone.owner', password: 'owner-pass-123' });
    const { id } = await ownerOf();
    const res = await su.post(`/api/super/brands/phonebrand/owners/${id}`, { username: 'phone.owner', email: '', phone: '+20 111 222 3333' });
    assert.equal(res.status, 200);
    const after = await ownerOf();
    assert.equal(after.email, null, 'empty clears it');
    assert.equal(after.phone, '+201112223333');
    assert.equal((await owner.get('/api/brand/phonebrand/overview')).status, 200, 'still signed in');
  });

  test('owner: sees and edits their own email and phone', async () => {
    const owner = client(server.url);
    await owner.post('/api/brand/login', { username: 'phone.owner', password: 'owner-pass-123' });
    const view = (await owner.get('/api/brand/phonebrand/overview')).data.owner;
    assert.deepEqual(view, { username: 'phone.owner', email: null, phone: '+201112223333' });

    const bad = await owner.post('/api/brand/phonebrand/account', { email: 'x@y.co', phone: 'abc' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.field, 'phone');
    assert.equal((await ownerOf()).email, null, 'nothing saved on an error');

    const saved = await owner.post('/api/brand/phonebrand/account', { email: 'me@cafe.co', phone: '' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.owner, { username: 'phone.owner', email: 'me@cafe.co', phone: null });
    assert.equal((await ownerOf()).email, 'me@cafe.co');

    assert.equal((await client(server.url).post('/api/brand/phonebrand/account', { email: 'a@b.co' })).status, 401, 'needs the owner session');
  });
});

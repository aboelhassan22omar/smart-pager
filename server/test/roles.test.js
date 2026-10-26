import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { openControl } from '../src/control.js';
import { DAY_MS, effectivePlan, featureFlags, planView } from '../src/plans.js';
import { seal, unseal } from '../src/vault.js';
import { ADMIN_TOKEN, client, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';
const day = (offsetDays) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
const nonceOf = (state) => new URL(state.qr.dynamicUrl).searchParams.get('n');

// ---------------------------------------------------------------------------
// Plan state machine (pure)
// ---------------------------------------------------------------------------

describe('plan state machine', () => {
  const now = Date.UTC(2026, 9, 21, 12);
  const at = (days) => now + days * DAY_MS;

  test('manual suspension wins over everything', () => {
    assert.equal(effectivePlan({ suspended_manual: 1, paid_until: at(30) }, now).status, 'suspended');
  });

  test('paid: active, then 3 days past_due, then suspended', () => {
    assert.equal(effectivePlan({ paid_until: at(5) }, now).status, 'active');
    assert.equal(effectivePlan({ paid_until: at(-1) }, now).status, 'past_due');
    assert.equal(effectivePlan({ paid_until: at(-2.9) }, now).status, 'past_due');
    assert.equal(effectivePlan({ paid_until: at(-3.1) }, now).status, 'suspended');
  });

  test('trial runs out into suspended unless paid', () => {
    assert.equal(effectivePlan({ trial_ends_at: at(1) }, now).status, 'trial');
    assert.equal(effectivePlan({ trial_ends_at: at(-1) }, now).status, 'suspended');
    assert.equal(effectivePlan({ trial_ends_at: at(-1), paid_until: at(10) }, now).status, 'active');
  });

  test('no dates (migrated from v1) is active without expiry', () => {
    const plan = planView({}, now);
    assert.equal(plan.status, 'active');
    assert.equal(plan.daysLeft, null);
  });

  test('days left round up', () => {
    assert.equal(planView({ trial_ends_at: at(2.2) }, now).daysLeft, 3);
    assert.equal(planView({ paid_until: at(-1) }, now).daysLeft, 2, 'past_due counts down to suspension');
  });

  test('a trashed branch is suspended whatever it paid', () => {
    assert.deepEqual(effectivePlan({ deleted_at: now, paid_until: at(30) }, now), { status: 'suspended', reason: 'deleted', until: null });
  });

  test('super can force a feature off over the owner toggle', () => {
    assert.deepEqual(featureFlags({ ff_review: 1, ff_loyalty: 1, ff_promo: 0, forced_off: '["loyalty"]' }),
      { review: true, loyalty: false, promo: false });
  });
});

describe('vault and automatic trash', () => {
  test('sealed values open with the same secret only', () => {
    const sealed = seal('secret-a', '4821');
    assert.notEqual(sealed, seal('secret-a', '4821'), 'random IV');
    assert.equal(unseal('secret-a', sealed), '4821');
    assert.equal(unseal('secret-b', sealed), null);
    assert.equal(unseal('secret-a', `${sealed.slice(0, -2)}xx`), null, 'tampered');
    assert.equal(unseal('secret-a', null), null);
  });

  test('a trial that ended unpaid moves to the trash; paid and live trials stay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-control-'));
    const control = openControl(path.join(dir, 'control.db'));
    try {
      control.createBrand({ id: 'tb', name: 'TB' });
      control.createBranch({ id: 'tb-over', brandId: 'tb', name: 'over', trialEndsAt: Date.now() - 1000 });
      control.createBranch({ id: 'tb-live', brandId: 'tb', name: 'live', trialEndsAt: Date.now() + DAY_MS });
      control.createBranch({ id: 'tb-paid', brandId: 'tb', name: 'paid', trialEndsAt: Date.now() - 1000 });
      control.recordPayment('tb-paid', { amountEgp: 1, periodStart: Date.now(), periodEnd: Date.now() + DAY_MS, actor: 'test' });

      assert.deepEqual(control.refreshPlanStatuses(), ['tb-over']);
      assert.equal(control.getBranch('tb-over').deleted_reason, 'trial_ended');
      assert.equal(control.getBranch('tb-live').deleted_at, null);
      assert.equal(control.getBranch('tb-paid').deleted_at, null);
      assert.deepEqual(control.refreshPlanStatuses(), [], 'only once');
      assert.equal(control.auditLog(5).filter((e) => e.action === 'branch.trash' && e.actor === 'system').length, 1);
    } finally {
      control.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Super, brand owners, plans, audit — against the real server
// ---------------------------------------------------------------------------

describe('super disabled without SUPER_PASSWORD_HASH', () => {
  test('/api/super is 404 and the login refuses', async () => {
    const server = await startServer();
    try {
      const c = client(server.url);
      assert.equal((await c.get('/api/super/overview')).status, 404);
      assert.equal((await c.post('/api/super/login', { password: 'anything' })).status, 404);
    } finally {
      await server.stop();
    }
  });
});

describe('roles and plans', () => {
  let server;
  let su; // super
  let anon;
  const owners = {};

  const superPost = (path, body) => su.post(`/api/super${path}`, body);

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    su = client(server.url);
    anon = client(server.url);
  });
  after(async () => {
    await server?.stop();
  });

  test('super login: wrong password 401, right one opens a 12h httpOnly session', async () => {
    assert.equal((await su.post('/api/super/login', { password: 'nope-nope' })).status, 401);
    const res = await su.post('/api/super/login', { password: SUPER_PASSWORD });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().join(';');
    assert.match(cookie, /sp_super=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Max-Age=43200/);
    assert.equal((await su.get('/api/super/overview')).status, 200);
  });

  test('super login is rate limited per IP', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await anon.post('/api/super/login', { password: 'x' }, { ip: '10.66.66.66' });
    assert.equal(last.status, 429);
  });

  test('super creates brands and branches; new branches start on a 3-day trial', async () => {
    for (const [id, name] of [['brandx', 'Brand X'], ['brandy', 'Brand Y']]) {
      assert.equal((await superPost('/brands', { id, name })).status, 201);
    }
    const res = await superPost('/brands/brandx/branches', { id: 'brandx-a', name: 'X A', area: 'A', pin: '1234' });
    assert.equal(res.status, 201);
    assert.match(res.data.urls.bar, /\/bar\/brandx-a$/);
    assert.equal((await superPost('/brands/brandy/branches', { id: 'brandy-b', name: 'Y B', pin: '1234' })).status, 201);
    assert.equal((await superPost('/brands/brandx/branches', { id: 'brandy-c', name: 'bad', pin: '1234' })).data.field, 'id');

    const overview = (await su.get('/api/super/overview')).data;
    const x = overview.brands.find((b) => b.id === 'brandx');
    assert.equal(x.branches[0].plan.status, 'trial');
    assert.equal(x.branches[0].plan.daysLeft, 3);
    assert.equal(x.branches[0].openNow, 0);
    assert.equal(x.branches[0].screens, 0);
  });

  test('super API refuses everyone else', async () => {
    const staff = client(server.url);
    await staff.post('/api/bar/login', { shopId: 'brandx-a', pin: '1234' });
    for (const c of [anon, staff]) {
      assert.equal((await c.get('/api/super/overview')).status, 401);
      assert.equal((await c.post('/api/super/brands', { id: 'evil', name: 'evil' })).status, 401);
    }
    const res = await su.request('POST', '/api/super/brands', { body: 'id=x', headers: { 'content-type': 'text/plain' } });
    assert.equal(res.status, 415, 'JSON only (CSRF)');
  });

  test('brand owner: created by super, sees only their own brand', async () => {
    const created = await superPost('/brands/brandx/owners', { username: 'owner.x', email: 'x@example.com' });
    assert.equal(created.status, 201);
    assert.ok(created.data.password.length >= 8, 'generated password returned once');
    assert.equal((await superPost('/brands/brandy/owners', { username: 'owner.y', password: 'owner-y-pass' })).status, 201);
    assert.equal((await superPost('/brands/brandy/owners', { username: 'owner.x' })).status, 409, 'username of another brand');

    owners.x = client(server.url);
    const login = await owners.x.post('/api/brand/login', { username: 'owner.x', password: created.data.password });
    assert.equal(login.status, 200);
    assert.equal(login.data.brandId, 'brandx');
    assert.equal((await owners.x.post('/api/brand/login', { username: 'owner.x', password: 'wrong-pass' })).status, 401);

    const mine = await owners.x.get('/api/brand/brandx/overview');
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.data.branches.map((b) => b.id), ['brandx-a']);

    // Cross-brand: X's owner session never opens brand Y, nor its branches.
    assert.equal((await owners.x.get('/api/brand/brandy/overview')).status, 401);
    assert.equal((await owners.x.post('/api/brand/brandy/branches/brandy-b/settings', { name: 'hijack' })).status, 401);
    assert.equal((await owners.x.post('/api/brand/brandx/branches/brandy-b/settings', { name: 'hijack' })).status, 404);
    assert.equal((await owners.x.get('/api/super/overview')).status, 401);
    assert.equal((await anon.get('/api/brand/brandx/overview')).status, 401);

    const renamed = await owners.x.post('/api/brand/brandx/branches/brandx-a/settings', { name: 'X Korba' });
    assert.equal(renamed.status, 200);
    assert.equal((await anon.get('/api/b/brandx-a')).data.name, 'X Korba');
  });

  test('resetting an owner password signs the old session out', async () => {
    const reset = await superPost('/brands/brandx/owners', { username: 'owner.x', password: 'brand-new-pass' });
    assert.equal(reset.status, 200);
    assert.equal((await owners.x.get('/api/brand/brandx/overview')).status, 401);
    assert.equal((await owners.x.post('/api/brand/login', { username: 'owner.x', password: 'brand-new-pass' })).status, 200);
    assert.equal((await owners.x.get('/api/brand/brandx/overview')).status, 200);
  });

  test('suspension: claims get 402, the bar shows it, resume restores', async () => {
    const staff = client(server.url);
    await staff.post('/api/bar/login', { shopId: 'brandx-a', pin: '1234' });
    const claim = async () => anon.post('/api/b/brandx-a/claim', { n: nonceOf((await staff.get('/api/bar/brandx-a/state')).data) });

    assert.equal((await claim()).status, 200);
    assert.equal((await superPost('/branches/brandx-a/suspend')).data.plan.status, 'suspended');
    const blocked = await claim();
    assert.equal(blocked.status, 402);
    assert.equal(blocked.data.error, 'الخدمة متوقفة مؤقتًا، اسأل الكاشير');
    assert.equal((await staff.get('/api/bar/brandx-a/state')).data.plan.status, 'suspended');
    assert.equal((await superPost('/branches/brandx-a/resume')).data.plan.status, 'trial');
    assert.equal((await claim()).status, 200);
  });

  test('payments: active while paid, past_due for 3 days after, then suspended', async () => {
    const pay = (periodStart, periodEnd) => superPost('/branches/brandy-b/payments', { amountEgp: 300, periodStart, periodEnd });
    assert.equal((await pay(day(-40), day(-10))).data.plan.status, 'suspended', 'ended 10 days ago');
    assert.equal((await anon.post('/api/b/brandy-b/claim', { n: 'x' })).status, 402);
    const late = await pay(day(-31), day(-2));
    assert.equal(late.data.plan.status, 'past_due');
    assert.equal((await pay(day(0), day(30))).data.plan.status, 'active');
    const res = await pay(day(-60), day(-30));
    assert.equal(res.data.plan.status, 'active', 'an older payment never moves paid_until back');
    assert.equal(res.data.payments.length, 4);
    assert.equal((await superPost('/branches/brandy-b/payments', { amountEgp: -5, periodStart: day(0), periodEnd: day(1) })).data.field, 'amountEgp');
    assert.equal((await superPost('/branches/brandy-b/payments', { amountEgp: 5, periodStart: 'soon', periodEnd: day(1) })).data.field, 'periodStart');
  });

  test('trial extension, PIN reset, rename, forced-off features', async () => {
    const before = (await su.get('/api/super/overview')).data.brands[0].branches[0].plan.daysLeft;
    assert.equal((await superPost('/branches/brandx-a/trial', { days: 7 })).data.plan.daysLeft, before + 7);
    assert.equal((await superPost('/branches/brandx-a/trial', { days: 0 })).status, 400);

    assert.equal((await superPost('/branches/brandx-a/pin', { pin: '9876' })).status, 200);
    const staff = client(server.url);
    assert.equal((await staff.post('/api/bar/login', { shopId: 'brandx-a', pin: '1234' })).status, 401);
    assert.equal((await staff.post('/api/bar/login', { shopId: 'brandx-a', pin: '9876' })).status, 200);

    assert.equal((await superPost('/branches/brandx-a/rename', { name: 'X Korba Mall' })).status, 200);
    assert.deepEqual((await superPost('/branches/brandx-a/features', { feature: 'loyalty', forcedOff: true })).data.forcedOff, ['loyalty']);
    assert.equal((await superPost('/branches/brandx-a/features', { feature: 'nope', forcedOff: true })).status, 400);
    const card = (await su.get('/api/super/overview')).data.brands[0].branches[0];
    assert.deepEqual(card.forcedOff, ['loyalty']);
    assert.equal(card.features.loyalty, false);
  });

  test('"open as branch" gives super a 1h staff session for that branch only', async () => {
    const res = await superPost('/branches/brandx-a/impersonate');
    assert.equal(res.status, 200);
    assert.match(res.headers.getSetCookie().join(';'), /sp_staff_brandx-a=.*Max-Age=3600/);
    assert.equal((await su.get('/api/bar/brandx-a/state')).status, 200);
    assert.equal((await su.get('/api/bar/brandy-b/state')).status, 401);
  });

  test('every action is in the audit log', async () => {
    const { entries } = (await su.get('/api/super/audit?limit=500')).data;
    const actions = new Set(entries.map((e) => e.action));
    for (const a of [
      'super.login', 'super.login_failed', 'brand.create', 'branch.create', 'owner.create', 'owner.reset', 'owner.login',
      'branch.rename', 'branch.suspend', 'branch.resume', 'branch.payment', 'branch.trial_extend', 'branch.pin_reset',
      'feature.force_off', 'branch.impersonate',
    ]) {
      assert.ok(actions.has(a), `missing audit action ${a}`);
    }
    const imp = entries.find((e) => e.action === 'branch.impersonate');
    assert.equal(imp.actor, 'super');
    assert.equal(imp.branch_id, 'brandx-a');
    assert.ok(entries.some((e) => e.action === 'branch.rename' && e.actor.startsWith('owner:')), 'owner actions too');
  });

  test('super reads the current staff PIN, also after the staff change it themselves', async () => {
    const pinOf = async (id) => (await su.get('/api/super/overview')).data.brands.flatMap((b) => b.branches).find((b) => b.id === id).pin;
    assert.equal(await pinOf('brandx-a'), '9876');
    assert.equal(await pinOf('brandy-b'), '1234');
    const staff = client(server.url);
    await staff.post('/api/bar/login', { shopId: 'brandy-b', pin: '1234' });
    assert.equal((await staff.post('/api/bar/brandy-b/settings', { currentPin: '1234', newPin: '24680' })).status, 200);
    assert.equal(await pinOf('brandy-b'), '24680');
    // Owners never get PINs; nothing sealed ends up in API shapes.
    const mine = (await owners.x.get('/api/brand/brandx/overview')).data;
    assert.ok(mine.branches.every((b) => !('pin' in b)));
    const raw = JSON.stringify((await su.get('/api/super/overview')).data);
    assert.ok(!/pin_hash|pin_sealed|password_sealed|scrypt\$/.test(raw));
  });

  test('super sees the owner login and edits username and password in place', async () => {
    const brandOf = async () => (await su.get('/api/super/overview')).data.brands.find((b) => b.id === 'brandx');
    let owner = (await brandOf()).owners[0];
    assert.equal(owner.password, 'brand-new-pass');
    assert.equal((await su.get('/api/super/overview')).data.publicUrl, server.url);

    // Username only: the owner stays signed in.
    assert.equal((await superPost(`/brands/brandx/owners/${owner.id}`, { username: 'owner.x2' })).status, 200);
    assert.equal((await owners.x.get('/api/brand/brandx/overview')).status, 200);
    assert.equal((await superPost(`/brands/brandx/owners/${owner.id}`, { username: 'owner.y' })).status, 409);
    assert.equal((await superPost(`/brands/brandy/owners/${owner.id}`, { username: 'zzz' })).status, 404, 'owner of another brand');
    assert.equal((await superPost(`/brands/brandx/owners/${owner.id}`, { password: 'short' })).data.field, 'password');

    // New password: old session out, new one works and shows up for the super.
    assert.equal((await superPost(`/brands/brandx/owners/${owner.id}`, { password: 'third-pass-123' })).status, 200);
    assert.equal((await owners.x.get('/api/brand/brandx/overview')).status, 401);
    assert.equal((await owners.x.post('/api/brand/login', { username: 'owner.x2', password: 'third-pass-123' })).status, 200);
    owner = (await brandOf()).owners[0];
    assert.deepEqual([owner.username, owner.password], ['owner.x2', 'third-pass-123']);
  });

  test('trash: a branch leaves the dashboards and stops claims until restored', async () => {
    await superPost('/brands/brandx/branches', { id: 'brandx-t', name: 'X Trash', pin: '1111' });
    const staff = client(server.url);
    await staff.post('/api/bar/login', { shopId: 'brandx-t', pin: '1111' });
    const claim = async () => anon.post('/api/b/brandx-t/claim', { n: nonceOf((await staff.get('/api/bar/brandx-t/state')).data) });

    assert.equal((await superPost('/branches/brandx-t/trash')).status, 200);
    const card = (await su.get('/api/super/overview')).data.brands.find((b) => b.id === 'brandx').branches.find((b) => b.id === 'brandx-t');
    assert.equal(card.deletedReason, 'manual');
    assert.ok(card.deletedAt);
    assert.equal(card.plan.reason, 'deleted');
    assert.ok(!(await owners.x.get('/api/brand/brandx/overview')).data.branches.some((b) => b.id === 'brandx-t'));
    assert.equal((await owners.x.post('/api/brand/brandx/branches/brandx-t/settings', { name: 'n' })).status, 404);
    assert.equal((await claim()).status, 402);

    assert.equal((await superPost('/branches/brandx-t/restore')).data.plan.status, 'trial');
    assert.equal((await claim()).status, 200);
    assert.ok((await owners.x.get('/api/brand/brandx/overview')).data.branches.some((b) => b.id === 'brandx-t'));
  });

  test('trash: a brand takes its branches and its owner login with it', async () => {
    assert.equal((await superPost('/brands/brandx/trash')).status, 200);
    const brand = (await su.get('/api/super/overview')).data.brands.find((b) => b.id === 'brandx');
    assert.ok(brand.deletedAt);
    assert.ok(brand.branches.every((b) => b.deletedReason === 'brand'));
    assert.equal((await owners.x.get('/api/brand/brandx/overview')).status, 401);
    const login = await client(server.url).post('/api/brand/login', { username: 'owner.x2', password: 'third-pass-123' });
    assert.equal(login.status, 403);
    assert.equal((await superPost('/branches/brandx-a/restore')).status, 409, 'restore the brand first');

    assert.equal((await superPost('/brands/brandx/restore')).status, 200);
    const back = (await su.get('/api/super/overview')).data.brands.find((b) => b.id === 'brandx');
    assert.equal(back.deletedAt, null);
    assert.ok(back.branches.every((b) => !b.deletedAt));
    assert.equal((await owners.x.post('/api/brand/login', { username: 'owner.x2', password: 'third-pass-123' })).status, 200);
  });

  test('admin API calls are audited as admin-token', async () => {
    await anon.post('/api/admin/shops', { id: 'admin-shop', name: 'Admin', pin: '1234' }, { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const { entries } = (await su.get('/api/super/audit?limit=5')).data;
    assert.ok(entries.some((e) => e.actor === 'admin-token' && e.branch_id === 'admin-shop'));
  });
});

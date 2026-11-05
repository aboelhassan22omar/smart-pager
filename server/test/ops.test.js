import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { CLOSED_AFTER_MS, mailScreenAlerts, screenAlert } from '../src/alerts.js';
import { hashPin } from '../src/auth.js';
import { createScreens } from '../src/bus.js';
import { hourStartIn, localSlot } from '../src/util.js';
import { client, startServer } from './helpers.js';

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const SUPER_PASSWORD = 'super-secret-pass';
let seq = 0;

// A branch with orders at this weekday-hour in `weeks` of the last 4 weeks.
function fakeBranch(id, { weeks, now }) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE hourly_stats (hour_start INTEGER PRIMARY KEY, orders INTEGER NOT NULL DEFAULT 0)');
  // Same local weekday and hour in earlier weeks (Egypt left summer time in between: a week
  // back is not always the same UTC hour).
  const local = localSlot('Africa/Cairo', now).hour;
  for (const w of weeks) {
    const guess = hourStartIn('Africa/Cairo', now - w * WEEK);
    const at = [guess, guess - HOUR, guess + HOUR].find((t) => localSlot('Africa/Cairo', t).hour === local);
    db.prepare('INSERT INTO hourly_stats VALUES (?, 3)').run(at);
  }
  return { branch: { id, name: id, brand_id: id }, store: { db, getShop: () => ({ id }) } };
}

function deps({ ctxs, closedSince }) {
  return {
    config: { tz: 'Africa/Cairo', publicUrl: 'https://pager.test', smtp: { host: 'smtp.test' }, alertEmail: 'me@test' },
    screens: { barClosedSince: (id) => closedSince[id] ?? null },
    tenants: { get: (id) => ctxs[id] },
    control: { listBranches: () => Object.values(ctxs).map((c) => c.branch) },
  };
}

describe('alert: cashier screen closed at a busy hour', () => {
  const now = Date.UTC(2026, 10, 5, 12, 10);

  test('busy hour + closed 20 minutes: alert; quiet hour, open screen or a short close: none', () => {
    const ctxs = {
      busy: fakeBranch('busy', { weeks: [1, 2, 3], now }),
      quiet: fakeBranch('quiet', { weeks: [1], now }),
      open: fakeBranch('open', { weeks: [1, 2, 3, 4], now }),
      brief: fakeBranch('brief', { weeks: [1, 2, 3], now }),
    };
    const d = deps({ ctxs, closedSince: { busy: now - 35 * 60_000, quiet: now - HOUR, brief: now - CLOSED_AFTER_MS + 60_000 } });
    assert.deepEqual(screenAlert(d, ctxs.busy.branch, now), { closedMinutes: 35 });
    assert.equal(screenAlert(d, ctxs.quiet.branch, now), null, 'orders this hour in 1 of 4 weeks only');
    assert.equal(screenAlert(d, ctxs.open.branch, now), null, 'a cashier screen is open');
    assert.equal(screenAlert(d, ctxs.brief.branch, now), null, 'closed for less than 20 minutes');
    assert.equal(screenAlert(d, { ...ctxs.busy.branch, deleted_at: now }, now), null, 'in the trash');
    assert.equal(screenAlert(d, { ...ctxs.busy.branch, suspended_manual: 1 }, now), null, 'stopped');
    assert.equal(screenAlert(d, { ...ctxs.busy.branch, id: 'demo' }, now), null, 'the demo café');
  });

  test('emails each alert once per branch per day, only with SMTP and ALERT_EMAIL', async () => {
    const ctxs = { mailme: fakeBranch('mailme', { weeks: [1, 2, 3], now }) };
    const d = deps({ ctxs, closedSince: { mailme: now - HOUR } });
    const sent = [];
    const send = async (_smtp, msg) => sent.push(msg);
    assert.equal(await mailScreenAlerts(d, { now, send }), 1);
    assert.equal(await mailScreenAlerts(d, { now: now + 600_000, send }), 0, 'not again the same day');
    assert.equal(sent[0].to, 'me@test');
    assert.match(sent[0].subject, /mailme/);
    assert.equal(await mailScreenAlerts({ ...d, config: { ...d.config, alertEmail: '' } }, { now, send }), 0);
  });

  test('screens remember when the last cashier screen closed', () => {
    const screens = createScreens();
    const atStart = screens.barClosedSince('b1');
    assert.ok(atStart <= Date.now(), 'nothing open since the server started');
    screens.add('b1', 'bar');
    screens.add('b1', 'qr');
    assert.equal(screens.barClosedSince('b1'), null);
    screens.remove('b1', 'bar');
    assert.ok(screens.barClosedSince('b1') >= atStart, 'a QR screen alone does not count');
  });
});

describe('ops on a running server', () => {
  let server;
  let su;

  before(async () => {
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD) });
    su = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
  });
  after(() => server?.stop());

  test('a + or − sent again with the same request id (lost reply, offline queue) counts once', async () => {
    const id = `ops${++seq}`;
    await su.post('/api/super/brands', { id, name: id });
    await su.post(`/api/super/brands/${id}/branches`, { id, name: id, pin: '1234', qrMode: 'static' });
    const bar = client(server.url);
    await bar.post('/api/bar/login', { shopId: id, pin: '1234' });
    const step = (delta, rid) => bar.post(`/api/bar/${id}/counter`, { delta }, rid ? { headers: { 'x-request-id': rid } } : {});
    assert.equal((await step(1, 'queued-tap-0001')).data.next, 2);
    assert.equal((await step(1, 'queued-tap-0001')).data.next, 2, 'the repeat changes nothing');
    assert.equal((await step(1, 'queued-tap-0002')).data.next, 3);
    assert.equal((await step(1)).data.next, 4, 'without an id every tap counts');
    assert.equal((await step(1, 'bad id!')).data.next, 5, 'a malformed id is ignored, not trusted');
  });

  test('dashboards carry the screen alert field', async () => {
    const overview = (await su.get('/api/super/overview')).data;
    const branch = overview.brands.flatMap((b) => b.branches)[0];
    assert.ok('screenAlert' in branch);
    assert.equal(branch.screenAlert, null, 'a new branch has no usual hours yet');
  });
});

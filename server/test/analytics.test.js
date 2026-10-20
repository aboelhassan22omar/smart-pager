import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { analyticsCsv, brandAnalytics } from '../src/aggregate.js';
import { openStorage } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { sendMail } from '../src/mail.js';
import { provisionBrand, provisionBranch } from '../src/provision.js';
import { median, orderTimes, rollupBranch, summarize } from '../src/rollups.js';
import { runWeeklySummaries, weekKey } from '../src/summary.js';
import { dayIn, hourStartIn } from '../src/util.js';
import { ADMIN_TOKEN, client, startServer } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = 'Africa/Cairo';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

describe('rollup math', () => {
  test('median', () => {
    assert.equal(median([]), null);
    assert.equal(median([5]), 5);
    assert.equal(median([9, 1, 5]), 5);
    assert.equal(median([1, 2, 3, 10]), 3); // (2 + 3) / 2 rounded
  });

  test('prep, pickup wait and late per order', () => {
    const t0 = 1_000_000;
    const lateMs = 10 * MIN;
    assert.deepEqual(orderTimes({ created_at: t0, ready_at: t0 + 4 * MIN, closed_at: t0 + 6 * MIN, status: 'picked' }, lateMs, t0),
      { prep: 240, wait: 120, late: false });
    assert.equal(orderTimes({ created_at: t0, ready_at: t0 + 11 * MIN, status: 'ready' }, lateMs, t0).late, true);
    assert.equal(orderTimes({ created_at: t0, status: 'preparing' }, lateMs, t0 + 12 * MIN).late, true, 'still open past the threshold');
    assert.equal(orderTimes({ created_at: t0, status: 'preparing' }, lateMs, t0 + 3 * MIN).late, false);
  });

  test('cancelled orders never count as late', () => {
    const t0 = 0;
    const s = summarize([{ created_at: t0, closed_at: t0 + 30 * MIN, status: 'cancelled' }], 10 * MIN, t0 + HOUR);
    assert.equal(s.cancelled, 1);
    assert.equal(s.late, 0);
  });
});

describe('analytics over branch databases', () => {
  let dir;
  let deps;
  const now = Date.UTC(2026, 9, 21, 12, 0); // Wed 15:00 Cairo
  const insertOrder = (db, o) => db.prepare(`INSERT INTO orders (id, number, status, created_at, ready_at, closed_at)
                                             VALUES (?, ?, ?, ?, ?, ?)`).run(o.id, o.number ?? 1, o.status, o.created_at, o.ready_at ?? null, o.closed_at ?? null);

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-analytics-'));
    const config = loadConfig({ DATA_DIR: dir, TZ });
    const storage = openStorage(config, quiet);
    deps = { config, ...storage, screens: { count: () => 0 }, log: quiet };
    provisionBrand(deps, { id: 'cafex', name: 'Cafe X' });
    await provisionBranch(deps, { brandId: 'cafex', id: 'cafex-a', name: 'A', pin: '1234' });
    await provisionBranch(deps, { brandId: 'cafex', id: 'cafex-b', name: '=HYPERLINK("x")', pin: '1234' });

    const a = deps.tenants.get('cafex-a').store.db;
    const b = deps.tenants.get('cafex-b').store.db;
    const yesterday = now - DAY;
    // A, yesterday 13:xx Cairo: 3 picked (prep 4, 6, 15 min; wait 1, 2, 3 min) + 1 cancelled
    insertOrder(a, { id: 'a-1', status: 'picked', created_at: yesterday, ready_at: yesterday + 4 * MIN, closed_at: yesterday + 5 * MIN });
    insertOrder(a, { id: 'a-2', status: 'picked', created_at: yesterday + MIN, ready_at: yesterday + 7 * MIN, closed_at: yesterday + 9 * MIN });
    insertOrder(a, { id: 'a-3', status: 'picked', created_at: yesterday + 2 * MIN, ready_at: yesterday + 17 * MIN, closed_at: yesterday + 20 * MIN });
    insertOrder(a, { id: 'a-4', status: 'cancelled', created_at: yesterday + 3 * MIN, closed_at: yesterday + 4 * MIN });
    // B, today: one late expired order
    insertOrder(b, { id: 'b-1', status: 'expired', created_at: now - 4 * HOUR, closed_at: now - HOUR });
  });

  after(() => {
    deps.tenants.closeAll();
    deps.control.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('hourly rollups are exact and land in the local hour', () => {
    const store = deps.tenants.get('cafex-a').store;
    rollupBranch(store, { tz: TZ, now });
    const rows = store.db.prepare('SELECT * FROM hourly_stats').all();
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.hour_start, hourStartIn(TZ, now - DAY));
    assert.deepEqual(
      [r.orders, r.picked, r.cancelled, r.late, r.prep_count, r.prep_median_s, r.wait_median_s],
      [4, 3, 1, 1, 3, 360, 120],
    );
  });

  test('brand report: totals, medians, late %, days and heatmap', () => {
    const report = brandAnalytics(deps, 'cafex', { from: dayIn(TZ, new Date(now - DAY)), to: dayIn(TZ, new Date(now)), now });
    assert.equal(report.exact, true);
    assert.equal(report.total.orders, 5);
    assert.equal(report.total.late, 2, '15-minute prep + expired order');
    assert.equal(report.total.latePct, 40);
    assert.equal(report.total.prepMedianS, 360);
    assert.equal(report.total.waitMedianS, 120);
    assert.deepEqual(report.daily.map((d) => d.orders), [4, 1]);
    assert.equal(report.heatmap.flat().reduce((x, y) => x + y, 0), 5);
    assert.equal(report.heatmap[2][15], 4, 'Tuesday 15:00 Cairo (UTC+3)');
    assert.equal(report.branches.length, 2);

    const one = brandAnalytics(deps, 'cafex', { from: dayIn(TZ, new Date(now - DAY)), to: dayIn(TZ, new Date(now)), branchId: 'cafex-b', now });
    assert.deepEqual(one.branches.map((b) => b.id), ['cafex-b']);
    assert.equal(one.total.orders, 1);
  });

  test('ranges older than 90 days fall back to (flagged) approximate medians', () => {
    const report = brandAnalytics(deps, 'cafex', { from: dayIn(TZ, new Date(now - 120 * DAY)), to: dayIn(TZ, new Date(now)), now });
    assert.equal(report.exact, false);
    assert.equal(report.total.orders, 5);
    assert.ok(report.total.prepMedianS > 0);
  });

  test('CSV: one row per branch per day, BOM for Excel, formulas neutralised', () => {
    const report = brandAnalytics(deps, 'cafex', { from: dayIn(TZ, new Date(now - DAY)), to: dayIn(TZ, new Date(now)), now });
    const csv = analyticsCsv(report);
    assert.ok(csv.startsWith('﻿date,branch_id,branch_name,orders'));
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 1 + 2 * 2);
    assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""x"")"`)), 'a name starting with = is prefixed with a quote');
  });

  test('retention: closed orders kept 90 days, subscriptions dropped 24h after close', () => {
    const store = deps.tenants.get('cafex-a').store;
    insertOrder(store.db, { id: 'old-order-zzzzzzzzz', status: 'picked', created_at: now - 100 * DAY, closed_at: now - 91 * DAY });
    insertOrder(store.db, { id: 'week-old-yyyyyyyyy', status: 'picked', created_at: now - 8 * DAY, closed_at: now - 7 * DAY });
    store.addSubscription('week-old-yyyyyyyyy', 'live_activity', { token: 'ab', app: 'clip' });
    store.addSubscription('a-1', 'live_activity', { token: 'cd', app: 'clip' });
    const purged = store.purgeClosed(now);
    assert.deepEqual(purged, { orders: 1, subscriptions: 1 });
    assert.ok(store.getOrder('week-old-yyyyyyyyy'), 'kept for analytics');
    assert.equal(store.countSubscriptions('a-1'), 1, 'order closed < 24h ago keeps its subscription');
    assert.equal(store.getOrder('old-order-zzzzzzzzz'), undefined);
  });

  test('weekly summary: off without SMTP; once a week on Monday 09:00 with SMTP', async () => {
    assert.equal(await runWeeklySummaries(deps, { now }), 0, 'no SMTP_HOST -> nothing');
    deps.control.createOwner({ brandId: 'cafex', username: 'owner.x', email: 'owner@example.com', passwordHash: 'x' });
    const sent = [];
    const send = async (_cfg, msg) => sent.push(msg);
    const smtpDeps = { ...deps, config: { ...deps.config, smtp: { ...deps.config.smtp, host: 'smtp.test' } } };
    const monday9 = Date.UTC(2026, 9, 26, 6, 30); // Mon 09:30 Cairo
    assert.equal(await runWeeklySummaries(smtpDeps, { now: monday9 - DAY, send }), 0, 'not Monday');
    assert.equal(await runWeeklySummaries(smtpDeps, { now: monday9, send }), 1);
    assert.equal(await runWeeklySummaries(smtpDeps, { now: monday9 + HOUR, send }), 0, 'once per week');
    assert.deepEqual(sent[0].to, ['owner@example.com']);
    assert.match(sent[0].text, /ملخص الأسبوع: Cafe X/);
    assert.equal(weekKey(TZ, monday9 + 3 * DAY), weekKey(TZ, monday9));
  });
});

describe('SMTP client', () => {
  test('speaks EHLO / AUTH PLAIN / MAIL / RCPT / DATA and base64-encodes UTF-8', async () => {
    const seen = [];
    let data = '';
    const server = net.createServer((sock) => {
      let inData = false;
      let buf = '';
      sock.write('220 fake ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              sock.write('250 queued\r\n');
            } else data += `${line}\n`;
            continue;
          }
          seen.push(line.split(' ')[0]);
          if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
          else if (line.startsWith('AUTH')) sock.write(line.endsWith(Buffer.from('\0u\0p').toString('base64')) ? '235 ok\r\n' : '535 no\r\n');
          else if (line.startsWith('MAIL') || line.startsWith('RCPT')) sock.write('250 ok\r\n');
          else if (line === 'DATA') {
            inData = true;
            sock.write('354 go\r\n');
          } else if (line === 'QUIT') sock.end('221 bye\r\n');
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await sendMail(
        { host: '127.0.0.1', port: server.address().port, tls: 'none', user: 'u', pass: 'p', from: 'Pager <no-reply@x.test>' },
        { to: ['a@x.test'], subject: 'ملخص\r\nBcc: evil@x.test', text: 'أهلاً\n.\nسطر' },
      );
      assert.deepEqual(seen, ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
      assert.match(data, /Subject: =\?UTF-8\?B\?/);
      assert.doesNotMatch(data, /^Bcc:/m, 'no header injection');
      const body = data.split('\n\n')[1].replace(/\n/g, '');
      assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'أهلاً\r\n.\r\nسطر');
    } finally {
      server.close();
    }
  });
});

describe('analytics + late threshold over HTTP', () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server?.stop();
  });

  test('owner analytics: own brand only, validated range, CSV download; staff sets the late threshold', async () => {
    const admin = client(server.url);
    const h = { headers: { 'x-admin-token': ADMIN_TOKEN } };
    await admin.post('/api/admin/brands', { id: 'brandq', name: 'Q' }, h);
    await admin.post('/api/admin/branches', { brandId: 'brandq', id: 'brandq-a', name: 'Q A', pin: '1234' }, h);
    await admin.post('/api/admin/shops', { id: 'other-shop', name: 'Other', pin: '1234' }, h);

    // Owner accounts are created through the CLI path here (no super in this server).
    const { openStorage: open } = await import('../src/bootstrap.js');
    const { hashPin } = await import('../src/auth.js');
    const storage = open(loadConfig({ DATA_DIR: server.dataDir }), quiet);
    storage.control.createOwner({ brandId: 'brandq', username: 'owner.q', passwordHash: await hashPin('owner-pass-q') });
    storage.tenants.closeAll();
    storage.control.close();

    const owner = client(server.url);
    assert.equal((await owner.post('/api/brand/login', { username: 'owner.q', password: 'owner-pass-q' })).status, 200);
    const today = new Date().toISOString().slice(0, 10);
    const q = `from=${today}&to=${today}`;
    const ok = await owner.get(`/api/brand/brandq/analytics?${q}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.branches[0].id, 'brandq-a');
    assert.equal((await owner.get(`/api/brand/brandq/analytics?${q}&branch=other-shop`)).status, 404, 'branch of another brand');
    assert.equal((await owner.get(`/api/brand/other-shop/analytics?${q}`)).status, 401);
    assert.equal((await owner.get('/api/brand/brandq/analytics?from=2026-13-01&to=2026-01-01')).status, 400);
    assert.equal((await owner.get('/api/brand/brandq/analytics?from=2026-02-01&to=2026-01-01')).status, 400);
    assert.equal((await owner.get('/api/brand/brandq/analytics?from=2024-01-01&to=2026-01-01')).status, 400, 'over a year');

    const csv = await owner.get(`/api/brand/brandq/analytics.csv?${q}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="brandq-/);
    assert.ok(csv.data.includes('date,branch_id,branch_name'));

    const staff = client(server.url);
    await staff.post('/api/bar/login', { shopId: 'brandq-a', pin: '1234' });
    assert.equal((await staff.post('/api/bar/brandq-a/settings', { lateAfterMinutes: 0 })).data.field, 'lateAfterMinutes');
    const saved = await staff.post('/api/bar/brandq-a/settings', { lateAfterMinutes: 7 });
    assert.equal(saved.data.shop.lateAfterMinutes, 7);
  });
});

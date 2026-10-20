import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { backupDue, backupStatus, KEEP_DAYS, pruneBackups, runBackup } from '../src/backup.js';
import { openStorage } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { provisionBrand, provisionBranch } from '../src/provision.js';
import { objectPath, putObject, signV4 } from '../src/s3.js';
import { client, PNG_1X1, startServer } from './helpers.js';

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `pager-${name}-`));

describe('S3 SigV4 signing', () => {
  test('matches the AWS SigV4 test suite (get-vanilla)', () => {
    const auth = signV4({
      method: 'GET', path: '/', payloadHash: EMPTY_SHA, region: 'us-east-1', service: 'service',
      headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    });
    assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
      + 'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  test('matches the S3 documentation example (GET Object)', () => {
    const auth = signV4({
      method: 'GET', path: '/test.txt', payloadHash: EMPTY_SHA, region: 'us-east-1', service: 's3',
      headers: {
        Host: 'examplebucket.s3.amazonaws.com', Range: 'bytes=0-9',
        'x-amz-content-sha256': EMPTY_SHA, 'x-amz-date': '20130524T000000Z',
      },
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    assert.match(auth, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, /);
    assert.match(auth, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  });

  test('object keys are encoded per segment, slashes kept', () => {
    assert.equal(objectPath('bkt', 'smart-pager/2026-10-21/tenants/a b/pager.db'), '/bkt/smart-pager/2026-10-21/tenants/a%20b/pager.db');
  });

  test('putObject sends a path-style signed PUT with the body hash', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return new Response('', { status: 200 });
    };
    const s3 = { endpoint: 'https://s3.example.com', bucket: 'bkt', region: 'eu-1', accessKeyId: 'AK', secretAccessKey: 'SK' };
    const body = Buffer.from('hello');
    await putObject(s3, 'p/x.db', body, { fetchImpl, now: new Date(Date.UTC(2026, 9, 21)) });
    assert.equal(seen.url, 'https://s3.example.com/bkt/p/x.db');
    assert.equal(seen.init.method, 'PUT');
    assert.equal(seen.init.headers['x-amz-content-sha256'], crypto.createHash('sha256').update(body).digest('hex'));
    assert.match(seen.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AK\/20261021\/eu-1\/s3\/aws4_request, /);
  });

  test('S3 stays off unless all five settings are present', () => {
    assert.equal(loadConfig({ BACKUP_S3_BUCKET: 'b' }).backupS3, null);
    const full = loadConfig({
      BACKUP_S3_ENDPOINT: 'https://e', BACKUP_S3_BUCKET: 'b', BACKUP_S3_REGION: 'r',
      BACKUP_S3_ACCESS_KEY_ID: 'a', BACKUP_S3_SECRET_ACCESS_KEY: 's',
    }).backupS3;
    assert.equal(full.prefix, 'smart-pager/');
  });
});

describe('backup schedule and retention', () => {
  test(`keeps ${KEEP_DAYS} day folders and leaves pre-migrate copies alone`, () => {
    const dir = tmp('prune');
    try {
      const config = { dataDir: dir };
      const days = Array.from({ length: 10 }, (_, i) => `2026-10-${String(12 + i).padStart(2, '0')}`);
      for (const d of [...days, 'pre-migrate-x']) fs.mkdirSync(path.join(dir, 'backups', d), { recursive: true });
      const removed = pruneBackups(config, '2026-10-21');
      assert.deepEqual(removed.sort(), ['2026-10-12', '2026-10-13', '2026-10-14']);
      assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter((d) => /^\d{4}/.test(d)).length, KEEP_DAYS);
      assert.ok(fs.existsSync(path.join(dir, 'backups', 'pre-migrate-x')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('due once a day at or after 03:30 local time', () => {
    const dir = tmp('due');
    try {
      const config = { dataDir: dir, tz: 'Africa/Cairo' };
      const at = (h, m) => Date.UTC(2026, 9, 21, h - 3, m); // Cairo is UTC+3 in October 2026
      assert.equal(backupDue(config, at(3, 29)), false);
      assert.equal(backupDue(config, at(3, 30)), true);
      fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'backups', 'status.json'), JSON.stringify({ day: '2026-10-21', ok: true }));
      assert.equal(backupDue(config, at(10, 0)), false, 'already done today');
      assert.equal(backupDue(config, at(10, 0) + 86_400_000), true, 'next day');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('off-site upload', () => {
  test('uploads the day folder to S3, never secrets.json', async () => {
    const puts = [];
    const fake = http.createServer((req, res) => {
      let size = 0;
      req.on('data', (d) => (size += d.length));
      req.on('end', () => {
        puts.push({ method: req.method, url: req.url, auth: req.headers.authorization, size });
        res.end();
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const dir = tmp('s3');
    const config = loadConfig({
      DATA_DIR: dir,
      BACKUP_S3_ENDPOINT: `http://127.0.0.1:${fake.address().port}`, BACKUP_S3_BUCKET: 'bkt', BACKUP_S3_REGION: 'auto',
      BACKUP_S3_ACCESS_KEY_ID: 'AK', BACKUP_S3_SECRET_ACCESS_KEY: 'SK', BACKUP_S3_PREFIX: 'pager',
    });
    const { control, tenants } = openStorage(config, quiet);
    try {
      const deps = { config, control, tenants };
      provisionBrand(deps, { id: 'upl', name: 'Up' });
      await provisionBranch(deps, { brandId: 'upl', id: 'upl-a', name: 'A', pin: '1234' });
      fs.writeFileSync(path.join(dir, 'secrets.json'), '{"cookieSecret":"x"}');
      const status = await runBackup({ ...deps, log: quiet });
      assert.equal(status.ok, true, status.errors.join());
      assert.equal(status.offsite.ok, true);
      const urls = puts.map((p) => p.url);
      assert.ok(urls.includes(`/bkt/pager/${status.day}/control.db`));
      assert.ok(urls.includes(`/bkt/pager/${status.day}/tenants/upl/upl-a/pager.db`));
      assert.ok(!urls.some((u) => u.includes('secrets')), 'secrets.json stays on the server');
      assert.ok(puts.every((p) => p.method === 'PUT' && p.auth.startsWith('AWS4-HMAC-SHA256 ')));
      assert.ok(fs.existsSync(path.join(dir, 'backups', status.day, 'secrets.json')), 'but it is in the local copy');
    } finally {
      tenants.closeAll();
      control.close();
      fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backup -> restore -> boot', () => {
  test('a restored backup boots with the same branches, orders, PINs and media', async () => {
    const SUPER = 'backup-super-pass';
    const server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER) });
    let restored;
    const restoreDir = tmp('restore');
    try {
      const su = client(server.url);
      await su.post('/api/super/login', { password: SUPER });
      await su.post('/api/super/brands', { id: 'bak', name: 'Backup Brand' });
      await su.post('/api/super/brands/bak/branches', { id: 'bak-a', name: 'Backup A', pin: '4321' });
      const staff = client(server.url);
      await staff.post('/api/bar/login', { shopId: 'bak-a', pin: '4321' });
      const logo = await staff.request('POST', '/api/bar/bak-a/logo', { body: PNG_1X1, headers: { 'content-type': 'image/png' } });
      const state = (await staff.get('/api/bar/bak-a/state')).data;
      const n = new URL(state.qr.dynamicUrl).searchParams.get('n');
      const order = (await client(server.url).post('/api/b/bak-a/claim', { n })).data;

      assert.equal((await client(server.url).post('/api/super/backup', {})).status, 401, 'super only');
      const res = await su.post('/api/super/backup', {});
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true, (res.data.errors ?? []).join());
      assert.equal(res.data.branches, 1);
      assert.equal(res.data.offsite, null, 'S3 off by default');
      assert.equal((await su.get('/api/super/overview')).data.backup.day, res.data.day);

      // Runbook: stop the app, copy a day folder over /data, start the app.
      const dayDir = path.join(server.dataDir, 'backups', res.data.day);
      for (const f of ['control.db', 'secrets.json', 'tenants/bak/bak-a/pager.db']) {
        assert.ok(fs.existsSync(path.join(dayDir, f)), f);
      }
      fs.cpSync(dayDir, restoreDir, { recursive: true });
      assert.equal(backupStatus({ dataDir: restoreDir }), null);
      restored = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER) }, { dataDir: restoreDir });

      const again = client(restored.url);
      assert.equal((await again.post('/api/bar/login', { shopId: 'bak-a', pin: '4321' })).status, 200, 'same PIN');
      const back = (await again.get('/api/bar/bak-a/state')).data;
      assert.equal(back.shop.name, 'Backup A');
      assert.deepEqual(back.orders.map((o) => o.number), [order.number]);
      assert.equal((await client(restored.url).get(`/api/b/bak-a/orders/${order.id}`)).data.status, 'preparing');
      const media = await fetch(restored.url + logo.data.shop.logoUrl);
      assert.equal(media.status, 200);
      assert.deepEqual(Buffer.from(await media.arrayBuffer()), PNG_1X1);
    } finally {
      await server.stop();
      if (restored) await restored.stop();
      else fs.rmSync(restoreDir, { recursive: true, force: true });
    }
  });
});

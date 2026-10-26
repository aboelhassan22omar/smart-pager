import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { hashPin } from '../src/auth.js';
import { arscStrings, buildApk, LABEL_PLACEHOLDER, replaceArscString, signV2 } from '../src/native/apk.js';
import { MARKER, patchExeConfig, pngToIco } from '../src/native/exe.js';
import { selfSignedCert } from '../src/native/x509.js';
import { findEocd, readZip, writeZip } from '../src/native/zip.js';
import { client, sse, startServer } from './helpers.js';

const SUPER_PASSWORD = 'super-secret-pass';

// ---------------------------------------------------------------------------
// Fixtures: a resources.arsc, a template apk and a template exe shaped like the real ones
// (the real ones are checked with Google's apksigner/aapt2 in CI, see .github/workflows/ci.yml).
// ---------------------------------------------------------------------------

function utf8Pool(strings) {
  const enc = strings.map((s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from([s.length, b.length]), b, Buffer.from([0])]);
  });
  const offsets = Buffer.alloc(strings.length * 4);
  let at = 0;
  enc.forEach((e, i) => {
    offsets.writeUInt32LE(at, i * 4);
    at += e.length;
  });
  let data = Buffer.concat(enc);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const head = Buffer.alloc(28);
  head.writeUInt16LE(0x0001, 0);
  head.writeUInt16LE(28, 2);
  head.writeUInt32LE(28 + offsets.length + data.length, 4);
  head.writeUInt32LE(strings.length, 8);
  head.writeUInt32LE(1 << 8, 16); // UTF-8
  head.writeUInt32LE(28 + offsets.length, 20);
  return Buffer.concat([head, offsets, data]);
}

function fakeArsc(strings) {
  const pool = utf8Pool(strings);
  const pkg = Buffer.from('fake package chunk......', 'ascii');
  const head = Buffer.alloc(12);
  head.writeUInt16LE(0x0002, 0);
  head.writeUInt16LE(12, 2);
  head.writeUInt32LE(12 + pool.length + pkg.length, 4);
  head.writeUInt32LE(1, 8);
  return Buffer.concat([head, pool, pkg]);
}

function png(size, rgb = [200, 180, 150]) {
  const crc = (b) => zlib.crc32(b);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TEMPLATE_ICON = png(8, [30, 31, 33]);

function templateApk() {
  return writeZip([
    { name: 'AndroidManifest.xml', data: Buffer.from('<binary manifest>'), method: 8 },
    { name: 'res/drawable-nodpi-v4/app_icon.png', data: TEMPLATE_ICON, method: 0 },
    { name: 'res/mipmap-nodpi-v4/ic_launcher.png', data: TEMPLATE_ICON, method: 0 },
    { name: 'resources.arsc', data: fakeArsc(['res/x.xml', LABEL_PLACEHOLDER, 'other']), method: 0 },
    { name: 'classes.dex', data: crypto.randomBytes(3000), method: 8 },
    { name: 'META-INF/OLD.SF', data: Buffer.from('stale signature'), method: 8 },
  ]);
}

function templateExe() {
  const region = Buffer.alloc(1024, 0x20);
  MARKER.copy(region);
  return Buffer.concat([Buffer.from('MZ fake exe head '), crypto.randomBytes(500), region, crypto.randomBytes(300)]);
}

// ---------------------------------------------------------------------------
// APK Signature Scheme v2 verifier (independent of the signer's helpers)
// ---------------------------------------------------------------------------

function verifyV2(apk) {
  const eocd = findEocd(apk);
  assert.equal(apk.toString('ascii', eocd.cdOffset - 16, eocd.cdOffset), 'APK Sig Block 42');
  const size = Number(apk.readBigUInt64LE(eocd.cdOffset - 24));
  const blockStart = eocd.cdOffset - size - 8;
  assert.equal(Number(apk.readBigUInt64LE(blockStart)), size);
  let p = blockStart + 8;
  let value = null;
  while (p < eocd.cdOffset - 24) {
    const len = Number(apk.readBigUInt64LE(p));
    if (apk.readUInt32LE(p + 8) === 0x7109871a) value = apk.subarray(p + 12, p + 8 + len);
    p += 8 + len;
  }
  assert.ok(value, 'v2 block present');
  const lp = (buf, at) => [buf.subarray(at + 4, at + 4 + buf.readUInt32LE(at)), at + 4 + buf.readUInt32LE(at)];
  const [signers] = lp(value, 0);
  const [signer] = lp(signers, 0);
  const [signedData, afterSd] = lp(signer, 0);
  const [signatures, afterSigs] = lp(signer, afterSd);
  const [spki] = lp(signer, afterSigs);
  const [sigEntry] = lp(signatures, 0);
  assert.equal(sigEntry.readUInt32LE(0), 0x0103);
  const [signature] = lp(sigEntry, 4);
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.ok(crypto.verify('sha256', signedData, key, signature), 'signature over signed data');

  const [digests, afterDigests] = lp(signedData, 0);
  const [certs] = lp(signedData, afterDigests);
  const [digestEntry] = lp(digests, 0);
  const [digest] = lp(digestEntry, 4);
  const [cert] = lp(certs, 0);
  assert.ok(new crypto.X509Certificate(cert).verify(key), 'certificate carries the signing key');

  const end = Buffer.from(apk.subarray(eocd.offset));
  end.writeUInt32LE(blockStart, 16);
  const chunks = [];
  for (const section of [apk.subarray(0, blockStart), apk.subarray(eocd.cdOffset, eocd.offset), end]) {
    for (let at = 0; at < section.length; at += 1 << 20) {
      const c = section.subarray(at, Math.min(section.length, at + (1 << 20)));
      const n = Buffer.alloc(4);
      n.writeUInt32LE(c.length);
      chunks.push(crypto.createHash('sha256').update(Buffer.from([0xa5])).update(n).update(c).digest());
    }
  }
  const count = Buffer.alloc(4);
  count.writeUInt32LE(chunks.length);
  const top = crypto.createHash('sha256').update(Buffer.from([0x5a])).update(count).update(Buffer.concat(chunks)).digest();
  assert.deepEqual(top, digest, 'content digest');
  return { cert };
}

function storedDataOffset(zip, name) {
  const { cdOffset } = findEocd(zip);
  let p = cdOffset;
  for (;;) {
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    if (zip.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      return local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    }
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
}

// ---------------------------------------------------------------------------

describe('app packaging', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certDer = selfSignedCert({ privateKey, publicKey, commonName: 'Cashier App' });

  test('self-signed certificate parses and verifies, valid for 50 years', () => {
    const cert = new crypto.X509Certificate(certDer);
    assert.ok(cert.verify(publicKey));
    assert.match(cert.subject, /CN=Cashier App/);
    assert.ok(new Date(cert.validTo).getUTCFullYear() >= new Date().getUTCFullYear() + 49);
  });

  test('zip round trip; stored entries are 4-byte aligned', () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello'), method: 8 },
      { name: 'b.bin', data: crypto.randomBytes(37), method: 0 },
      { name: 'عربي.png', data: crypto.randomBytes(11), method: 0 },
    ];
    const zip = writeZip(entries);
    assert.deepEqual(readZip(zip).map((e) => [e.name, e.data.toString('hex')]), entries.map((e) => [e.name, e.data.toString('hex')]));
    assert.equal(storedDataOffset(zip, 'b.bin') % 4, 0);
    assert.equal(storedDataOffset(zip, 'عربي.png') % 4, 0);
  });

  test('resources.arsc: the placeholder becomes the brand name, other strings stay', () => {
    const out = replaceArscString(fakeArsc(['res/x.xml', LABEL_PLACEHOLDER, 'other']), LABEL_PLACEHOLDER, 'سيلانترو المعادي');
    assert.deepEqual(arscStrings(out), ['res/x.xml', 'سيلانترو المعادي', 'other']);
    assert.equal(out.readUInt32LE(4), out.length, 'table size updated');
    assert.equal(out.subarray(-24).toString('ascii'), 'fake package chunk......', 'packages untouched');
    assert.throws(() => replaceArscString(out, LABEL_PLACEHOLDER, 'x'), /not found/);
  });

  test('v2 signature verifies and covers the content', () => {
    const signed = signV2(writeZip([{ name: 'x', data: Buffer.from('data'), method: 8 }]), { privateKey, certDer });
    verifyV2(signed);
    const tampered = Buffer.from(signed);
    tampered[40] ^= 1;
    assert.throws(() => verifyV2(tampered));
  });

  test('brand apk: label, icon, config, old signature dropped, signed', () => {
    const icon = png(16);
    const apk = buildApk(templateApk(), {
      label: 'Beano’s', icon, config: { server: 'https://x.test', brand: 'beano', key: 'k1' }, privateKey, certDer,
    });
    verifyV2(apk);
    const files = Object.fromEntries(readZip(apk).map((e) => [e.name, e.data]));
    assert.ok(!Object.keys(files).some((n) => n.startsWith('META-INF/')));
    assert.ok(arscStrings(files['resources.arsc']).includes('Beano’s'));
    assert.deepEqual(files['res/drawable-nodpi-v4/app_icon.png'], icon);
    assert.deepEqual(files['res/mipmap-nodpi-v4/ic_launcher.png'], icon);
    assert.deepEqual(JSON.parse(files['assets/pager.json']), { server: 'https://x.test', brand: 'beano', key: 'k1' });
    assert.equal(storedDataOffset(apk, 'resources.arsc') % 4, 0);
  });

  test('exe config is written in place; ico wraps a png', () => {
    const exe = templateExe();
    const out = patchExeConfig(exe, { server: 'https://x.test', brand: 'b', key: 'k', name: 'اسم' });
    assert.equal(out.length, exe.length);
    const at = out.indexOf(MARKER) + MARKER.length;
    assert.deepEqual(JSON.parse(out.subarray(at, at + 1004).toString('utf8').trim()), { server: 'https://x.test', brand: 'b', key: 'k', name: 'اسم' });
    assert.throws(() => patchExeConfig(Buffer.from('no marker'), {}), /exactly once/);
    const ico = pngToIco(png(256));
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico[6], 0, '256 is written as 0');
    assert.equal(ico.subarray(22, 26).toString('hex'), '89504e47');
  });
});

// ---------------------------------------------------------------------------
// Download page -> install -> link -> bar, against the real server
// ---------------------------------------------------------------------------

describe('cashier app flow', () => {
  let server;
  let nativeDir;
  let su;
  let app; // the cashier app's WebView (cookie jar)
  const superPost = (p, body) => su.post(`/api/super${p}`, body);
  let appKey;

  before(async () => {
    nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-native-'));
    fs.writeFileSync(path.join(nativeDir, 'cashier-template.apk'), templateApk());
    fs.writeFileSync(path.join(nativeDir, 'cashier-template.exe'), templateExe());
    fs.writeFileSync(path.join(nativeDir, 'versions.json'), JSON.stringify({ android: '1.0.0', windows: '1.0.0' }));
    server = await startServer({ SUPER_PASSWORD_HASH: await hashPin(SUPER_PASSWORD), NATIVE_DIR: nativeDir });
    su = client(server.url);
    app = client(server.url);
    await su.post('/api/super/login', { password: SUPER_PASSWORD });
    await superPost('/brands', { id: 'cil', name: 'سيلانترو' });
    await superPost('/brands/cil/branches', { id: 'cil-maadi', name: 'المعادي', area: 'المعادي', pin: '4821' });
    await superPost('/brands/cil/branches', { id: 'cil-zamalek', name: 'الزمالك', pin: '7310' });
    await superPost('/brands', { id: 'other', name: 'Other' });
    await superPost('/brands/other/branches', { id: 'other-a', name: 'Other A', pin: '1111' });
    await superPost('/brands/cil/owners', { username: 'cil.owner', password: 'cil-owner-pass' });
  });
  after(async () => {
    await server?.stop();
    fs.rmSync(nativeDir, { recursive: true, force: true });
  });

  test('the link is off until the super sets a password', async () => {
    const anon = client(server.url);
    assert.equal((await anon.get('/api/app/cil')).status, 404);
    assert.equal((await anon.get('/app/cil')).status, 200, 'the page itself loads and explains');
    const res = await superPost('/brands/cil/app', { password: 'dl-pass-123' });
    assert.equal(res.status, 200);
    assert.equal(res.data.enabled, true);
    assert.equal(res.data.password, 'dl-pass-123');
    assert.equal(res.data.url, `${server.url}/app/cil`);
    assert.deepEqual(res.data.platforms, { android: { available: true, version: '1.0.0' }, windows: { available: true, version: '1.0.0' } });
    assert.equal((await superPost('/brands/cil/app', { password: 'short' })).data.field, 'password');
    const info = await anon.get('/api/app/cil');
    assert.equal(info.data.name, 'سيلانترو');
  });

  test('wrong password 401 (rate limited), right one gives download links', async () => {
    const anon = client(server.url);
    assert.equal((await anon.post('/api/app/cil/unlock', { password: 'nope' })).status, 401);
    const ok = await anon.post('/api/app/cil/unlock', { password: 'dl-pass-123' });
    assert.equal(ok.status, 200);
    assert.match(ok.data.links.android, /^\/app\/cil\/download\/android\?t=/);
    let last;
    for (let i = 0; i < 6; i++) last = await anon.post('/api/app/cil/unlock', { password: 'x' }, { ip: '10.9.9.9' });
    assert.equal(last.status, 429);
  });

  test('android download: the brand apk, signed, with its config; links expire with the password', async () => {
    const { links } = (await client(server.url).post('/api/app/cil/unlock', { password: 'dl-pass-123' })).data;
    const res = await fetch(server.url + links.android);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(res.headers.get('content-disposition'), /filename="cil-cashier\.apk"; filename\*=UTF-8''/);
    const apk = Buffer.from(await res.arrayBuffer());
    verifyV2(apk);
    const files = Object.fromEntries(readZip(apk).map((e) => [e.name, e.data]));
    const config = JSON.parse(files['assets/pager.json']);
    assert.equal(config.server, server.url);
    assert.equal(config.brand, 'cil');
    appKey = config.key;
    assert.ok(appKey.length >= 20);
    assert.ok(arscStrings(files['resources.arsc']).includes('سيلانترو'));

    // Same key for every later download; the signing key never changes either.
    const again = Buffer.from(await (await fetch(server.url + links.android)).arrayBuffer());
    assert.equal(JSON.parse(Object.fromEntries(readZip(again).map((e) => [e.name, e.data]))['assets/pager.json']).key, appKey);
    assert.deepEqual(verifyV2(again).cert, verifyV2(apk).cert);

    assert.equal((await fetch(`${server.url}/app/cil/download/android?t=forged`)).status, 403);
    assert.equal((await fetch(server.url + links.android.replace('/cil/', '/other/'))).status, 403, 'token is per brand');
    await superPost('/brands/cil/app', { password: 'dl-pass-456' });
    assert.equal((await fetch(server.url + links.android)).status, 403, 'new password, old links stop');
  });

  test('windows download: a zip with the exe carrying the brand config', async () => {
    const { links } = (await client(server.url).post('/api/app/cil/unlock', { password: 'dl-pass-456' })).data;
    const res = await fetch(server.url + links.windows);
    assert.equal(res.status, 200);
    const [entry] = readZip(Buffer.from(await res.arrayBuffer()));
    assert.equal(entry.name, 'cil-cashier.exe');
    const at = entry.data.indexOf(MARKER) + MARKER.length;
    const config = JSON.parse(entry.data.subarray(at, at + 1004).toString('utf8').trim());
    assert.deepEqual(config, { server: server.url, brand: 'cil', key: appKey, name: 'سيلانترو' });
  });

  test('downloads are counted for the dashboards', async () => {
    const view = (await su.get('/api/super/brands/cil/app')).data;
    assert.equal(view.downloads.android.count, 2);
    assert.equal(view.downloads.windows.count, 1);
  });

  test('first start: setup page; wrong key or other brand refused; branch + PIN links the device', async () => {
    const start = await app.get(`/app/cil/start?k=${appKey}&platform=android&v=1.0.0&model=Sunmi%20V2`);
    assert.equal(start.status, 200);
    assert.match(start.data, /setup\.js/);
    assert.ok(app.jar.has('sp_app'), 'marks the app for the pages');

    assert.equal((await app.get('/api/app/cil/setup?k=wrong')).status, 404);
    const setup = await app.get(`/api/app/cil/setup?k=${appKey}`);
    assert.deepEqual(setup.data.branches.map((b) => b.id), ['cil-maadi', 'cil-zamalek']);
    assert.equal(setup.data.device, null);

    const link = (body) => app.post('/api/app/cil/link', { k: appKey, platform: 'android', model: 'Sunmi V2', version: '1.0.0', ...body });
    assert.equal((await link({ branchId: 'cil-maadi', pin: '0000' })).status, 401);
    assert.equal((await link({ branchId: 'other-a', pin: '1111' })).data.field, 'branchId', 'other brand branch');
    const ok = await link({ branchId: 'cil-maadi', pin: '4821', name: 'كاشير 1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.url, '/bar/cil-maadi');
    assert.ok(app.jar.has('sp_device'));
    assert.equal((await app.get('/api/bar/cil-maadi/state')).status, 200);
    assert.equal((await app.get('/api/bar/cil-zamalek/state')).status, 401);
  });

  test('later starts go straight to the bar; the owner sees the device online', async () => {
    const start = await fetch(`${server.url}/app/cil/start?k=${appKey}&platform=android&v=1.0.1`, {
      redirect: 'manual', headers: { cookie: [...app.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    assert.equal(start.status, 302);
    assert.equal(start.headers.get('location'), '/bar/cil-maadi');

    const owner = client(server.url);
    await owner.post('/api/brand/login', { username: 'cil.owner', password: 'cil-owner-pass' });
    const cookie = [...app.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const stream = await sse(`${server.url}/api/bar/cil-maadi/events`, { cookie });
    await stream.next('hello');
    const view = (await owner.get('/api/brand/cil/app')).data;
    assert.equal(view.password, 'dl-pass-456', 'the owner forwards link + password');
    assert.equal(view.devices.length, 1);
    const [d] = view.devices;
    assert.deepEqual([d.branchId, d.name, d.platform, d.version, d.online, d.needsPin], ['cil-maadi', 'كاشير 1', 'android', '1.0.1', true, false]);
    const card = (await owner.get('/api/brand/cil/overview')).data.branches.find((b) => b.id === 'cil-maadi');
    assert.deepEqual(card.apps, { linked: 1, online: 1 });
    stream.close();

    assert.equal((await owner.post(`/api/brand/cil/devices/${d.id}/rename`, { name: 'الكاشير الكبير' })).status, 200);
    assert.equal((await owner.get('/api/brand/other/app')).status, 401, 'never another brand');
  });

  test('PIN change: the app asks for the new PIN, keeps its row', async () => {
    await superPost('/branches/cil-maadi/pin', { pin: '9999' });
    const renew = await app.post('/api/app/renew', { shopId: 'cil-maadi' });
    assert.equal(renew.status, 409);
    assert.equal(renew.data.relink, '/app/cil/start');
    const setup = (await app.get('/api/app/cil/setup')).data;
    assert.deepEqual(setup.device, { branchId: 'cil-maadi', name: 'الكاشير الكبير', needsPin: true });
    const ok = await app.post('/api/app/cil/link', { branchId: 'cil-maadi', pin: '9999', name: 'الكاشير الكبير', platform: 'android' });
    assert.equal(ok.status, 200, 'a linked device needs no key to relink');
    const devices = (await su.get('/api/super/brands/cil/app')).data.devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].needsPin, false);
  });

  test('an expired staff session renews silently; revoking ends the app session at once', async () => {
    app.jar.delete('sp_staff_cil-maadi');
    assert.equal((await app.get('/api/bar/cil-maadi/state')).status, 401);
    assert.equal((await app.post('/api/app/renew', { shopId: 'cil-maadi' })).status, 200);
    assert.equal((await app.get('/api/bar/cil-maadi/state')).status, 200);
    assert.equal((await app.post('/api/app/renew', { shopId: 'cil-zamalek' })).status, 401);

    const [d] = (await su.get('/api/super/brands/cil/app')).data.devices;
    assert.equal((await superPost(`/brands/cil/devices/${d.id}/revoke`)).status, 200);
    assert.equal((await app.get('/api/bar/cil-maadi/state')).status, 401);
    assert.equal((await app.post('/api/app/renew', { shopId: 'cil-maadi' })).status, 401);
    const start = await app.get(`/app/cil/start?k=${appKey}&platform=android`);
    assert.match(start.data, /setup\.js/, 'back to setup');
    assert.equal((await su.get('/api/super/brands/cil/app')).data.devices.length, 0);
  });

  test('app icon: square PNGs only; the apk carries it, the ico and page use it', async () => {
    const upload = (size, body) => su.request('POST', `/api/super/brands/cil/app-icon?size=${size}`, { body, headers: { 'content-type': 'image/png' } });
    assert.equal((await upload(432, png(100))).status, 400);
    const icon = png(432, [255, 255, 255]);
    assert.equal((await upload(432, icon)).status, 200);
    assert.equal((await upload(256, png(256))).status, 200);
    const view = (await su.get('/api/super/brands/cil/app')).data;
    assert.equal(view.customIcon, true);
    assert.deepEqual(Buffer.from(await (await fetch(`${server.url}/app/cil/icon.png`)).arrayBuffer()), icon);
    const ico = Buffer.from(await (await fetch(`${server.url}/app/cil/icon.ico`)).arrayBuffer());
    assert.equal(ico[6], 0);

    const { links } = (await client(server.url).post('/api/app/cil/unlock', { password: 'dl-pass-456' })).data;
    const apk = Buffer.from(await (await fetch(server.url + links.android)).arrayBuffer());
    assert.deepEqual(Object.fromEntries(readZip(apk).map((e) => [e.name, e.data]))['res/drawable-nodpi-v4/app_icon.png'], icon);
  });

  test('a trashed brand: link and app stop', async () => {
    await superPost('/brands/cil/trash');
    assert.equal((await client(server.url).get('/api/app/cil')).status, 404);
    assert.equal((await client(server.url).get('/api/app/cil/setup?k=' + appKey)).status, 404);
    await superPost('/brands/cil/restore');
    assert.equal((await client(server.url).get('/api/app/cil')).status, 200);
  });

  test('every app action is audited', async () => {
    const actions = new Set((await su.get('/api/super/audit?limit=500')).data.entries.map((e) => e.action));
    for (const a of ['app.password', 'app.download', 'app.icon', 'device.link', 'device.rename', 'device.revoke']) {
      assert.ok(actions.has(a), `missing ${a}`);
    }
  });
});

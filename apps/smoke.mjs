// End-to-end smoke test of a real cashier app build (CI, and locally):
//   node apps/smoke.mjs windows apps/windows/target/release/cashier.exe
//     SMOKE_INSTALL=1 also checks the first-run install (folder in %LOCALAPPDATA%\Programs and the
//     Desktop shortcut). It really installs: use it on a throwaway machine (CI), not your own.
//   node apps/smoke.mjs android apps/android/build/cashier-template.apk     (needs adb + a running emulator)
//
// Starts the real server with the template, sets a brand up, downloads that brand's package the way a
// branch manager would (download page password), runs it, and passes once the app has opened the
// brand's start page AND that page's script has called the setup API, i.e. the WebView really runs it.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPin } from '../server/src/auth.js';
import { readZip } from '../server/src/native/zip.js';
import { client, startServer } from '../server/test/helpers.js';

const [platform, template] = process.argv.slice(2);
if (!['android', 'windows'].includes(platform) || !template) {
  console.error('usage: node apps/smoke.mjs android|windows <template>');
  process.exit(2);
}
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);

const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-native-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-smoke-'));
fs.copyFileSync(template, path.join(nativeDir, platform === 'android' ? 'cashier-template.apk' : 'cashier-template.exe'));

const server = await startServer({ SUPER_PASSWORD_HASH: await hashPin('smoke-super-pass'), NATIVE_DIR: nativeDir, LOG_LEVEL: 'info' });
let child = null;
let code = 1;
try {
  const su = client(server.url);
  await su.post('/api/super/login', { password: 'smoke-super-pass' });
  await su.post('/api/super/brands', { id: 'smoke', name: 'تجربة' });
  await su.post('/api/super/brands/smoke/branches', { id: 'smoke-a', name: 'فرع التجربة', pin: '2468' });
  await su.post('/api/super/brands/smoke/app', { password: 'smoke-download' });

  const { links } = (await client(server.url).post('/api/app/smoke/unlock', { password: 'smoke-download' })).data;
  const res = await fetch(server.url + links[platform]);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const pkg = Buffer.from(await res.arrayBuffer());
  console.log(`downloaded ${platform} package: ${pkg.length} bytes from ${server.url}`);

  if (platform === 'windows') {
    const [exe] = readZip(pkg);
    const file = path.join(work, exe.name);
    fs.writeFileSync(file, exe.data);
    const env = { ...process.env };
    if (process.env.SMOKE_INSTALL === '1') delete env.PAGER_NO_INSTALL;
    else env.PAGER_NO_INSTALL = '1';
    child = spawn(file, [], { env, stdio: 'ignore' });
  } else {
    const file = path.join(work, 'smoke.apk');
    fs.writeFileSync(file, pkg);
    const port = new URL(server.url).port;
    const adb = (...args) => {
      const r = spawnSync('adb', args, { encoding: 'utf8' });
      console.log(`adb ${args.join(' ')} -> ${r.status} ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
      if (r.status !== 0) throw new Error(`adb ${args[0]} failed`);
    };
    adb('install', '-r', file);
    adb('reverse', `tcp:${port}`, `tcp:${port}`);
    adb('shell', 'am', 'start', '-W', '-n', 'cc.aurexis.pager.cashier/.MainActivity');
  }

  const deadline = Date.now() + TIMEOUT_MS;
  const seen = () => {
    const log = server.output();
    return log.includes('/app/smoke/start?k=') && log.includes('/api/app/smoke/setup');
  };
  while (!seen() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  if (seen()) {
    console.log(`PASS: the ${platform} app opened the brand's start page and ran its script`);
    code = 0;
    if (platform === 'windows' && process.env.SMOKE_INSTALL === '1') {
      const installed = path.join(process.env.LOCALAPPDATA, 'Programs', 'smoke-cashier', 'smoke-cashier.exe');
      const desktop = spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' }).stdout.trim();
      const shortcut = path.join(desktop, 'تجربة.lnk');
      const icon = path.join(path.dirname(installed), 'icon.ico');
      for (const [what, file] of [['installed exe', installed], ['desktop shortcut', shortcut], ['brand icon', icon]]) {
        const ok = fs.existsSync(file);
        console.log(`${ok ? 'ok  ' : 'MISSING'} ${what}: ${file}`);
        if (!ok) code = 1;
      }
      spawnSync('taskkill', ['/IM', 'smoke-cashier.exe', '/F']);
    }
    // SMOKE_HOLD_MS: keep the app open a while (to look at it or take a screenshot).
    await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_HOLD_MS ?? 0)));
  } else {
    console.error(`FAIL: no start/setup request within ${TIMEOUT_MS / 1000}s. Server log:\n${server.output().slice(-4000)}`);
  }
} catch (err) {
  console.error(err);
} finally {
  child?.kill();
  await server.stop();
  fs.rmSync(nativeDir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
process.exit(code);

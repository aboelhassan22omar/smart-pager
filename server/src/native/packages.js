import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildApk } from './apk.js';
import { patchExeConfig, zipExe } from './exe.js';
import { selfSignedCert } from './x509.js';

// Per-brand downloads built on demand from the templates CI drops into NATIVE_DIR:
//   cashier-template.apk   apps/android/build.sh
//   cashier-template.exe   apps/windows (cargo build --release)
//   versions.json          {"android": "1.0.0", "windows": "1.0.0"} (optional)
// Built packages are cached in memory by everything that goes into them.

export const PLATFORMS = {
  android: { template: 'cashier-template.apk', ext: 'apk', type: 'application/vnd.android.package-archive' },
  windows: { template: 'cashier-template.exe', ext: 'zip', type: 'application/zip' },
};
const CACHE_MAX = 16;

/**
 * The APK signing key. It must never change: Android only installs an update over an app
 * signed with the same key. Kept in secrets.json (backed up nightly with it).
 */
export function loadSigner(dataDir) {
  const file = path.join(dataDir, 'secrets.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    saved = {};
  }
  if (!saved.apkSigningKey || !saved.apkSigningCert) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    saved.apkSigningKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
    saved.apkSigningCert = selfSignedCert({ privateKey, publicKey, commonName: 'Cashier App' }).toString('base64');
    fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }
  return { privateKey: crypto.createPrivateKey(saved.apkSigningKey), certDer: Buffer.from(saved.apkSigningCert, 'base64') };
}

export function createPackages({ config }) {
  const templates = new Map(); // platform -> { mtimeMs, size, data }
  const cache = new Map();
  let signer = null;

  function template(platform) {
    const file = path.join(config.nativeDir, PLATFORMS[platform].template);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    const known = templates.get(platform);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known;
    const fresh = { mtimeMs: stat.mtimeMs, size: stat.size, data: fs.readFileSync(file) };
    templates.set(platform, fresh);
    return fresh;
  }

  function versions() {
    try {
      return JSON.parse(fs.readFileSync(path.join(config.nativeDir, 'versions.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  /** { android: { available, version }, windows: {...} } */
  function status() {
    const v = versions();
    return Object.fromEntries(Object.keys(PLATFORMS).map((p) => [p, { available: Boolean(template(p)), version: v[p] ?? null }]));
  }

  /**
   * brand: { id, name, appKey }; png: the brand's 432px square icon, or null for the template's.
   * Returns { data, fileName, type } or null when the platform's template is missing.
   */
  function build(platform, brand, { png = null } = {}) {
    const t = template(platform);
    if (!t) return null;
    const appConfig = { server: config.publicUrl, brand: brand.id, key: brand.appKey };
    const key = crypto.createHash('sha256')
      .update(JSON.stringify([platform, t.mtimeMs, t.size, appConfig, brand.name]))
      .update(png ?? Buffer.alloc(0))
      .digest('hex');
    let data = cache.get(key);
    if (!data) {
      if (platform === 'android') {
        signer ??= loadSigner(config.dataDir);
        data = buildApk(t.data, { label: brand.name, icon: png, config: appConfig, ...signer });
      } else {
        const exe = patchExeConfig(t.data, { ...appConfig, name: brand.name });
        data = zipExe(`${brand.id}-cashier.exe`, exe);
      }
      cache.set(key, data);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return { data, fileName: `${brand.id}-cashier.${PLATFORMS[platform].ext}`, type: PLATFORMS[platform].type };
  }

  return { status, build };
}

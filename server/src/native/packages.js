import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildApk } from './apk.js';
import { patchExeConfig, zipExe } from './exe.js';
import { selfSignedCert } from './x509.js';

// Per-brand downloads built on demand from the templates CI drops into NATIVE_DIR:
//   cashier-template.apk   apps/android/build.sh (package cc.aurexis.pager.cashier)
//   owner-template.apk     the same app as cc.aurexis.pager.owner, so both fit on one phone
//   cashier-template.exe   apps/windows (cargo build --release); the owner app is the same exe
//   versions.json          {"android": "1.0.0", "windows": "1.0.0"} (optional)
// Two apps per brand: the cashier app (role "cashier", a branch device) and the owner's app
// (role "owner", opens the owner page). Built packages are cached in memory by everything
// that goes into them.

export const PLATFORMS = {
  android: { template: { cashier: 'cashier-template.apk', owner: 'owner-template.apk' }, ext: 'apk', type: 'application/vnd.android.package-archive' },
  windows: { template: { cashier: 'cashier-template.exe', owner: 'cashier-template.exe' }, ext: 'zip', type: 'application/zip' },
};
export const APP_ROLES = ['cashier', 'owner'];
const CACHE_MAX = 16;

/** The launcher name: the brand's for the cashier app, «إدارة …» for the owner's. */
export const appLabel = (name, role) => (role === 'owner' ? `إدارة ${name}` : name);

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
  const templates = new Map(); // file -> { mtimeMs, size, data }
  const cache = new Map();
  let signer = null;

  function template(platform, role = 'cashier') {
    const name = PLATFORMS[platform].template[role];
    const file = path.join(config.nativeDir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    const known = templates.get(name);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known;
    const fresh = { mtimeMs: stat.mtimeMs, size: stat.size, data: fs.readFileSync(file) };
    templates.set(name, fresh);
    return fresh;
  }

  function versions() {
    try {
      return JSON.parse(fs.readFileSync(path.join(config.nativeDir, 'versions.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  /** { android: { available, version }, windows: {...} } for one role's app. */
  function status(role = 'cashier') {
    const v = versions();
    return Object.fromEntries(Object.keys(PLATFORMS).map((p) => [p, { available: Boolean(template(p, role)), version: v[p] ?? null }]));
  }

  /**
   * What makes one brand's app on one platform what it is: the template, the role, the name and
   * the icon. An installed app whose build differs (new template, new logo, renamed brand) is
   * offered the update. brand: { id, name, iconAt }. Null when the template is missing.
   */
  function buildId(platform, brand, role = 'cashier') {
    const t = template(platform, role);
    if (!t) return null;
    const version = versions()[platform] ?? `${t.mtimeMs}-${t.size}`;
    return crypto.createHash('sha256')
      .update(JSON.stringify([platform, role, version, config.publicUrl, brand.id, brand.name, brand.iconAt ?? 0]))
      .digest('hex')
      .slice(0, 12);
  }

  /**
   * brand: { id, name, appKey, iconAt }; png: the brand's 432px square icon, or null for the
   * template's. `raw`: the Windows exe itself instead of the zip (the in-app updater).
   * Returns { data, fileName, type, build } or null when the template is missing.
   */
  function build(platform, brand, { png = null, role = 'cashier', raw = false } = {}) {
    const t = template(platform, role);
    if (!t) return null;
    const label = appLabel(brand.name, role);
    const appConfig = { server: config.publicUrl, brand: brand.id, key: brand.appKey, role, build: buildId(platform, brand, role) };
    const key = crypto.createHash('sha256')
      .update(JSON.stringify([platform, raw, t.mtimeMs, t.size, appConfig, label]))
      .update(png ?? Buffer.alloc(0))
      .digest('hex');
    const exeName = `${brand.id}-${role}.exe`;
    let data = cache.get(key);
    if (!data) {
      if (platform === 'android') {
        signer ??= loadSigner(config.dataDir);
        data = buildApk(t.data, { label, icon: png, config: appConfig, ...signer });
      } else {
        const exe = patchExeConfig(t.data, { ...appConfig, name: label });
        data = raw ? exe : zipExe(exeName, exe);
      }
      cache.set(key, data);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    if (platform === 'windows' && raw) return { data, fileName: exeName, type: 'application/octet-stream', build: appConfig.build };
    return { data, fileName: `${brand.id}-${role}.${PLATFORMS[platform].ext}`, type: PLATFORMS[platform].type, build: appConfig.build };
  }

  return { status, build, buildId };
}

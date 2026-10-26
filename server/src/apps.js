import fs from 'node:fs';
import path from 'node:path';
import { pinFingerprint } from './auth.js';
import { PUBLIC_DIR } from './paths.js';
import { randomId } from './util.js';
import { unseal } from './vault.js';

// Cashier apps, shared by the download routes and the super / brand dashboards.

export const APP_PLATFORMS = ['android', 'windows'];
export const PLATFORM_LABEL = { android: 'أندرويد', windows: 'ويندوز' };
const DEFAULT_ICON = { 432: path.join(PUBLIC_DIR, 'img', 'app-icon.png'), 256: path.join(PUBLIC_DIR, 'img', 'app-icon-256.png') };

export const brandAppDir = (config, brandId) => path.join(config.dataDir, 'brands', brandId);
export const iconFile = (config, brandId, size) => path.join(brandAppDir(config, brandId), size === 256 ? 'app-icon-256.png' : 'app-icon.png');

/** The brand's square icon PNG (432 or 256 px), or the neutral default. */
export function readIcon(config, brand, size) {
  if (brand.app_icon_at) {
    try {
      return { png: fs.readFileSync(iconFile(config, brand.id, size)), custom: true };
    } catch {
      /* fall back to the default */
    }
  }
  return { png: fs.readFileSync(DEFAULT_ICON[size]), custom: false };
}

export const appKeyOf = (control, brandId) => control.ensureAppKey(brandId, randomId(18));

export const appUrl = (config, brandId) => `${config.publicUrl}/app/${brandId}`;

/** Fingerprint of the branch's current PIN: a linked device needs the PIN again when it changes. */
export function branchPinFp(tenants, branchId) {
  const shop = tenants.get(branchId)?.store.getShop();
  return shop ? pinFingerprint(shop.pin_hash) : null;
}

export function deviceView({ control, tenants, screens }, device, branchFp = new Map()) {
  if (!branchFp.has(device.branch_id)) branchFp.set(device.branch_id, branchPinFp(tenants, device.branch_id));
  return {
    id: device.id,
    branchId: device.branch_id,
    branchName: control.getBranch(device.branch_id)?.name ?? device.branch_id,
    platform: device.platform,
    name: device.name,
    model: device.model,
    version: device.app_version,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
    online: screens.deviceOnline(device.id),
    needsPin: branchFp.get(device.branch_id) !== device.pin_fp,
  };
}

/** A device that is not connected and was last seen this long ago shows in «محتاج منك». */
export const DEVICE_STALE_MS = 24 * 3600 * 1000;

/** The error log the super sees: newest first, with the device and branch names. */
function errorsView({ control }, brandId) {
  const names = new Map();
  const deviceName = (id) => {
    if (!names.has(id)) names.set(id, control.getDevice(id)?.name ?? 'جهاز اتشال');
    return names.get(id);
  };
  return control.deviceErrors(brandId, 100).map((e) => ({
    id: e.id,
    deviceId: e.device_id,
    deviceName: deviceName(e.device_id),
    branchName: control.getBranch(e.branch_id)?.name ?? e.branch_id,
    kind: e.kind,
    message: e.message,
    detail: e.detail,
    page: e.page,
    version: e.app_version,
    count: e.count,
    firstAt: e.first_at,
    lastAt: e.last_at,
  }));
}

/** Linked devices of live branches that have been off for a day or more (super's «محتاج منك»). */
export function staleDevices({ control, screens }, brandId, now = Date.now()) {
  return control.devicesOfBrand(brandId)
    .filter((d) => !screens.deviceOnline(d.id) && d.last_seen_at < now - DEVICE_STALE_MS)
    .map((d) => ({ device: d, branch: control.getBranch(d.branch_id) }))
    .filter(({ branch }) => branch && !branch.deleted_at)
    .map(({ device, branch }) => ({ id: device.id, name: device.name, branchId: branch.id, branchName: branch.name, lastSeenAt: device.last_seen_at }));
}

/**
 * Everything the dashboards show about a brand's app: link, password, icon, devices.
 * `withErrors`: the super's view also carries the devices' error log.
 */
export function appView(deps, brand, { withErrors = false } = {}) {
  const { config, control, packages } = deps;
  const fps = new Map();
  const devices = control.devicesOfBrand(brand.id)
    .filter((d) => !control.getBranch(d.branch_id)?.deleted_at)
    .map((d) => deviceView(deps, d, fps));
  return {
    url: appUrl(config, brand.id),
    enabled: Boolean(brand.app_password_hash),
    password: unseal(config.cookieSecret, brand.app_password_sealed),
    iconUrl: `/app/${brand.id}/icon.png?v=${brand.app_icon_at ?? 0}`,
    customIcon: Boolean(brand.app_icon_at),
    platforms: packages.status(),
    downloads: control.appDownloads(brand.id),
    devices,
    ...(withErrors ? { errors: errorsView(deps, brand.id) } : {}),
  };
}

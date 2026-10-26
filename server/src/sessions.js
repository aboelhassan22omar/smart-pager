import { pinFingerprint, SESSION_MAX_AGE } from './auth.js';
import { signValue, staffCookieName, staffKeyInfo, verifyValue } from './cookies.js';
import { HttpError } from './errors.js';

// One cookie and one HKDF-derived key per role (and per branch / brand). See DESIGN §15.

const OWNER_MAX_AGE = 14 * 24 * 3600;
// Cashier apps: browsers cap cookie lifetimes at 400 days; every app start renews it.
const DEVICE_MAX_AGE = 400 * 24 * 3600;
const DOWNLOAD_TOKEN_MS = 2 * 3600 * 1000;
const SUPER_MAX_AGE = 12 * 3600;
const IMPERSONATE_MAX_AGE = 3600;

export const OWNER_COOKIE = 'sp_owner';
export const DEVICE_COOKIE = 'sp_device';
// Readable by the page: "this is the cashier app" (no "Powered by", no browser-only hints).
export const APP_COOKIE = 'sp_app';
export const SUPER_COOKIE = 'sp_super';

const cookieOptions = (config, maxAge) => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: config.secureCookies,
  path: '/',
  maxAge,
});

// ---- branch staff ----

/**
 * `impersonated` = a 1h session opened by super ("open as branch").
 * `deviceId` = a session of a linked cashier app: it ends as soon as the device is unlinked.
 */
export function setStaffSession(reply, config, shop, { impersonated = false, deviceId = null } = {}) {
  const payload = { b: shop.id, iat: Date.now(), fp: pinFingerprint(shop.pin_hash) };
  if (impersonated) payload.imp = 1;
  if (deviceId) payload.dv = deviceId;
  const value = signValue(config.cookieSecret, staffKeyInfo(shop.id), payload);
  reply.setCookie(staffCookieName(shop.id), value, cookieOptions(config, impersonated ? IMPERSONATE_MAX_AGE : SESSION_MAX_AGE));
}

export function verifyStaffSession(req, config, shop, { deviceLinked = () => true } = {}) {
  const s = verifyValue(config.cookieSecret, staffKeyInfo(shop.id), req.cookies[staffCookieName(shop.id)]);
  const maxAge = (s?.imp ? IMPERSONATE_MAX_AGE : SESSION_MAX_AGE) * 1000;
  return Boolean(s) && s.b === shop.id && Date.now() - Number(s.iat) < maxAge && s.fp === pinFingerprint(shop.pin_hash)
    && (!s.dv || deviceLinked(s.dv));
}

// ---- cashier app devices ----

// Lax, not Strict: the apps reach /app/<brand>/start from their own offline/boot page, whose
// origin is opaque, and Strict cookies are not sent on that navigation. It only opens GET /start.
export function setDeviceSession(reply, config, device) {
  const value = signValue(config.cookieSecret, 'device', { d: device.id, br: device.brand_id, iat: Date.now() });
  reply.setCookie(DEVICE_COOKIE, value, { ...cookieOptions(config, DEVICE_MAX_AGE), sameSite: 'lax' });
}

/** The linked (not revoked) device this request comes from, or null. */
export function deviceFromRequest(req, { config, control }) {
  const s = verifyValue(config.cookieSecret, 'device', req.cookies[DEVICE_COOKIE]);
  const device = s ? control.getDevice(s.d) : null;
  if (!device || device.revoked_at || device.brand_id !== s.br) return null;
  return device;
}

export function setAppCookie(reply, config, platform) {
  reply.setCookie(APP_COOKIE, platform, { sameSite: 'strict', secure: config.secureCookies, path: '/', maxAge: DEVICE_MAX_AGE });
}

// ---- app downloads: a short-lived token in the link, so any download manager can fetch it ----

const downloadKey = (brandId) => `download:${brandId}`;

export function downloadToken(config, brand) {
  return signValue(config.cookieSecret, downloadKey(brand.id), {
    exp: Date.now() + DOWNLOAD_TOKEN_MS, fp: pinFingerprint(brand.app_password_hash),
  });
}

/** Valid until it expires or the download password changes. */
export function verifyDownloadToken(config, brand, token) {
  const s = verifyValue(config.cookieSecret, downloadKey(brand.id), token);
  return Boolean(s) && Date.now() < Number(s.exp) && Boolean(brand.app_password_hash) && s.fp === pinFingerprint(brand.app_password_hash);
}

// ---- brand owner ----

const ownerKey = (brandId) => `owner:${brandId}`;

export function setOwnerSession(reply, config, owner) {
  const value = signValue(config.cookieSecret, ownerKey(owner.brand_id), {
    o: owner.id, br: owner.brand_id, pv: owner.pw_version, iat: Date.now(),
  });
  reply.setCookie(OWNER_COOKIE, value, cookieOptions(config, OWNER_MAX_AGE));
}

/** The owner signed in for `brandId`, or a 401. A cookie for another brand never verifies. */
export function requireOwner(req, { config, control }, brandId) {
  const s = verifyValue(config.cookieSecret, ownerKey(brandId), req.cookies[OWNER_COOKIE]);
  const owner = s && s.br === brandId ? control.getOwner(s.o) : null;
  const fresh = s && Date.now() - Number(s.iat) < OWNER_MAX_AGE * 1000;
  // A brand in the trash signs its owner out.
  const live = owner && !control.getBrand(owner.brand_id)?.deleted_at;
  if (!owner || !fresh || !live || owner.brand_id !== brandId || owner.pw_version !== s.pv) {
    throw new HttpError(401, 'سجّل دخول الأول');
  }
  return owner;
}

// ---- super ----

export const superEnabled = (config) => Boolean(config.superPasswordHash);
const superFingerprint = (config) => pinFingerprint(config.superPasswordHash);

export function setSuperSession(reply, config) {
  const value = signValue(config.cookieSecret, 'super', { iat: Date.now(), hv: superFingerprint(config) });
  reply.setCookie(SUPER_COOKIE, value, cookieOptions(config, SUPER_MAX_AGE));
}

/** Changing SUPER_PASSWORD_HASH changes the fingerprint and signs every super session out. */
export function requireSuper(req, config) {
  if (!superEnabled(config)) throw new HttpError(404, 'مش موجود');
  const s = verifyValue(config.cookieSecret, 'super', req.cookies[SUPER_COOKIE]);
  if (!s || Date.now() - Number(s.iat) >= SUPER_MAX_AGE * 1000 || s.hv !== superFingerprint(config)) {
    throw new HttpError(401, 'سجّل دخول الأول');
  }
}

/** Mutating dashboard calls must be JSON (CSRF, together with SameSite=Strict cookies). */
// CSRF: writes must be JSON (or one of `alsoAllowed`, e.g. raw image types, which also need
// a CORS preflight and so can't come from another site's form).
export function requireJson(req, alsoAllowed = []) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
  if (req.method !== 'GET' && type !== 'application/json' && !alsoAllowed.includes(type)) {
    throw new HttpError(415, 'نوع الطلب مش مدعوم');
  }
}

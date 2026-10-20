import { pinFingerprint, SESSION_MAX_AGE } from './auth.js';
import { signValue, staffCookieName, staffKeyInfo, verifyValue } from './cookies.js';
import { HttpError } from './errors.js';

// One cookie and one HKDF-derived key per role (and per branch / brand). See DESIGN §15.

const OWNER_MAX_AGE = 14 * 24 * 3600;
const SUPER_MAX_AGE = 12 * 3600;
const IMPERSONATE_MAX_AGE = 3600;

export const OWNER_COOKIE = 'sp_owner';
export const SUPER_COOKIE = 'sp_super';

const cookieOptions = (config, maxAge) => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: config.secureCookies,
  path: '/',
  maxAge,
});

// ---- branch staff ----

/** `impersonated` = a 1h session opened by super ("open as branch"). */
export function setStaffSession(reply, config, shop, { impersonated = false } = {}) {
  const payload = { b: shop.id, iat: Date.now(), fp: pinFingerprint(shop.pin_hash) };
  if (impersonated) payload.imp = 1;
  const value = signValue(config.cookieSecret, staffKeyInfo(shop.id), payload);
  reply.setCookie(staffCookieName(shop.id), value, cookieOptions(config, impersonated ? IMPERSONATE_MAX_AGE : SESSION_MAX_AGE));
}

export function verifyStaffSession(req, config, shop) {
  const s = verifyValue(config.cookieSecret, staffKeyInfo(shop.id), req.cookies[staffCookieName(shop.id)]);
  const maxAge = (s?.imp ? IMPERSONATE_MAX_AGE : SESSION_MAX_AGE) * 1000;
  return Boolean(s) && s.b === shop.id && Date.now() - Number(s.iat) < maxAge && s.fp === pinFingerprint(shop.pin_hash);
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
  if (!owner || !fresh || owner.brand_id !== brandId || owner.pw_version !== s.pv) {
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

// Loyalty stamp card (DESIGN §18.5). A device is known only by an HMAC of a random token
// kept in its own cookie (mirrored in localStorage); no phone number, nothing cross-branch.

import crypto from 'node:crypto';
import { deriveKey } from './cookies.js';
import { featureFlags } from './plans.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const COOKIE_MAX_AGE = 400 * 24 * 3600;
export const DEVICE_CLAIMS = { limit: 3, windowMs: 15 * 60_000 };
export const LOYALTY_EVERY = { min: 2, max: 20 };
export const REWARD_TEXT_MAX = 60;

export const loyaltyEnabled = (shop) => featureFlags(shop).loyalty;
export const deviceCookieName = (branchId) => `sp_dev_${branchId}`;
export const newDeviceToken = () => crypto.randomBytes(32).toString('base64url');

/** The device token from its cookie, else from the page's localStorage mirror (header). */
export function readDeviceToken(req, branchId) {
  for (const value of [req.cookies?.[deviceCookieName(branchId)], req.headers['x-device-token']]) {
    if (typeof value === 'string' && TOKEN_RE.test(value)) return value;
  }
  return null;
}

export function hashDevice(config, branchId, token) {
  return crypto.createHmac('sha256', deriveKey(config.cookieSecret, `device:${branchId}`)).update(token).digest('base64url');
}

export function setDeviceCookie(reply, config, branchId, token) {
  reply.setCookie(deviceCookieName(branchId), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: `/api/b/${branchId}`,
    maxAge: COOKIE_MAX_AGE,
  });
}

/** What the customer page shows: "3 من 5", plus how many rewards are waiting. */
export function loyaltyView(shop, card) {
  return {
    every: shop.loyalty_every,
    rewardText: shop.loyalty_reward_text ?? '',
    stamps: card.stamps,
    rewards: card.rewards,
  };
}

// Shapes the API exposes. Never leak pin_hash, nonces or keys outside bar-only views.

import { readableAccent } from '../public/js/color.js';
import { featureFlags } from './plans.js';

/** Google review link: from the place id (preferred), else the v1 free-form link. */
export function reviewUrl(shop) {
  if (shop.google_place_id) {
    return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(shop.google_place_id)}`;
  }
  return shop.google_review_url ?? null;
}

export const reviewEnabled = (shop) => featureFlags(shop).review;

export const DONE_MESSAGES = {
  picked: 'بالهنا والشفا',
  expired: 'الطلب ده انتهى',
  cancelled: 'الطلب ده اتلغى',
};

export function statusMessage(order, shop) {
  if (order.status === 'preparing') return shop.preparing_message;
  if (order.status === 'ready') return shop.ready_message;
  return DONE_MESSAGES[order.status] ?? '';
}

export const logoUrl = (shop) => (shop.logo ? `/media/b/${shop.id}/${shop.logo}` : null);

export const publicShop = (shop) => ({
  id: shop.id,
  name: shop.name,
  logoUrl: logoUrl(shop),
  preparingMessage: shop.preparing_message,
  readyMessage: shop.ready_message,
  // {color, ink} already adjusted for contrast; null = default latte accent.
  accent: shop.accent_color ? readableAccent(shop.accent_color) : null,
  // Post-pickup review (phase 5): internal stars + the Google button, together.
  feedback: reviewEnabled(shop),
  googleReviewUrl: reviewEnabled(shop) ? reviewUrl(shop) : null,
});

export const publicOrder = (order, shop) => ({
  id: order.id,
  shopId: shop.id,
  shopName: shop.name,
  number: order.number,
  status: order.status,
  message: statusMessage(order, shop),
  createdAt: order.created_at,
  readyAt: order.ready_at ?? null,
  closedAt: order.closed_at ?? null,
  notifyCount: order.notify_count,
});

export const barShop = (shop) => ({
  ...publicShop(shop),
  accentColor: shop.accent_color ?? null,
  qrMode: shop.qr_mode,
  maxNumber: shop.max_number,
  expireHours: shop.expire_hours,
  lateAfterMinutes: shop.late_after_minutes ?? 10,
  reviewClicks: shop.review_clicks ?? 0,
});

export function qrInfo(shop, config) {
  const base = `${config.publicUrl}/s/${shop.id}`;
  return {
    mode: shop.qr_mode,
    dynamicUrl: shop.qr_mode === 'static' ? null : `${base}?n=${shop.qr_nonce}`,
    staticUrl: shop.qr_mode === 'dynamic' ? null : `${base}?k=${shop.static_key}`,
    rotateSeconds: config.nonceRotateSeconds,
    expiresAt: shop.qr_rotated_at + config.nonceRotateSeconds * 1000,
    serverNow: Date.now(),
  };
}

export function appleStatus(config, apnsReady) {
  const a = config.apple;
  return {
    liveActivity: apnsReady,
    appClipBanner: Boolean(a.appId && a.clipBundleId),
    associatedDomains: Boolean(a.teamId),
    apnsEnv: a.env,
    clipBundleId: a.clipBundleId,
  };
}

const attr = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function appleMeta(config) {
  const { appId, clipBundleId } = config.apple;
  if (!appId || !clipBundleId) return '';
  return `<meta name="apple-itunes-app" content="app-id=${attr(appId)}, app-clip-bundle-id=${attr(clipBundleId)}, app-clip-display=card">`;
}

export function appleAppSiteAssociation(config) {
  const { teamId, appBundleId, clipBundleId } = config.apple;
  if (!teamId) return null;
  return {
    applinks: {
      details: [{ appIDs: [`${teamId}.${appBundleId}`], components: [{ '/': '/s/*' }] }],
    },
    appclips: { apps: [`${teamId}.${clipBundleId}`] },
  };
}

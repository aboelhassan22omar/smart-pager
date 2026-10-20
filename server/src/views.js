// Shapes the API exposes. Never leak pin_hash, nonces or keys outside bar-only views.

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

export const logoUrl = (shop) => (shop.logo ? `/media/logos/${shop.logo}` : null);

export const publicShop = (shop) => ({
  id: shop.id,
  name: shop.name,
  logoUrl: logoUrl(shop),
  preparingMessage: shop.preparing_message,
  readyMessage: shop.ready_message,
});

export const publicOrder = (order, shop) => ({
  id: order.id,
  shopId: order.shop_id,
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
  qrMode: shop.qr_mode,
  maxNumber: shop.max_number,
  expireHours: shop.expire_hours,
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

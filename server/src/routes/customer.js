import { HttpError } from '../errors.js';
import { createRateLimiter } from '../ratelimit.js';
import { openSse } from '../sse.js';
import { OPEN_STATUSES } from '../store.js';
import { publicOrder, publicShop } from '../views.js';

const MAX_SUBSCRIPTIONS = 5;
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const HEX_TOKEN_RE = /^[0-9a-f]{64,512}$/;

function decodedLength(value) {
  return typeof value === 'string' && value.length <= 256 && B64URL_RE.test(value)
    ? Buffer.from(value, 'base64url').length
    : -1;
}

function hostAllowed(host, patterns) {
  return patterns.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p));
}

export function validateWebPush(payload, pushHosts) {
  const endpoint = payload?.endpoint;
  let url;
  try {
    url = typeof endpoint === 'string' && endpoint.length <= 2048 ? new URL(endpoint) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:') throw new HttpError(400, 'اشتراك التنبيهات مش صالح', { field: 'endpoint' });
  if (!hostAllowed(url.hostname.toLowerCase(), pushHosts)) {
    throw new HttpError(400, 'خدمة التنبيهات دي مش مدعومة', { field: 'endpoint' });
  }
  const { p256dh, auth } = payload.keys ?? {};
  if (decodedLength(p256dh) !== 65 || decodedLength(auth) !== 16) {
    throw new HttpError(400, 'مفاتيح التنبيهات مش صالحة', { field: 'keys' });
  }
  return { endpoint: url.href, keys: { p256dh, auth } };
}

export function validateLiveActivity(payload) {
  const token = typeof payload?.token === 'string' ? payload.token.toLowerCase() : '';
  if (!HEX_TOKEN_RE.test(token)) throw new HttpError(400, 'توكن الـ Live Activity مش صالح', { field: 'token' });
  const app = payload.app === 'app' ? 'app' : 'clip';
  return { token, app };
}

export default async function customerRoutes(app, { config, store, bus, notifier, service }) {
  const claimLimiter = createRateLimiter({ limit: config.claimRatePerMin });
  app.addHook('onClose', async () => claimLimiter.close());

  function loadOrder(id) {
    const order = store.getOrder(id);
    const shop = order && store.getShop(order.shop_id);
    if (!order || !shop) throw new HttpError(404, 'الطلب ده مش موجود');
    return { order, shop };
  }

  app.get('/health', async () => ({ ok: store.ping() }));

  app.get('/api/vapid-key', async () => ({ key: config.vapid.publicKey }));

  app.get('/api/shops/:id', async (req) => {
    const shop = store.getShop(req.params.id);
    if (!shop) throw new HttpError(404, 'المحل ده مش موجود');
    return publicShop(shop);
  });

  app.post('/api/claim', async (req, reply) => {
    const limit = claimLimiter.take(req.ip);
    if (!limit.ok) {
      reply.header('retry-after', String(limit.retryAfter));
      throw new HttpError(429, 'محاولات كتير. استنى دقيقة وجرّب تاني');
    }
    const { shopId, n, k } = req.body ?? {};
    if (!store.getShop(shopId)) throw new HttpError(404, 'المحل ده مش موجود');
    const { order, shop } = service.claim(shopId, { n, k });
    return publicOrder(order, shop);
  });

  app.get('/api/orders/:id', async (req) => {
    const { order, shop } = loadOrder(req.params.id);
    return publicOrder(order, shop);
  });

  app.get('/api/orders/:id/events', async (req, reply) => {
    const { order, shop } = loadOrder(req.params.id);
    const sse = openSse(req, reply);
    sse.send('order', publicOrder(order, shop));
    const channel = `order:${order.id}`;
    const listener = (event, data) => sse.send(event, data);
    bus.on(channel, listener);
    sse.onClose(() => bus.off(channel, listener));
  });

  app.post('/api/subscribe', async (req) => {
    const { orderId, kind, payload } = req.body ?? {};
    const { order, shop } = loadOrder(orderId);
    if (!OPEN_STATUSES.includes(order.status)) throw new HttpError(409, 'الطلب ده اتقفل خلاص');

    let normalized;
    if (kind === 'webpush') normalized = validateWebPush(payload, config.pushHosts);
    else if (kind === 'live_activity') normalized = validateLiveActivity(payload);
    else throw new HttpError(400, 'نوع الاشتراك مش معروف', { field: 'kind' });

    if (store.countSubscriptions(order.id) >= MAX_SUBSCRIPTIONS) {
      throw new HttpError(429, 'اشتراكات كتير على الطلب ده');
    }
    const sub = store.addSubscription(order.id, kind, normalized);
    if (sub) notifier.subscribed(sub, order, shop);
    return { ok: true };
  });
}

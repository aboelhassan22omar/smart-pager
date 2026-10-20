import { HttpError } from '../errors.js';
import { channels } from '../bus.js';
import {
  DEVICE_CLAIMS, hashDevice, loyaltyEnabled, loyaltyView, newDeviceToken, readDeviceToken, setDeviceCookie,
} from '../loyalty.js';
import { canClaim } from '../plans.js';
import { createRateLimiter } from '../ratelimit.js';
import { openSse } from '../sse.js';
import { FEEDBACK_WINDOW_MS, OPEN_STATUSES } from '../store.js';
import { publicShop, reviewEnabled, reviewUrl } from '../views.js';

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

export default async function customerRoutes(app, { config, control, tenants, bus, notifier, service }) {
  const claimLimiter = createRateLimiter({ limit: config.claimRatePerMin });
  const deviceLimiter = createRateLimiter(DEVICE_CLAIMS);
  app.addHook('onClose', async () => {
    claimLimiter.close();
    deviceLimiter.close();
  });

  app.get('/health', async () => ({ ok: control.ping() }));

  app.get('/api/vapid-key', async () => ({ key: config.vapid.publicKey }));

  // Everything a customer does is scoped to one branch: the branch is resolved once,
  // and order ids are only looked up in that branch's own database.
  await app.register(async (b) => {
    b.addHook('onRequest', async (req) => {
      req.ctx = tenants.resolve(req.params.branch);
    });

    function loadOrder(req, id) {
      const order = req.ctx.store.getOrder(id);
      if (!order) throw new HttpError(404, 'الطلب ده مش موجود');
      return { order, shop: req.ctx.store.getShop() };
    }

    b.get('/', async (req) => publicShop(req.ctx.store.getShop()));

    b.post('/claim', async (req, reply) => {
      const limit = claimLimiter.take(`${req.ctx.branch.id}|${req.ip}`);
      if (!limit.ok) {
        reply.header('retry-after', String(limit.retryAfter));
        throw new HttpError(429, 'محاولات كتير. استنى دقيقة وجرّب تاني');
      }
      // Suspended or trial over: no new orders (open ones finish normally).
      if (!canClaim(req.ctx.branch)) throw new HttpError(402, 'الخدمة متوقفة مؤقتًا، اسأل الكاشير');
      const { n, k } = req.body ?? {};
      const branchId = req.ctx.branch.id;

      // Loyalty on: the order is tied to this device (token created on its first claim).
      let device = null;
      if (loyaltyEnabled(req.ctx.store.getShop() ?? {})) {
        const token = readDeviceToken(req, branchId) ?? newDeviceToken();
        device = { token, hash: hashDevice(config, branchId, token) };
        const perDevice = deviceLimiter.take(`dev|${branchId}|${device.hash}`);
        if (!perDevice.ok) {
          reply.header('retry-after', String(perDevice.retryAfter));
          throw new HttpError(429, 'طلبات كتير من الموبايل ده. استنى شوية وجرّب تاني');
        }
      }

      const { order, shop } = service.claim(req.ctx, { n, k }, { deviceHash: device?.hash });
      const view = service.customerView(req.ctx, order, shop);
      if (!device) return view;
      setDeviceCookie(reply, config, branchId, device.token);
      return { ...view, deviceToken: device.token };
    });

    // The device's stamp card for this branch ({enabled:false} when loyalty is off).
    b.get('/loyalty', async (req) => {
      const shop = req.ctx.store.getShop();
      if (!loyaltyEnabled(shop)) return { enabled: false };
      const token = readDeviceToken(req, req.ctx.branch.id);
      const hash = token ? hashDevice(config, req.ctx.branch.id, token) : null;
      return { enabled: true, ...loyaltyView(shop, req.ctx.store.loyaltyCard(hash)) };
    });

    b.get('/orders/:id', async (req) => {
      const { order, shop } = loadOrder(req, req.params.id);
      return service.customerView(req.ctx, order, shop);
    });

    b.get('/orders/:id/events', async (req, reply) => {
      const { order, shop } = loadOrder(req, req.params.id);
      const sse = openSse(req, reply);
      sse.send('order', service.customerView(req.ctx, order, shop));
      const channel = channels(req.ctx.branch.id).order(order.id);
      const listener = (event, data) => sse.send(event, data);
      bus.on(channel, listener);
      sse.onClose(() => bus.off(channel, listener));
    });

    // Sent (via sendBeacon) when a customer taps "rate us on Google" after pickup.
    b.post('/orders/:id/review-click', async (req) => {
      const { order, shop } = loadOrder(req, req.params.id);
      if (order.status !== 'picked' || !reviewEnabled(shop) || !reviewUrl(shop)) {
        throw new HttpError(409, 'التقييم مش متاح للطلب ده');
      }
      return { ok: true, counted: req.ctx.store.recordReviewClick(order) };
    });

    // Internal stars + optional comment after pickup. Never gates the Google button.
    b.post('/orders/:id/feedback', async (req, reply) => {
      const { order, shop } = loadOrder(req, req.params.id);
      if (!reviewEnabled(shop)) throw new HttpError(404, 'التقييم مش متاح في الفرع ده');
      if (order.status !== 'picked' || Date.now() - order.closed_at > FEEDBACK_WINDOW_MS) {
        throw new HttpError(409, 'التقييم مش متاح للطلب ده');
      }
      const rating = Number(req.body?.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new HttpError(400, 'اختار من 1 لـ 5 نجوم', { field: 'rating' });
      }
      const raw = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
      if (raw.length > 500) throw new HttpError(400, 'التعليق لحد 500 حرف', { field: 'comment' });
      if (!req.ctx.store.addFeedback(order.id, { rating, comment: raw || null })) {
        throw new HttpError(409, 'رأيك وصلنا قبل كده، شكراً');
      }
      return reply.code(201).send({ ok: true });
    });

    b.post('/subscribe', async (req) => {
      const { orderId, kind, payload } = req.body ?? {};
      const { order, shop } = loadOrder(req, orderId);
      if (!OPEN_STATUSES.includes(order.status)) throw new HttpError(409, 'الطلب ده اتقفل خلاص');

      let normalized;
      if (kind === 'webpush') normalized = validateWebPush(payload, config.pushHosts);
      else if (kind === 'live_activity') normalized = validateLiveActivity(payload);
      else throw new HttpError(400, 'نوع الاشتراك مش معروف', { field: 'kind' });

      const { store } = req.ctx;
      if (store.countSubscriptions(order.id) >= MAX_SUBSCRIPTIONS) {
        throw new HttpError(429, 'اشتراكات كتير على الطلب ده');
      }
      const sub = store.addSubscription(order.id, kind, normalized);
      if (sub) notifier.subscribed(sub, order, shop);
      return { ok: true };
    });
  }, { prefix: '/api/b/:branch' });
}

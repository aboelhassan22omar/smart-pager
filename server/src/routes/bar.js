import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { pinFields, PIN_RE, verifyPin } from '../auth.js';
import { channels } from '../bus.js';
import { staffCookieName } from '../cookies.js';
import { canClaim, planView } from '../plans.js';
import { deviceFromRequest, setStaffSession, verifyStaffSession } from '../sessions.js';
import { HttpError } from '../errors.js';
import { randomId } from '../util.js';
import { DEMO_LOCKED, isDemo } from '../demo.js';
import { createRateLimiter } from '../ratelimit.js';
import { openSse } from '../sse.js';
import { newStaticKey, QR_MODES } from '../store.js';
import { appleStatus, barShop, orderUrl, publicOrder, qrInfo } from '../views.js';

const STATUS_TARGETS = ['preparing', 'ready', 'picked', 'cancelled'];
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
// g.page/r/…/review, maps.app.goo.gl/…, search.google.com/local/writereview?placeid=…, google.com.eg/…
const GOOGLE_HOST_RE = /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|g\.page|goo\.gl)$/i;

export function parseGoogleReviewUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || raw.length > 500 || !GOOGLE_HOST_RE.test(url.hostname)) {
    throw new HttpError(400, 'لازم يكون رابط تقييم من جوجل ويبدأ بـ https://', { field: 'googleReviewUrl' });
  }
  return url.href;
}
const MEDIA_FILE_RE = /^(logo|promo)-\d+\.(png|jpg|webp)$/;

export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const invalid = (field, message) => new HttpError(400, message, { field });

function text(body, key, field, max) {
  const value = typeof body[key] === 'string' ? body[key].trim() : '';
  if (value.length < 1 || value.length > max) throw invalid(field, `الحقل ده لازم يكون من 1 لـ ${max} حرف`);
  return value;
}

function integer(body, key, min, max) {
  const value = Number(body[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(key, `لازم رقم صحيح من ${min} لـ ${max}`);
  return value;
}

export default async function barRoutes(app, deps) {
  const { config, control, tenants, bus, notifier, service, screens } = deps;
  const loginLimiter = createRateLimiter({ limit: config.loginRatePerMin });
  app.addHook('onClose', async () => loginLimiter.close());

  // Staff cookie: signed with a key derived for this branch only (sessions.js).
  const setSession = (reply, shop) => setStaffSession(reply, config, shop);

  function requireBar(req) {
    const ctx = tenants.resolve(req.params.shop);
    const shop = ctx.store.getShop();
    // An app session ends the moment its device is unlinked (or moved to another branch).
    const deviceLinked = (id) => {
      const device = control.getDevice(id);
      return Boolean(device) && !device.revoked_at && device.branch_id === shop.id;
    };
    if (!verifyStaffSession(req, config, shop, { deviceLinked })) throw new HttpError(401, 'سجّل دخول الأول');
    req.ctx = ctx;
    req.shop = shop;
  }

  // Order ids are looked up in this branch's database only.
  function shopOrder(req) {
    const order = req.ctx.store.getOrder(req.params.id);
    if (!order) throw new HttpError(404, 'الطلب ده مش موجود');
    return order;
  }

  app.post('/api/bar/login', async (req, reply) => {
    const { shopId, pin } = req.body ?? {};
    const limit = loginLimiter.take(`${shopId}|${req.ip}`);
    if (!limit.ok) {
      reply.header('retry-after', String(limit.retryAfter));
      throw new HttpError(429, 'محاولات كتير. استنى دقيقة وجرّب تاني');
    }
    const shop = tenants.get(shopId)?.store.getShop();
    if (!shop || !(await verifyPin(String(pin ?? ''), shop.pin_hash))) {
      throw new HttpError(401, 'الرقم السري غلط');
    }
    setSession(reply, shop);
    return { ok: true };
  });

  app.post('/api/bar/:shop/logout', async (req, reply) => {
    reply.clearCookie(staffCookieName(req.params.shop), { path: '/' });
    return { ok: true };
  });

  await app.register(async (bar) => {
    bar.addHook('onRequest', async (req) => {
      requireBar(req);
      const isLogo = req.routeOptions.url?.endsWith('/logo');
      // Every visitor shares the demo café: its settings stay as they are.
      const locked = ['/settings', '/pos/rotate'].some((path) => req.routeOptions.url?.endsWith(path));
      if (req.method !== 'GET' && isDemo(req.shop.id) && (isLogo || locked)) {
        throw new HttpError(403, DEMO_LOCKED);
      }
      if (req.method === 'POST' && !isLogo && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new HttpError(415, 'نوع الطلب مش مدعوم');
      }
    });

    bar.get('/state', async (req) => {
      const shop = req.shop;
      return {
        shop: barShop(shop),
        orders: req.ctx.store.openOrders().map((o) => publicOrder(o, shop)),
        qr: qrInfo(shop, config),
        apple: appleStatus(config, notifier.apnsReady),
        plan: planView(req.ctx.branch),
        counter: req.ctx.store.counter(),
        serverNow: Date.now(),
      };
    });

    bar.get('/events', async (req, reply) => {
      const sse = openSse(req, reply);
      sse.send('hello', { serverNow: Date.now() });
      const branchId = req.ctx.branch.id;
      const channel = channels(branchId).bar;
      // A linked cashier app: "online now" on the dashboards while this stream is open.
      const device = deviceFromRequest(req, deps);
      const appDevice = device?.branch_id === branchId ? device.id : null;
      // "reload" is addressed to one device (the super's "refresh screen"); everything else to all.
      const listener = (event, data) => {
        if (event === 'reload') {
          if (appDevice && data.deviceId === appDevice) sse.send('reload', {});
        } else {
          sse.send(event, data);
        }
      };
      bus.on(channel, listener);
      const kind = req.query.screen === 'qr' ? 'qr' : 'bar';
      screens.add(branchId, kind);
      if (appDevice) {
        screens.addDevice(appDevice);
        control.touchDevice(appDevice);
      }
      sse.onClose(() => {
        bus.off(channel, listener);
        screens.remove(branchId, kind);
        if (appDevice) {
          screens.removeDevice(appDevice);
          control.touchDevice(appDevice);
        }
      });
    });

    bar.get('/qr.svg', async (req, reply) => {
      const shop = req.shop;
      const kind = req.query.kind === 'static' ? 'static' : 'dynamic';
      const info = qrInfo(shop, config);
      // ?order=<id>: that order's own QR (order QR mode), only while it is open.
      const order = typeof req.query.order === 'string' ? req.ctx.store.getOrder(req.query.order) : null;
      if (req.query.order && (!order || !['preparing', 'ready'].includes(order.status))) throw new HttpError(404, 'الطلب ده خلص');
      const url = order ? orderUrl(config, shop.id, order.id) : kind === 'static' ? info.staticUrl : info.dynamicUrl;
      if (!url) throw new HttpError(409, 'نوع الكود ده مش مفعّل للمحل');
      const svg = await QRCode.toString(url, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 2,
        color: { dark: '#111214', light: '#ffffff' },
      });
      reply.type('image/svg+xml; charset=utf-8').header('cache-control', 'no-store');
      if (req.query.download) {
        reply.header('content-disposition', `attachment; filename="${shop.id}-qr-${kind}.svg"`);
      }
      return svg;
    });

    // +1 / -1 on the count: an order outside the pager (delivery), or a mistake.
    // Order QR mode: the cashier rings an order up; the customer screen shows its QR.
    bar.post('/orders', async (req) => {
      if (!req.shop.order_qr) throw new HttpError(409, 'كود لكل طلب مش متفعّل للفرع ده');
      if (!canClaim(req.ctx.branch)) throw new HttpError(402, 'الفرع متوقف. جدّد الاشتراك عشان ياخد طلبات');
      const { order, shop } = service.createOrder(req.ctx);
      return publicOrder(order, shop);
    });

    bar.post('/counter', async (req) => {
      const delta = req.body?.delta;
      if (delta !== 1 && delta !== -1) throw invalid('delta', 'لازم 1 أو -1');
      // Sent again by the offline queue when the first reply was lost: applied once.
      const requestId = /^[A-Za-z0-9_-]{8,64}$/.test(req.headers['x-request-id'] ?? '') ? req.headers['x-request-id'] : null;
      return service.adjustCounter(req.ctx, delta, requestId);
    });

    // The link this branch pastes into its POS (created the first time it is asked for).
    const posView = (shop) => ({
      url: `${config.publicUrl}/api/pos/${shop.id}/${shop.pos_token}`,
      // For a POS that prints a QR with the order number in it: {order} is that number.
      receiptUrl: `${config.publicUrl}/r/${shop.id}/${shop.static_key}/{order}`,
      last: shop.pos_last_event ? JSON.parse(shop.pos_last_event) : null,
    });

    bar.get('/pos', async (req) => posView(req.shop.pos_token ? req.shop : req.ctx.store.updateShop({ pos_token: randomId(24) })));

    // The old link stops working right away.
    bar.post('/pos/rotate', async (req) => posView(req.ctx.store.updateShop({ pos_token: randomId(24), pos_last_event: null })));

    // `from`: the status the cashier saw when tapping. Another screen already moved the order:
    // nothing happens, and the screen gets the order as it is now.
    function sameAsSeen(req, order) {
      const from = req.body?.from;
      if (from != null && from !== order.status) {
        throw new HttpError(409, `رقم ${order.ref ?? order.number} اتغيّر من شاشة تانية`, { order: publicOrder(order, req.shop) });
      }
    }

    bar.post('/orders/:id/advance', async (req) => {
      const order = shopOrder(req);
      sameAsSeen(req, order);
      return publicOrder(service.advance(req.ctx, req.shop, order), req.shop);
    });

    bar.post('/orders/:id/status', async (req) => {
      const status = req.body?.status;
      if (!STATUS_TARGETS.includes(status)) throw invalid('status', 'الحالة دي مش معروفة');
      const order = shopOrder(req);
      sameAsSeen(req, order);
      return publicOrder(service.setStatus(req.ctx, req.shop, order, status), req.shop);
    });

    bar.post('/orders/:id/renotify', async (req) => publicOrder(service.renotify(req.ctx, req.shop, shopOrder(req)), req.shop));

    // Loyalty: staff confirm they gave the customer the reward attached to this order.
    bar.post('/orders/:id/redeem', async (req) => publicOrder(service.redeem(req.ctx, req.shop, shopOrder(req)), req.shop));

    bar.post('/settings', async (req, reply) => {
      const body = req.body ?? {};
      const shop = req.shop;
      const fields = {};

      if ('preparingMessage' in body) fields.preparing_message = text(body, 'preparingMessage', 'preparingMessage', 140);
      if ('readyMessage' in body) fields.ready_message = text(body, 'readyMessage', 'readyMessage', 140);
      if ('qrMode' in body) {
        if (!QR_MODES.includes(body.qrMode)) throw invalid('qrMode', 'نوع الكود ده مش معروف');
        fields.qr_mode = body.qrMode;
      }
      if ('maxNumber' in body) fields.max_number = integer(body, 'maxNumber', 10, 9999);
      if ('expireHours' in body) fields.expire_hours = integer(body, 'expireHours', 1, 24);
      if ('lateAfterMinutes' in body) fields.late_after_minutes = integer(body, 'lateAfterMinutes', 1, 120);
      if ('accentColor' in body) {
        const v = body.accentColor;
        if (v === null || v === '') fields.accent_color = null;
        else if (typeof v === 'string' && HEX_COLOR_RE.test(v)) fields.accent_color = v.toLowerCase();
        else throw invalid('accentColor', 'اللون ده مش مظبوط');
        fields.theme_version = 1;
      }
      if (body.rotateStaticKey === true) fields.static_key = newStaticKey();
      if ('newPin' in body) {
        if (typeof body.newPin !== 'string' || !PIN_RE.test(body.newPin)) {
          throw invalid('newPin', 'الرقم السري لازم يكون من 4 لـ 8 أرقام');
        }
        if (!(await verifyPin(String(body.currentPin ?? ''), shop.pin_hash))) {
          throw new HttpError(403, 'الرقم السري الحالي غلط', { field: 'currentPin' });
        }
        Object.assign(fields, await pinFields(config.cookieSecret, body.newPin));
      }
      if ('posOnly' in body) fields.pos_only = body.posOnly === true ? 1 : 0;
      let day = null;
      if ('dayStartHour' in body) day = { dayStartHour: integer(body, 'dayStartHour', 0, 12) };
      if (!Object.keys(fields).length && !day) throw invalid(null, 'مفيش تغييرات تتحفظ');
      if (day) req.ctx.store.setDay(day);
      if (!Object.keys(fields).length) {
        const updated = req.ctx.store.getShop();
        service.publishShop(req.ctx, updated);
        bus.emit(channels(req.ctx.branch.id).bar, 'counter', req.ctx.store.counter());
        return { shop: barShop(updated), qr: qrInfo(updated, config) };
      }

      const updated = req.ctx.store.updateShop(fields);
      if (fields.pin_hash) setSession(reply, updated);
      service.publishShop(req.ctx, updated);
      if (fields.qr_mode || fields.static_key) service.publishNonce(req.ctx, updated);
      return { shop: barShop(updated), qr: qrInfo(updated, config) };
    });

    bar.post('/logo', async (req) => {
      const ext = sniffImage(req.body);
      if (!ext) throw new HttpError(400, 'الصورة لازم تكون PNG أو JPG أو WEBP', { field: 'logo' });
      const { shop, ctx } = req;
      const file = `logo-${Date.now()}.${ext}`;
      await fs.promises.writeFile(path.join(ctx.mediaDir, file), req.body);
      if (shop.logo) await fs.promises.rm(path.join(ctx.mediaDir, shop.logo), { force: true });
      const updated = ctx.store.updateShop({ logo: file });
      service.publishShop(ctx, updated);
      return { shop: barShop(updated) };
    });

    bar.delete('/logo', async (req) => {
      const { shop, ctx } = req;
      if (shop.logo) await fs.promises.rm(path.join(ctx.mediaDir, shop.logo), { force: true });
      const updated = ctx.store.updateShop({ logo: null });
      service.publishShop(ctx, updated);
      return { shop: barShop(updated) };
    });
  }, { prefix: '/api/bar/:shop' });

  // Media is served only from the requested branch's own folder.
  app.get('/media/b/:branch/:file', async (req, reply) => {
    const { file } = req.params;
    const ctx = tenants.get(req.params.branch);
    if (!ctx || !MEDIA_FILE_RE.test(file)) throw new HttpError(404, 'مش موجود');
    const full = path.join(ctx.mediaDir, file);
    if (!full.startsWith(ctx.mediaDir + path.sep)) throw new HttpError(404, 'مش موجود');
    let data;
    try {
      data = await fs.promises.readFile(full);
    } catch {
      throw new HttpError(404, 'مش موجود');
    }
    const ext = path.extname(file).slice(1);
    reply.type(ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return data;
  });
}

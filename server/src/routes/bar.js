import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { cookieName, hashPin, PIN_RE, pinFingerprint, SESSION_MAX_AGE, verifyPin } from '../auth.js';
import { HttpError } from '../errors.js';
import { createRateLimiter } from '../ratelimit.js';
import { openSse } from '../sse.js';
import { newStaticKey, QR_MODES } from '../store.js';
import { appleStatus, barShop, publicOrder, qrInfo } from '../views.js';

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
const LOGO_FILE_RE = /^[a-z0-9-]+-\d+\.(png|jpg|webp)$/;

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

export default async function barRoutes(app, { config, store, bus, notifier, service }) {
  const loginLimiter = createRateLimiter({ limit: config.loginRatePerMin });
  app.addHook('onClose', async () => loginLimiter.close());
  const logosDir = path.join(config.dataDir, 'logos');

  function setSession(reply, shop) {
    reply.setCookie(cookieName(shop.id), `${shop.id}.${Date.now()}.${pinFingerprint(shop.pin_hash)}`, {
      signed: true,
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookies,
      path: '/',
      maxAge: SESSION_MAX_AGE,
    });
  }

  function requireBar(req) {
    const shop = store.getShop(req.params.shop);
    if (!shop) throw new HttpError(404, 'المحل ده مش موجود');
    const raw = req.cookies[cookieName(shop.id)];
    const unsigned = raw ? req.unsignCookie(raw) : { valid: false };
    const [sid, issued, fp] = unsigned.valid ? unsigned.value.split('.') : [];
    const fresh = Date.now() - Number(issued) < SESSION_MAX_AGE * 1000;
    if (sid !== shop.id || !fresh || fp !== pinFingerprint(shop.pin_hash)) {
      throw new HttpError(401, 'سجّل دخول الأول');
    }
    req.shop = shop;
  }

  function shopOrder(req) {
    const order = store.getOrder(req.params.id);
    if (!order || order.shop_id !== req.shop.id) throw new HttpError(404, 'الطلب ده مش موجود');
    return order;
  }

  app.post('/api/bar/login', async (req, reply) => {
    const { shopId, pin } = req.body ?? {};
    const limit = loginLimiter.take(`${req.ip}|${shopId}`);
    if (!limit.ok) {
      reply.header('retry-after', String(limit.retryAfter));
      throw new HttpError(429, 'محاولات كتير. استنى دقيقة وجرّب تاني');
    }
    const shop = store.getShop(shopId);
    if (!shop || !(await verifyPin(String(pin ?? ''), shop.pin_hash))) {
      throw new HttpError(401, 'الرقم السري غلط');
    }
    setSession(reply, shop);
    return { ok: true };
  });

  app.post('/api/bar/:shop/logout', async (req, reply) => {
    reply.clearCookie(cookieName(req.params.shop), { path: '/' });
    return { ok: true };
  });

  await app.register(async (bar) => {
    bar.addHook('onRequest', async (req) => {
      requireBar(req);
      const isLogo = req.routeOptions.url?.endsWith('/logo');
      if (req.method === 'POST' && !isLogo && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new HttpError(415, 'نوع الطلب مش مدعوم');
      }
    });

    bar.get('/state', async (req) => {
      const shop = req.shop;
      return {
        shop: barShop(shop),
        orders: store.openOrders(shop.id).map((o) => publicOrder(o, shop)),
        qr: qrInfo(shop, config),
        apple: appleStatus(config, notifier.apnsReady),
        serverNow: Date.now(),
      };
    });

    bar.get('/events', async (req, reply) => {
      const sse = openSse(req, reply);
      sse.send('hello', { serverNow: Date.now() });
      const channel = `shop:${req.shop.id}`;
      const listener = (event, data) => sse.send(event, data);
      bus.on(channel, listener);
      sse.onClose(() => bus.off(channel, listener));
    });

    bar.get('/qr.svg', async (req, reply) => {
      const shop = req.shop;
      const kind = req.query.kind === 'static' ? 'static' : 'dynamic';
      const info = qrInfo(shop, config);
      const url = kind === 'static' ? info.staticUrl : info.dynamicUrl;
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

    bar.post('/orders/:id/advance', async (req) => publicOrder(service.advance(req.shop, shopOrder(req)), req.shop));

    bar.post('/orders/:id/status', async (req) => {
      const status = req.body?.status;
      if (!STATUS_TARGETS.includes(status)) throw invalid('status', 'الحالة دي مش معروفة');
      return publicOrder(service.setStatus(req.shop, shopOrder(req), status), req.shop);
    });

    bar.post('/orders/:id/renotify', async (req) => publicOrder(service.renotify(req.shop, shopOrder(req)), req.shop));

    bar.post('/settings', async (req, reply) => {
      const body = req.body ?? {};
      const shop = req.shop;
      const fields = {};

      if ('name' in body) fields.name = text(body, 'name', 'name', 60);
      if ('preparingMessage' in body) fields.preparing_message = text(body, 'preparingMessage', 'preparingMessage', 140);
      if ('readyMessage' in body) fields.ready_message = text(body, 'readyMessage', 'readyMessage', 140);
      if ('qrMode' in body) {
        if (!QR_MODES.includes(body.qrMode)) throw invalid('qrMode', 'نوع الكود ده مش معروف');
        fields.qr_mode = body.qrMode;
      }
      if ('maxNumber' in body) fields.max_number = integer(body, 'maxNumber', 10, 9999);
      if ('expireHours' in body) fields.expire_hours = integer(body, 'expireHours', 1, 24);
      if ('accentColor' in body) {
        const v = body.accentColor;
        if (v === null || v === '') fields.accent_color = null;
        else if (typeof v === 'string' && HEX_COLOR_RE.test(v)) fields.accent_color = v.toLowerCase();
        else throw invalid('accentColor', 'اللون ده مش مظبوط');
      }
      if ('googleReviewUrl' in body) fields.google_review_url = parseGoogleReviewUrl(body.googleReviewUrl);
      if (body.rotateStaticKey === true) fields.static_key = newStaticKey();
      if ('newPin' in body) {
        if (typeof body.newPin !== 'string' || !PIN_RE.test(body.newPin)) {
          throw invalid('newPin', 'الرقم السري لازم يكون من 4 لـ 8 أرقام');
        }
        if (!(await verifyPin(String(body.currentPin ?? ''), shop.pin_hash))) {
          throw new HttpError(403, 'الرقم السري الحالي غلط', { field: 'currentPin' });
        }
        fields.pin_hash = await hashPin(body.newPin);
      }
      if (!Object.keys(fields).length) throw invalid(null, 'مفيش تغييرات تتحفظ');

      const updated = store.updateShop(shop.id, fields);
      if (fields.pin_hash) setSession(reply, updated);
      service.publishShop(updated);
      if (fields.qr_mode || fields.static_key) service.publishNonce(updated);
      return { shop: barShop(updated), qr: qrInfo(updated, config) };
    });

    bar.post('/logo', async (req) => {
      const ext = sniffImage(req.body);
      if (!ext) throw new HttpError(400, 'الصورة لازم تكون PNG أو JPG أو WEBP', { field: 'logo' });
      const shop = req.shop;
      const file = `${shop.id}-${Date.now()}.${ext}`;
      await fs.promises.writeFile(path.join(logosDir, file), req.body);
      if (shop.logo) await fs.promises.rm(path.join(logosDir, shop.logo), { force: true });
      const updated = store.updateShop(shop.id, { logo: file });
      service.publishShop(updated);
      return { shop: barShop(updated) };
    });

    bar.delete('/logo', async (req) => {
      const shop = req.shop;
      if (shop.logo) await fs.promises.rm(path.join(logosDir, shop.logo), { force: true });
      const updated = store.updateShop(shop.id, { logo: null });
      service.publishShop(updated);
      return { shop: barShop(updated) };
    });
  }, { prefix: '/api/bar/:shop' });

  app.get('/media/logos/:file', async (req, reply) => {
    const { file } = req.params;
    if (!LOGO_FILE_RE.test(file)) throw new HttpError(404, 'مش موجود');
    let data;
    try {
      data = await fs.promises.readFile(path.join(logosDir, file));
    } catch {
      throw new HttpError(404, 'مش موجود');
    }
    const ext = path.extname(file).slice(1);
    reply.type(ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return data;
  });
}

import fs from 'node:fs';
import path from 'node:path';
import { pinFingerprint, verifyPin } from '../auth.js';
import { APP_PLATFORMS, appKeyOf, branchPinFp, readIcon } from '../apps.js';
import { HttpError } from '../errors.js';
import { pngToIco } from '../native/exe.js';
import { PUBLIC_DIR } from '../paths.js';
import { createRateLimiter } from '../ratelimit.js';
import {
  deviceFromRequest, downloadToken, requireJson, setAppCookie, setDeviceSession, setStaffSession, verifyDownloadToken,
} from '../sessions.js';
import { SHOP_ID_RE } from '../store.js';
import { randomId, safeEqual } from '../util.js';

// Cashier apps:
//   /app/<brand>                       download page (password set by the super)
//   /app/<brand>/download/<platform>   the brand's own build, behind a short-lived token
//   /app/<brand>/start                 where the installed app opens: a linked device goes
//                                      straight to its bar, a new one picks its branch + PIN
// The apps themselves only hold { server, brand, key }; see apps/ and src/native/.

const NAME_MAX = 40;

export default async function appRoutes(app, deps) {
  const { config, control, tenants, packages } = deps;
  const unlockLimiter = createRateLimiter({ limit: config.loginRatePerMin });
  const linkLimiter = createRateLimiter({ limit: config.loginRatePerMin });
  app.addHook('onClose', async () => {
    unlockLimiter.close();
    linkLimiter.close();
  });

  const page = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const downloadPage = page('app.html');
  const setupPage = page('setup.html');
  const sendHtml = (reply, html) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);

  /** A brand that exists and is not in the trash, or null. */
  function liveBrand(id) {
    const brand = typeof id === 'string' && SHOP_ID_RE.test(id) ? control.getBrand(id) : null;
    return brand && !brand.deleted_at ? brand : null;
  }

  function openBrand(id) {
    const brand = liveBrand(id);
    if (!brand?.app_password_hash) throw new HttpError(404, 'اللينك ده مش شغال. اسأل اللي بعته لك');
    return brand;
  }

  function limited(limiter, key, reply) {
    const limit = limiter.take(key);
    if (limit.ok) return;
    reply.header('retry-after', String(limit.retryAfter));
    throw new HttpError(429, 'محاولات كتير. استنى دقيقة وجرّب تاني');
  }

  const liveBranches = (brandId) => control.branchesOfBrand(brandId).filter((b) => !b.deleted_at);
  const audit = (req, action, extra) => control.audit({ ip: req.ip, ...extra, action });

  // ---------------------------------------------------------------- download page

  app.get('/app/:brand', (_req, reply) => sendHtml(reply, downloadPage));

  app.get('/api/app/:brand', async (req) => {
    const brand = openBrand(req.params.brand);
    return { name: brand.name, iconUrl: `/app/${brand.id}/icon.png?v=${brand.app_icon_at ?? 0}`, platforms: packages.status() };
  });

  app.post('/api/app/:brand/unlock', async (req, reply) => {
    requireJson(req);
    const brand = openBrand(req.params.brand);
    limited(unlockLimiter, `${brand.id}|${req.ip}`, reply);
    if (!(await verifyPin(String(req.body?.password ?? ''), brand.app_password_hash))) {
      throw new HttpError(401, 'الباسورد غلط', { field: 'password' });
    }
    const token = encodeURIComponent(downloadToken(config, brand));
    return {
      links: Object.fromEntries(APP_PLATFORMS.map((p) => [p, `/app/${brand.id}/download/${p}?t=${token}`])),
    };
  });

  app.get('/app/:brand/download/:platform', async (req, reply) => {
    const plain = (status, text) => reply.code(status).type('text/plain; charset=utf-8').header('cache-control', 'no-store').send(text);
    const brand = liveBrand(req.params.brand);
    const { platform } = req.params;
    if (!brand || !APP_PLATFORMS.includes(platform)) return plain(404, 'مش موجود');
    if (!verifyDownloadToken(config, brand, req.query.t)) {
      return plain(403, 'اللينك ده خلص. ارجع لصفحة التحميل واكتب الباسورد تاني.');
    }
    const appKey = appKeyOf(control, brand.id);
    const png = platform === 'android' && brand.app_icon_at ? readIcon(config, brand, 432).png : null;
    const pkg = packages.build(platform, { id: brand.id, name: brand.name, appKey }, { png });
    if (!pkg) return plain(503, 'النسخة دي لسه مش جاهزة. جرّب كمان شوية.');
    audit(req, 'app.download', { actor: 'download', brandId: brand.id, detail: { platform } });
    const display = `${brand.name}.${pkg.fileName.split('.').pop()}`;
    return reply
      .type(pkg.type)
      .header('cache-control', 'no-store')
      .header('content-disposition', `attachment; filename="${pkg.fileName}"; filename*=UTF-8''${encodeURIComponent(display)}`)
      .send(pkg.data);
  });

  // Public: the download page and the Windows app's shortcut use it.
  app.get('/app/:brand/icon.png', async (req, reply) => {
    const brand = liveBrand(req.params.brand);
    if (!brand) throw new HttpError(404, 'مش موجود');
    return reply.type('image/png').header('cache-control', 'no-cache').send(readIcon(config, brand, 432).png);
  });

  app.get('/app/:brand/icon.ico', async (req, reply) => {
    const brand = liveBrand(req.params.brand);
    if (!brand) throw new HttpError(404, 'مش موجود');
    return reply.type('image/x-icon').header('cache-control', 'no-cache').send(pngToIco(readIcon(config, brand, 256).png));
  });

  // ---------------------------------------------------------------- inside the app

  const keyOk = (brand, key) => Boolean(brand.app_key) && safeEqual(String(key ?? ''), brand.app_key);
  /** This brand's app: it sent the key built into it, or it is already a linked device of the brand. */
  const fromBrandApp = (req, brand, key) => keyOk(brand, key) || deviceFromRequest(req, deps)?.brand_id === brand.id;
  const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '') || null;

  app.get('/app/:brand/start', async (req, reply) => {
    const brand = liveBrand(req.params.brand);
    const { platform } = req.query;
    if (APP_PLATFORMS.includes(platform)) setAppCookie(reply, config, platform);
    const device = brand ? deviceFromRequest(req, deps) : null;
    if (device && device.brand_id === brand.id) {
      const branch = control.getBranch(device.branch_id);
      const shop = branch && !branch.deleted_at ? tenants.get(branch.id)?.store.getShop() : null;
      if (shop && pinFingerprint(shop.pin_hash) === device.pin_fp) {
        control.touchDevice(device.id, { version: cleanText(req.query.v, 20), model: cleanText(req.query.model, 60) });
        setDeviceSession(reply, config, device);
        setStaffSession(reply, config, shop, { deviceId: device.id });
        return reply.redirect(`/bar/${encodeURIComponent(branch.id)}`);
      }
    }
    return sendHtml(reply, setupPage);
  });

  app.get('/api/app/:brand/setup', async (req) => {
    const brand = liveBrand(req.params.brand);
    if (!brand || !fromBrandApp(req, brand, req.query.k)) throw new HttpError(404, 'النسخة دي مش شغالة. نزّل التطبيق تاني من اللينك اللي وصلك');
    const device = deviceFromRequest(req, deps);
    const mine = device?.brand_id === brand.id ? device : null;
    return {
      name: brand.name,
      iconUrl: `/app/${brand.id}/icon.png?v=${brand.app_icon_at ?? 0}`,
      branches: liveBranches(brand.id).map((b) => ({ id: b.id, name: b.name, area: b.area })),
      device: mine ? { branchId: mine.branch_id, name: mine.name, needsPin: branchPinFp(tenants, mine.branch_id) !== mine.pin_fp } : null,
    };
  });

  app.post('/api/app/:brand/link', async (req, reply) => {
    requireJson(req);
    const body = req.body ?? {};
    const brand = liveBrand(req.params.brand);
    if (!brand || !fromBrandApp(req, brand, body.k)) throw new HttpError(404, 'النسخة دي مش شغالة. نزّل التطبيق تاني من اللينك اللي وصلك');
    const branch = control.getBranch(body.branchId);
    if (!branch || branch.brand_id !== brand.id || branch.deleted_at) throw new HttpError(400, 'اختار الفرع', { field: 'branchId' });
    if (!APP_PLATFORMS.includes(body.platform)) throw new HttpError(400, 'الجهاز ده مش معروف');
    limited(linkLimiter, `${branch.id}|${req.ip}`, reply);
    const shop = tenants.resolve(branch.id).store.getShop();
    if (!(await verifyPin(String(body.pin ?? ''), shop.pin_hash))) throw new HttpError(401, 'الرقم السري غلط', { field: 'pin' });

    const fields = {
      branchId: branch.id,
      name: cleanText(body.name, NAME_MAX) ?? `كاشير ${branch.area ?? branch.name}`,
      model: cleanText(body.model, 60),
      version: cleanText(body.version, 20),
      pinFp: pinFingerprint(shop.pin_hash),
    };
    // Same app re-linking (other branch, new PIN): keep its row, else a new device.
    const existing = deviceFromRequest(req, deps);
    const device = existing?.brand_id === brand.id
      ? control.relinkDevice(existing.id, fields)
      : control.createDevice({ id: randomId(12), brandId: brand.id, platform: body.platform, ...fields });
    setDeviceSession(reply, config, device);
    setStaffSession(reply, config, shop, { deviceId: device.id });
    audit(req, 'device.link', {
      actor: `device:${device.id}`, brandId: brand.id, branchId: branch.id, detail: { name: device.name, platform: device.platform },
    });
    return { url: `/bar/${encodeURIComponent(branch.id)}` };
  });

  // The bar page asks this when its staff session ran out: a linked app gets a new one silently.
  app.post('/api/app/renew', async (req, reply) => {
    requireJson(req);
    const device = deviceFromRequest(req, deps);
    if (!device || device.branch_id !== req.body?.shopId) throw new HttpError(401, 'سجّل دخول الأول');
    const branch = control.getBranch(device.branch_id);
    const shop = branch && !branch.deleted_at ? tenants.get(branch.id)?.store.getShop() : null;
    if (!shop || pinFingerprint(shop.pin_hash) !== device.pin_fp) {
      throw new HttpError(409, 'الرقم السري اتغيّر', { relink: `/app/${device.brand_id}/start` });
    }
    control.touchDevice(device.id);
    setStaffSession(reply, config, shop, { deviceId: device.id });
    return { ok: true };
  });
}

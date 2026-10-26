import fs from 'node:fs';
import path from 'node:path';
import { verifyPin } from '../auth.js';
import { analyticsCsv, brandAnalytics, brandOverview } from '../aggregate.js';
import { HttpError } from '../errors.js';
import { LOYALTY_EVERY, REWARD_TEXT_MAX } from '../loyalty.js';
import { createRateLimiter } from '../ratelimit.js';
import { OWNER_COOKIE, requireJson, requireOwner, setOwnerSession } from '../sessions.js';
import { FEATURES } from '../plans.js';
import { parsePlaceId } from '../upgrades.js';
import { sniffImage } from './bar.js';
import { cleanBranchName } from './super.js';

const PROMO_TEXT_MAX = 120;
export const PROMO_IMAGE_MAX_BYTES = 500 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function promoDay(body, key) {
  const value = typeof body[key] === 'string' ? body[key].trim() : '';
  if (!value) return null;
  if (!DAY_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, 'التاريخ لازم يكون بالشكل 2026-01-31', { field: key });
  }
  return value;
}

// Loyalty rule and promo fields of the owner settings body -> branch_settings columns.
export function ownerExtraFields(body) {
  const fields = {};
  if ('loyaltyEvery' in body) {
    const every = Number(body.loyaltyEvery);
    if (!Number.isInteger(every) || every < LOYALTY_EVERY.min || every > LOYALTY_EVERY.max) {
      throw new HttpError(400, `عدد الطلبات من ${LOYALTY_EVERY.min} لـ ${LOYALTY_EVERY.max}`, { field: 'loyaltyEvery' });
    }
    fields.loyalty_every = every;
  }
  if ('loyaltyRewardText' in body) {
    const text = typeof body.loyaltyRewardText === 'string' ? body.loyaltyRewardText.trim() : '';
    if (text.length > REWARD_TEXT_MAX) throw new HttpError(400, `الهدية لحد ${REWARD_TEXT_MAX} حرف`, { field: 'loyaltyRewardText' });
    fields.loyalty_reward_text = text || null;
  }
  if ('promoText' in body) {
    const text = typeof body.promoText === 'string' ? body.promoText.trim() : '';
    if (text.length > PROMO_TEXT_MAX) throw new HttpError(400, `نص العرض لحد ${PROMO_TEXT_MAX} حرف`, { field: 'promoText' });
    fields.promo_text = text || null;
  }
  if ('promoStartsAt' in body) fields.promo_starts_at = promoDay(body, 'promoStartsAt');
  if ('promoEndsAt' in body) fields.promo_ends_at = promoDay(body, 'promoEndsAt');
  if (fields.promo_starts_at && fields.promo_ends_at && fields.promo_ends_at < fields.promo_starts_at) {
    throw new HttpError(400, 'تاريخ النهاية لازم يكون بعد البداية', { field: 'promoEndsAt' });
  }
  return fields;
}

// Brand owner: sees and manages the branches of their own brand only.
export default async function brandRoutes(app, deps) {
  const { config, control, tenants } = deps;
  const loginLimiter = createRateLimiter({ limit: config.loginRatePerMin });
  app.addHook('onClose', async () => loginLimiter.close());

  app.post('/api/brand/login', async (req, reply) => {
    const { username, password } = req.body ?? {};
    const limit = loginLimiter.take(`owner|${username}|${req.ip}`);
    if (!limit.ok) {
      reply.header('retry-after', String(limit.retryAfter));
      throw new HttpError(429, 'محاولات كتير. استنى دقيقة وجرّب تاني');
    }
    const owner = typeof username === 'string' ? control.ownerByUsername(username) : null;
    if (!owner || !(await verifyPin(String(password ?? ''), owner.password_hash))) {
      throw new HttpError(401, 'اسم المستخدم أو كلمة السر غلط');
    }
    if (control.getBrand(owner.brand_id)?.deleted_at) throw new HttpError(403, 'الحساب ده متوقف. كلّم Aurexis');
    control.markOwnerLogin(owner.id);
    setOwnerSession(reply, config, owner);
    control.audit({ actor: `owner:${owner.id}`, action: 'owner.login', brandId: owner.brand_id, ip: req.ip });
    return { brandId: owner.brand_id };
  });

  app.post('/api/brand/:brand/logout', async (_req, reply) => {
    reply.clearCookie(OWNER_COOKIE, { path: '/' });
    return { ok: true };
  });

  await app.register(async (b) => {
    b.addHook('onRequest', async (req) => {
      req.owner = requireOwner(req, deps, req.params.brand);
      requireJson(req, req.url.split('?')[0].endsWith('/promo-image') ? IMAGE_TYPES : []);
    });

    // A branch of THIS brand, or 404 (never reveals other brands' branches).
    function ownBranch(req) {
      const branch = control.getBranch(req.params.branch);
      if (!branch || branch.brand_id !== req.params.brand || branch.deleted_at) throw new HttpError(404, 'الفرع ده مش موجود');
      return tenants.resolve(branch.id);
    }

    b.get('/overview', async (req) => ({
      ...brandOverview(deps, req.params.brand),
      owner: { username: req.owner.username },
    }));

    // ?from=YYYY-MM-DD&to=YYYY-MM-DD[&branch=<id>]  (at most 366 days)
    function analyticsQuery(req) {
      const { from, to, branch } = req.query;
      if (!DAY_RE.test(from ?? '') || !DAY_RE.test(to ?? '') || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
        throw new HttpError(400, 'التاريخ لازم يكون بالشكل 2026-01-31', { field: 'from' });
      }
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      if (days < 0) throw new HttpError(400, 'تاريخ البداية لازم يكون قبل النهاية', { field: 'to' });
      if (days > 365) throw new HttpError(400, 'أقصى فترة سنة', { field: 'from' });
      if (branch) {
        const b = control.getBranch(branch);
        if (!b || b.brand_id !== req.params.brand) throw new HttpError(404, 'الفرع ده مش موجود');
      }
      return brandAnalytics(deps, req.params.brand, { from, to, branchId: branch || null });
    }

    b.get('/analytics', async (req) => analyticsQuery(req));

    b.get('/analytics.csv', async (req, reply) => {
      const report = analyticsQuery(req);
      reply.type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${req.params.brand}-${report.range.from}-${report.range.to}.csv"`);
      return analyticsCsv(report);
    });

    // Owner settings of one branch: name, feature toggles, Google place id (+ loyalty/promo).
    b.post('/branches/:branch/settings', async (req) => {
      const ctx = ownBranch(req);
      const body = req.body ?? {};
      const audit = (action, detail) => control.audit({
        actor: `owner:${req.owner.id}`, action, brandId: req.params.brand, branchId: ctx.branch.id, detail, ip: req.ip,
      });
      const fields = {};
      if ('name' in body) fields.name = cleanBranchName(body.name);
      if ('googlePlaceId' in body) {
        const id = parsePlaceId(body.googlePlaceId);
        if (id === undefined) throw new HttpError(400, 'الـ Place ID مش مظبوط (أو الصق رابط فيه placeid=)', { field: 'googlePlaceId' });
        fields.google_place_id = id;
      }
      Object.assign(fields, ownerExtraFields(body));
      const features = body.features && typeof body.features === 'object' ? body.features : {};
      const toggles = Object.entries(features).filter(([f]) => FEATURES.includes(f));
      if (!Object.keys(fields).length && !toggles.length) throw new HttpError(400, 'مفيش تغييرات تتحفظ');
      // A stamp card needs a reward to promise.
      const rewardText = 'loyalty_reward_text' in fields ? fields.loyalty_reward_text : ctx.store.getShop().loyalty_reward_text;
      if (features.loyalty === true && !rewardText) {
        throw new HttpError(400, 'اكتب الهدية الأول (مثلًا: مشروب ببلاش)', { field: 'loyaltyRewardText' });
      }

      if (Object.keys(fields).length) {
        ctx.store.updateShop(fields);
        audit(fields.name ? 'branch.rename' : 'branch.owner_settings', { fields: Object.keys(fields), name: fields.name });
      }
      for (const [feature, on] of toggles) {
        control.setFeature(ctx.branch.id, feature, Boolean(on));
        audit(on ? 'feature.enable' : 'feature.disable', { feature });
      }
      return { ok: true };
    });

    // Promo image: PNG/JPG/WEBP (checked by magic bytes), up to 500 KB, in the branch's media.
    b.post('/branches/:branch/promo-image', async (req) => {
      const ctx = ownBranch(req);
      if (Buffer.isBuffer(req.body) && req.body.length > PROMO_IMAGE_MAX_BYTES) {
        throw new HttpError(413, 'الصورة لازم تكون أقل من 500 كيلوبايت', { field: 'promoImage' });
      }
      const ext = sniffImage(req.body);
      if (!ext) throw new HttpError(400, 'الصورة لازم تكون PNG أو JPG أو WEBP', { field: 'promoImage' });
      const old = ctx.store.getShop().promo_image;
      const file = `promo-${Date.now()}.${ext}`;
      await fs.promises.writeFile(path.join(ctx.mediaDir, file), req.body);
      if (old) await fs.promises.rm(path.join(ctx.mediaDir, old), { force: true });
      ctx.store.updateShop({ promo_image: file });
      control.audit({ actor: `owner:${req.owner.id}`, action: 'promo.image', brandId: req.params.brand, branchId: ctx.branch.id, ip: req.ip });
      return { imageUrl: `/media/b/${ctx.branch.id}/${file}` };
    });

    b.delete('/branches/:branch/promo-image', async (req) => {
      const ctx = ownBranch(req);
      const old = ctx.store.getShop().promo_image;
      if (old) await fs.promises.rm(path.join(ctx.mediaDir, old), { force: true });
      ctx.store.updateShop({ promo_image: null });
      return { imageUrl: null };
    });
  }, { prefix: '/api/brand/:brand' });
}

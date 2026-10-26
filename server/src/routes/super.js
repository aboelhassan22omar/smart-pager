import { passwordFields, pinFields, PIN_RE, verifyPin } from '../auth.js';
import fs from 'node:fs';
import { superOverview } from '../aggregate.js';
import { appKeyOf, appView, brandAppDir, iconFile } from '../apps.js';
import { backupStatus, runBackup } from '../backup.js';
import { HttpError } from '../errors.js';
import { DAY_MS, effectivePlan, FEATURES, planView } from '../plans.js';
import { branchUrls, provisionBrand, provisionBranch } from '../provision.js';
import { createRateLimiter } from '../ratelimit.js';
import {
  requireJson, requireSuper, setStaffSession, setSuperSession, SUPER_COOKIE, superEnabled,
} from '../sessions.js';
import { randomId } from '../util.js';
import { barShop } from '../views.js';
import { sniffImage } from './bar.js';

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const bad = (field, message) => new HttpError(400, message, { field });

export function checkPassword(value, field = 'password') {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw bad(field, 'كلمة السر لازم تكون 8 حروف على الأقل');
  }
  return value;
}

export function cleanBranchName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 60) throw bad('name', 'الاسم مطلوب (لحد 60 حرف)');
  return name;
}

function parseDay(value, field) {
  const at = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(at)) throw bad(field, 'التاريخ لازم يكون بالشكل 2026-01-31');
  return at;
}

export default async function superRoutes(app, deps) {
  const { config, control, tenants } = deps;
  const loginLimiter = createRateLimiter({ limit: 5 });
  app.addHook('onClose', async () => loginLimiter.close());
  const audit = (req, action, extra = {}) => control.audit({ actor: 'super', action, ip: req.ip, ...extra });

  app.post('/api/super/login', async (req, reply) => {
    if (!superEnabled(config)) throw new HttpError(404, 'مش موجود');
    const limit = loginLimiter.take(`super|${req.ip}`);
    if (!limit.ok) {
      reply.header('retry-after', String(limit.retryAfter));
      throw new HttpError(429, 'محاولات كتير. استنى دقيقة وجرّب تاني');
    }
    if (!(await verifyPin(String(req.body?.password ?? ''), config.superPasswordHash))) {
      audit(req, 'super.login_failed');
      throw new HttpError(401, 'كلمة السر غلط');
    }
    setSuperSession(reply, config);
    audit(req, 'super.login');
    return { ok: true };
  });

  app.post('/api/super/logout', async (_req, reply) => {
    reply.clearCookie(SUPER_COOKIE, { path: '/' });
    return { ok: true };
  });

  await app.register(async (s) => {
    s.addHook('onRequest', async (req) => {
      requireSuper(req, config);
      requireJson(req, req.url.split('?')[0].endsWith('/app-icon') ? ['image/png'] : []);
    });

    function branchCtx(req) {
      const ctx = tenants.resolve(req.params.branch);
      req.audit = { brandId: ctx.branch.brand_id, branchId: ctx.branch.id };
      return ctx;
    }

    s.get('/overview', async () => ({ ...superOverview(deps), backup: backupStatus(config) }));

    // "Back up now" (the nightly job runs by itself at 03:30).
    s.post('/backup', async (req) => {
      const status = await runBackup({ ...deps, log: req.log });
      audit(req, 'backup.run', { detail: { day: status.day, ok: status.ok } });
      return status;
    });

    s.get('/audit', async (req) => ({ entries: control.auditLog(Math.min(500, Number(req.query.limit) || 100)) }));

    s.post('/brands', async (req, reply) => {
      const brand = provisionBrand(deps, req.body ?? {});
      audit(req, 'brand.create', { brandId: brand.id, detail: { name: brand.name } });
      return reply.code(201).send({ brand });
    });

    s.post('/brands/:brand/branches', async (req, reply) => {
      const body = req.body ?? {};
      const shop = await provisionBranch(deps, { ...body, brandId: req.params.brand });
      audit(req, 'branch.create', { brandId: req.params.brand, branchId: shop.id, detail: { name: shop.name, area: shop.area } });
      return reply.code(201).send({ shop: barShop(shop), urls: branchUrls(config, shop.id) });
    });

    function checkUsername(username) {
      if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        throw bad('username', 'اسم المستخدم من 3 لـ 32 حرف إنجليزي صغير أو أرقام أو . _ -');
      }
      return username;
    }

    const ownerResult = (owner, brandId, password) => ({
      owner: { id: owner.id, username: owner.username, brandId },
      password,
      loginUrl: `${config.publicUrl}/brand/${brandId}`,
    });

    // Creates the owner, or resets the password of an existing owner of this brand.
    // Without a password one is generated and returned once.
    s.post('/brands/:brand/owners', async (req, reply) => {
      const brandId = req.params.brand;
      if (!control.getBrand(brandId)) throw new HttpError(404, 'البراند ده مش موجود');
      const { username, email = null } = req.body ?? {};
      checkUsername(username);
      const cleanEmail = typeof email === 'string' && email.trim() ? email.trim().slice(0, 200) : null;
      const password = req.body?.password ? checkPassword(req.body.password) : randomId(9);
      const fields = await passwordFields(config.cookieSecret, password);
      const existing = control.ownerByUsername(username);
      if (existing && existing.brand_id !== brandId) throw new HttpError(409, 'اسم المستخدم ده مستخدم في براند تاني', { field: 'username' });
      const owner = existing
        ? control.resetOwnerPassword(existing.id, fields)
        : control.createOwner({ brandId, username, email: cleanEmail, ...fields });
      audit(req, existing ? 'owner.reset' : 'owner.create', { brandId, detail: { username } });
      return reply.code(existing ? 200 : 201).send(ownerResult(owner, brandId, password));
    });

    // Edit an owner in place: username and/or password. Only a new password signs them out.
    s.post('/brands/:brand/owners/:owner', async (req) => {
      const brandId = req.params.brand;
      const owner = control.getOwner(Number(req.params.owner));
      if (!owner || owner.brand_id !== brandId) throw new HttpError(404, 'الحساب ده مش موجود');
      const body = req.body ?? {};
      let updated = owner;
      if (body.username !== undefined && body.username !== owner.username) {
        const username = checkUsername(body.username);
        if (control.ownerByUsername(username)) throw new HttpError(409, 'اسم المستخدم ده مستخدم قبل كده', { field: 'username' });
        updated = control.renameOwner(owner.id, username);
        audit(req, 'owner.rename', { brandId, detail: { from: owner.username, username } });
      }
      const password = body.password ? checkPassword(body.password) : null;
      if (password) {
        updated = control.resetOwnerPassword(owner.id, await passwordFields(config.cookieSecret, password));
        audit(req, 'owner.reset', { brandId, detail: { username: updated.username } });
      }
      return ownerResult(updated, brandId, password);
    });

    // ---- cashier app ----

    function liveBrand(req) {
      const brand = control.getBrand(req.params.brand);
      if (!brand) throw new HttpError(404, 'البراند ده مش موجود');
      return brand;
    }

    s.get('/brands/:brand/app', async (req) => appView(deps, liveBrand(req)));

    // The download password (8+ characters; empty = generate one). Turns the download link on.
    s.post('/brands/:brand/app', async (req) => {
      const brand = liveBrand(req);
      const password = req.body?.password ? checkPassword(req.body.password) : randomId(6);
      control.setAppPassword(brand.id, await passwordFields(config.cookieSecret, password));
      appKeyOf(control, brand.id);
      audit(req, 'app.password', { brandId: brand.id });
      return appView(deps, control.getBrand(brand.id));
    });

    // App icon: square PNGs the dashboard renders from the logo, ?size=432 (Android) and 256 (Windows).
    s.post('/brands/:brand/app-icon', async (req) => {
      const brand = liveBrand(req);
      const size = Number(req.query.size) === 256 ? 256 : 432;
      if (sniffImage(req.body) !== 'png' || req.body.readUInt32BE(16) !== size || req.body.readUInt32BE(20) !== size) {
        throw bad('icon', `الأيقونة لازم تكون PNG مربعة ${size}×${size}`);
      }
      fs.mkdirSync(brandAppDir(config, brand.id), { recursive: true });
      await fs.promises.writeFile(iconFile(config, brand.id, size), req.body);
      control.setAppIcon(brand.id, Date.now());
      if (size === 432) audit(req, 'app.icon', { brandId: brand.id });
      return { ok: true };
    });

    s.delete('/brands/:brand/app-icon', async (req) => {
      const brand = liveBrand(req);
      for (const size of [432, 256]) await fs.promises.rm(iconFile(config, brand.id, size), { force: true });
      control.setAppIcon(brand.id, null);
      return { ok: true };
    });

    function brandDevice(req) {
      const device = control.getDevice(req.params.device);
      if (!device || device.brand_id !== req.params.brand || device.revoked_at) throw new HttpError(404, 'الجهاز ده مش موجود');
      return device;
    }

    s.post('/brands/:brand/devices/:device/revoke', async (req) => {
      const device = brandDevice(req);
      control.revokeDevice(device.id);
      audit(req, 'device.revoke', { brandId: device.brand_id, branchId: device.branch_id, detail: { name: device.name } });
      return { ok: true };
    });

    // ---- trash ----

    s.post('/brands/:brand/trash', async (req) => {
      const brand = control.getBrand(req.params.brand);
      if (!brand) throw new HttpError(404, 'البراند ده مش موجود');
      control.trashBrand(brand.id);
      audit(req, 'brand.trash', { brandId: brand.id, detail: { name: brand.name } });
      return { ok: true };
    });

    s.post('/brands/:brand/restore', async (req) => {
      const brand = control.getBrand(req.params.brand);
      if (!brand) throw new HttpError(404, 'البراند ده مش موجود');
      control.restoreBrand(brand.id);
      audit(req, 'brand.restore', { brandId: brand.id, detail: { name: brand.name } });
      return { ok: true };
    });

    s.post('/branches/:branch/trash', async (req) => {
      const ctx = branchCtx(req);
      control.trashBranch(ctx.branch.id, 'manual');
      audit(req, 'branch.trash', { ...req.audit, detail: { reason: 'manual' } });
      return { ok: true };
    });

    // A branch whose trial ended needs more trial days (or a payment right after), or the
    // hourly job would put it straight back in the trash.
    s.post('/branches/:branch/restore', async (req) => {
      const ctx = branchCtx(req);
      if (control.getBrand(ctx.branch.brand_id)?.deleted_at) {
        throw new HttpError(409, 'البراند نفسه في سلة المهملات. رجّع البراند الأول');
      }
      const days = req.body?.trialDays == null || req.body.trialDays === '' ? 0 : Number(req.body.trialDays);
      if (!Number.isInteger(days) || days < 0 || days > 90) throw bad('trialDays', 'عدد الأيام من 1 لـ 90');
      if (days) control.setTrialEnd(ctx.branch.id, Date.now() + days * DAY_MS);
      const after = effectivePlan({ ...control.getBranch(ctx.branch.id), deleted_at: null });
      if (after.reason === 'trial_ended') {
        throw bad('trialDays', 'التجربة خلصت: اكتب كام يوم تجربة زيادة عشان الفرع يرجع');
      }
      const branch = control.restoreBranch(ctx.branch.id);
      audit(req, 'branch.restore', { ...req.audit, detail: days ? { trialDays: days } : null });
      return { plan: planView(branch) };
    });

    s.post('/branches/:branch/rename', async (req) => {
      const ctx = branchCtx(req);
      const name = cleanBranchName(req.body?.name);
      ctx.store.updateShop({ name });
      audit(req, 'branch.rename', { ...req.audit, detail: { name } });
      return { ok: true };
    });

    s.post('/branches/:branch/pin', async (req) => {
      const ctx = branchCtx(req);
      const pin = req.body?.pin;
      if (typeof pin !== 'string' || !PIN_RE.test(pin)) throw bad('pin', 'الرقم السري لازم يكون من 4 لـ 8 أرقام');
      ctx.store.updateShop(await pinFields(config.cookieSecret, pin));
      audit(req, 'branch.pin_reset', req.audit);
      return { ok: true };
    });

    s.post('/branches/:branch/trial', async (req) => {
      const ctx = branchCtx(req);
      const days = Number(req.body?.days);
      if (!Number.isInteger(days) || days < 1 || days > 90) throw bad('days', 'عدد الأيام من 1 لـ 90');
      const from = Math.max(Date.now(), ctx.branch.trial_ends_at ?? 0);
      control.setTrialEnd(ctx.branch.id, from + days * DAY_MS);
      audit(req, 'branch.trial_extend', { ...req.audit, detail: { days } });
      return { plan: planView(control.getBranch(ctx.branch.id)) };
    });

    s.post('/branches/:branch/payments', async (req) => {
      const ctx = branchCtx(req);
      const body = req.body ?? {};
      const amountEgp = Number(body.amountEgp);
      if (!Number.isInteger(amountEgp) || amountEgp < 0 || amountEgp > 1_000_000) throw bad('amountEgp', 'المبلغ بالجنيه رقم صحيح');
      const periodStart = parseDay(body.periodStart, 'periodStart');
      const periodEnd = parseDay(body.periodEnd, 'periodEnd') + DAY_MS - 1;
      if (periodEnd <= periodStart) throw bad('periodEnd', 'نهاية الفترة لازم تكون بعد بدايتها');
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) || null : null;
      const branch = control.recordPayment(ctx.branch.id, { amountEgp, periodStart, periodEnd, note, actor: 'super' });
      audit(req, 'branch.payment', { ...req.audit, detail: { amountEgp, periodStart: body.periodStart, periodEnd: body.periodEnd } });
      return { plan: planView(branch), payments: control.payments(branch.id) };
    });

    s.post('/branches/:branch/suspend', async (req) => {
      const ctx = branchCtx(req);
      control.setSuspended(ctx.branch.id, true);
      audit(req, 'branch.suspend', req.audit);
      return { plan: planView(control.getBranch(ctx.branch.id)) };
    });

    s.post('/branches/:branch/resume', async (req) => {
      const ctx = branchCtx(req);
      control.setSuspended(ctx.branch.id, false);
      audit(req, 'branch.resume', req.audit);
      return { plan: planView(control.getBranch(ctx.branch.id)) };
    });

    s.post('/branches/:branch/features', async (req) => {
      const ctx = branchCtx(req);
      const { feature, forcedOff } = req.body ?? {};
      if (!FEATURES.includes(feature)) throw bad('feature', 'الخاصية دي مش معروفة');
      const set = new Set(JSON.parse(ctx.branch.forced_off || '[]'));
      if (forcedOff) set.add(feature);
      else set.delete(feature);
      control.setForcedOff(ctx.branch.id, [...set]);
      audit(req, forcedOff ? 'feature.force_off' : 'feature.release', { ...req.audit, detail: { feature } });
      return { forcedOff: [...set].sort() };
    });

    // "Open as branch": a 1h staff session for this branch, always audited.
    s.post('/branches/:branch/impersonate', async (req, reply) => {
      const ctx = branchCtx(req);
      setStaffSession(reply, config, ctx.store.getShop(), { impersonated: true });
      audit(req, 'branch.impersonate', req.audit);
      return { url: `/bar/${ctx.branch.id}` };
    });
  }, { prefix: '/api/super' });
}

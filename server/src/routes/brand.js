import { verifyPin } from '../auth.js';
import { analyticsCsv, brandAnalytics, brandOverview } from '../aggregate.js';
import { HttpError } from '../errors.js';
import { createRateLimiter } from '../ratelimit.js';
import { OWNER_COOKIE, requireJson, requireOwner, setOwnerSession } from '../sessions.js';
import { cleanBranchName } from './super.js';

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
      requireJson(req);
    });

    // A branch of THIS brand, or 404 (never reveals other brands' branches).
    function ownBranch(req) {
      const branch = control.getBranch(req.params.branch);
      if (!branch || branch.brand_id !== req.params.brand) throw new HttpError(404, 'الفرع ده مش موجود');
      return tenants.resolve(branch.id);
    }

    b.get('/overview', async (req) => ({
      ...brandOverview(deps, req.params.brand),
      owner: { username: req.owner.username },
    }));

    // ?from=YYYY-MM-DD&to=YYYY-MM-DD[&branch=<id>]  (at most 366 days)
    function analyticsQuery(req) {
      const { from, to, branch } = req.query;
      const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
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

    b.post('/branches/:branch/settings', async (req) => {
      const ctx = ownBranch(req);
      const name = cleanBranchName(req.body?.name);
      ctx.store.updateShop({ name });
      control.audit({
        actor: `owner:${req.owner.id}`, action: 'branch.rename', brandId: req.params.brand, branchId: ctx.branch.id,
        detail: { name }, ip: req.ip,
      });
      return { ok: true };
    });
  }, { prefix: '/api/brand/:brand' });
}

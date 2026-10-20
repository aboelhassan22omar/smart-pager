import { HttpError } from '../errors.js';
import { branchUrls, provisionBrand, provisionBranch } from '../provision.js';
import { safeEqual } from '../util.js';
import { barShop } from '../views.js';

// Scripting API (ADMIN_TOKEN). Kept for automation; dashboards come in phase 2.
export default async function adminRoutes(app, deps) {
  const { config, control } = deps;

  app.register(async (admin) => {
    admin.addHook('onRequest', async (req) => {
      if (!config.adminToken) throw new HttpError(403, 'الـ Admin API مقفول (ADMIN_TOKEN مش متظبط)');
      if (!safeEqual(String(req.headers['x-admin-token'] ?? ''), config.adminToken)) {
        throw new HttpError(401, 'توكن الأدمن غلط');
      }
    });

    // v1 compatible: one shop = a brand plus a branch with the same id.
    admin.post('/shops', async (req, reply) => {
      const { id, name, pin, qrMode } = req.body ?? {};
      if (control.getBranch(id)) throw new HttpError(409, 'فيه محل بنفس المعرّف ده', { field: 'id' });
      if (!control.getBrand(id)) provisionBrand(deps, { id, name });
      const shop = await provisionBranch(deps, { brandId: id, id, name, pin, qrMode });
      return reply.code(201).send({ shop: barShop(shop), urls: branchUrls(config, id) });
    });

    admin.post('/brands', async (req, reply) => {
      const brand = provisionBrand(deps, req.body ?? {});
      return reply.code(201).send({ brand });
    });

    admin.post('/branches', async (req, reply) => {
      const shop = await provisionBranch(deps, req.body ?? {});
      return reply.code(201).send({ shop: barShop(shop), urls: branchUrls(config, shop.id) });
    });
  }, { prefix: '/api/admin' });
}

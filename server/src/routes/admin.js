import { hashPin, PIN_RE } from '../auth.js';
import { HttpError } from '../errors.js';
import { QR_MODES, SHOP_ID_RE } from '../store.js';
import { safeEqual } from '../util.js';
import { barShop } from '../views.js';

export async function createShop(store, config, body) {
  const { id, name, pin, qrMode = 'dynamic' } = body ?? {};
  if (typeof id !== 'string' || !SHOP_ID_RE.test(id)) {
    throw new HttpError(400, 'المعرّف لازم يكون من 3 لـ 32 حرف إنجليزي صغير أو أرقام أو -', { field: 'id' });
  }
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (cleanName.length < 1 || cleanName.length > 60) throw new HttpError(400, 'اسم المحل مطلوب', { field: 'name' });
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
    throw new HttpError(400, 'الرقم السري لازم يكون من 4 لـ 8 أرقام', { field: 'pin' });
  }
  if (!QR_MODES.includes(qrMode)) throw new HttpError(400, 'نوع الكود ده مش معروف', { field: 'qrMode' });
  if (store.getShop(id)) throw new HttpError(409, 'فيه محل بنفس المعرّف ده', { field: 'id' });

  const shop = store.createShop({ id, name: cleanName, pinHash: await hashPin(pin), qrMode });
  return {
    shop: barShop(shop),
    urls: {
      bar: `${config.publicUrl}/bar/${id}`,
      qr: `${config.publicUrl}/qr/${id}`,
      settings: `${config.publicUrl}/settings/${id}`,
    },
  };
}

export default async function adminRoutes(app, { config, store }) {
  app.post('/api/admin/shops', async (req, reply) => {
    if (!config.adminToken) throw new HttpError(403, 'الـ Admin API مقفول (ADMIN_TOKEN مش متظبط)');
    if (!safeEqual(String(req.headers['x-admin-token'] ?? ''), config.adminToken)) {
      throw new HttpError(401, 'توكن الأدمن غلط');
    }
    const result = await createShop(store, config, req.body);
    return reply.code(201).send(result);
  });
}

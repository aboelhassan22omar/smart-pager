import { pinFields, PIN_RE } from './auth.js';
import { HttpError } from './errors.js';
import { DAY_MS } from './plans.js';
import { QR_MODES, SHOP_ID_RE } from './store.js';

const bad = (field, message) => new HttpError(400, message, { field });

function cleanName(value, field = 'name') {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 60) throw bad(field, 'الاسم مطلوب (لحد 60 حرف)');
  return name;
}

function checkId(value, field) {
  if (typeof value !== 'string' || !SHOP_ID_RE.test(value)) {
    throw bad(field, 'المعرّف لازم يكون من 3 لـ 32 حرف إنجليزي صغير أو أرقام أو -');
  }
  return value;
}

export function provisionBrand({ control }, { id, name }) {
  checkId(id, 'id');
  const brandName = cleanName(name);
  if (control.getBrand(id)) throw new HttpError(409, 'فيه براند بنفس المعرّف ده', { field: 'id' });
  return control.createBrand({ id, name: brandName });
}

/**
 * Creates a branch (control row + its own database). New branch ids are `<brand>-<area>`;
 * a branch whose id equals its brand id is allowed for single-branch shops.
 */
export async function provisionBranch({ control, tenants, config }, { brandId, id, name, area = null, pin, qrMode = 'dynamic' }) {
  checkId(brandId, 'brandId');
  checkId(id, 'id');
  if (!control.getBrand(brandId)) throw new HttpError(404, 'البراند ده مش موجود', { field: 'brandId' });
  if (id !== brandId && !id.startsWith(`${brandId}-`)) {
    throw bad('id', `معرّف الفرع لازم يبدأ بـ ${brandId}-`);
  }
  const branchName = cleanName(name);
  const cleanArea = typeof area === 'string' && area.trim() ? area.trim().slice(0, 40) : null;
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) throw bad('pin', 'الرقم السري لازم يكون من 4 لـ 8 أرقام');
  if (!QR_MODES.includes(qrMode)) throw bad('qrMode', 'نوع الكود ده مش معروف');
  if (control.getBranch(id)) throw new HttpError(409, 'فيه فرع بنفس المعرّف ده', { field: 'id' });

  const pinCols = await pinFields(config.cookieSecret, pin);
  // New branches start on a trial (TRIAL_DAYS, default 3).
  const trialEndsAt = Date.now() + (config.trialDays ?? 3) * DAY_MS;
  control.createBranch({ id, brandId, name: branchName, area: cleanArea, trialEndsAt });
  return tenants.get(id).store.initSettings({ pinHash: pinCols.pin_hash, pinSealed: pinCols.pin_sealed, qrMode });
}

export function branchUrls(config, id) {
  return {
    bar: `${config.publicUrl}/bar/${id}`,
    qr: `${config.publicUrl}/qr/${id}`,
    settings: `${config.publicUrl}/settings/${id}`,
  };
}

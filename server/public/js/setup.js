// /app/<brand>/start inside the cashier app, for a device that is not linked yet (or whose
// branch PIN changed): pick the branch, type its PIN, and the app opens that branch's bar.

import { api, esc, shopIdFromPath } from './util.js';

const $ = (id) => document.getElementById(id);
const brandId = shopIdFromPath(location.pathname);
const params = new URLSearchParams(location.search);
const PLATFORMS = ['android', 'windows'];

async function boot() {
  let info;
  try {
    info = await api(`/api/app/${encodeURIComponent(brandId)}/setup?k=${encodeURIComponent(params.get('k') ?? '')}`);
  } catch (err) {
    $('error').hidden = false;
    $('error').textContent = err.message;
    return;
  }
  $('brand-name').textContent = info.name;
  document.title = info.name;
  $('icon').src = info.iconUrl;

  const form = $('link');
  if (!info.branches.length) {
    $('error').hidden = false;
    $('error').textContent = 'البراند لسه ملوش فروع. كلّم صاحب البراند.';
    return;
  }
  form.elements.branchId.innerHTML = (info.branches.length > 1 ? '<option value="">اختار الفرع</option>' : '')
    + info.branches.map((b) => `<option value="${esc(b.id)}">${esc(b.area ? `${b.name} (${b.area})` : b.name)}</option>`).join('');
  if (info.device) {
    form.elements.branchId.value = info.device.branchId;
    form.elements.name.value = info.device.name;
    if (info.device.needsPin) $('intro').textContent = 'الرقم السري بتاع الفرع اتغيّر. اكتب الرقم الجديد.';
  }
  form.hidden = false;
  (form.elements.branchId.value ? form.elements.pin : form.elements.branchId).focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const error = form.querySelector('.form-error');
    const button = form.querySelector('button');
    button.disabled = true;
    error.hidden = true;
    for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
    try {
      const platform = PLATFORMS.includes(params.get('platform')) ? params.get('platform') : (/Android/i.test(navigator.userAgent) ? 'android' : 'windows');
      const { url } = await api(`/api/app/${encodeURIComponent(brandId)}/link`, {
        method: 'POST',
        body: {
          k: params.get('k') ?? '',
          branchId: form.elements.branchId.value,
          pin: form.elements.pin.value.trim(),
          name: form.elements.name.value.trim(),
          platform,
          model: params.get('model') ?? '',
          version: params.get('v') ?? '',
        },
      });
      location.replace(url);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      const field = err.data?.field === 'branchId' ? form.elements.branchId : err.data?.field === 'pin' ? form.elements.pin : null;
      field?.setAttribute('aria-invalid', 'true');
      field?.focus();
      button.disabled = false;
    }
  });
}

boot();

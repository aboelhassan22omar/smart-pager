import { icons } from './icons.js';
import { loadStaffState, toast } from './staff.js';
import { api, esc, shopIdFromPath } from './util.js';

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LOGO_MAX = 2 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const shopId = shopIdFromPath(location.pathname);
const base = `/api/bar/${encodeURIComponent(shopId)}`;
let shop = null;

// ---------- helpers ----------

function formError(form, err) {
  const box = form.querySelector('.form-error');
  for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  if (!err) {
    box.hidden = true;
    return;
  }
  box.textContent = err.message;
  box.hidden = false;
  const field = err.data?.field && form.elements[err.data.field];
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

async function save(body, form) {
  const button = form?.querySelector('[type="submit"]');
  if (button) button.disabled = true;
  try {
    const res = await api(`${base}/settings`, { method: 'POST', body });
    shop = res.shop;
    if (form) formError(form, null);
    renderShop();
    return res;
  } catch (err) {
    if (form) formError(form, err);
    else toast(err.message, 'error');
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------- logo ----------

function renderLogo() {
  const preview = $('logo-preview');
  preview.innerHTML = '';
  if (shop.logoUrl) {
    const img = new Image(72, 72);
    img.alt = 'الشعار الحالي';
    img.src = shop.logoUrl;
    preview.append(img);
  } else {
    preview.innerHTML = icons.upload(26);
  }
  $('logo-remove').hidden = !shop.logoUrl;
  $('drop-title').textContent = shop.logoUrl ? 'اسحب صورة جديدة هنا أو دوس عشان تغيّر الشعار' : 'اسحب صورة الشعار هنا أو دوس للاختيار';
}

async function uploadLogo(file) {
  if (!file) return;
  if (!LOGO_TYPES.includes(file.type)) return toast('الصورة لازم تكون PNG أو JPG أو WEBP', 'error');
  if (file.size > LOGO_MAX) return toast('الصورة أكبر من 2 ميجا', 'error');
  const drop = $('drop');
  drop.classList.add('is-busy');
  // Instant local preview while uploading.
  const localUrl = URL.createObjectURL(file);
  $('logo-preview').innerHTML = `<img src="${localUrl}" alt="">`;
  try {
    shop = (await api(`${base}/logo`, { method: 'POST', raw: file, contentType: file.type })).shop;
    toast('الشعار اتحفظ');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    URL.revokeObjectURL(localUrl);
    drop.classList.remove('is-busy');
    renderLogo();
  }
  return undefined;
}

function bindLogo() {
  const drop = $('drop');
  const input = $('logo-input');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    uploadLogo(input.files[0]);
    input.value = '';
  });
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('is-over'));
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadLogo(e.dataTransfer.files[0]);
  });
  $('logo-remove').addEventListener('click', async () => {
    try {
      shop = (await api(`${base}/logo`, { method: 'DELETE' })).shop;
      renderLogo();
      toast('الشعار اتشال');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------- forms ----------

function renderShop() {
  const info = $('form-info').elements;
  info.name.value = shop.name;
  info.preparingMessage.value = shop.preparingMessage;
  info.readyMessage.value = shop.readyMessage;
  const numbers = $('form-numbers').elements;
  numbers.maxNumber.value = shop.maxNumber;
  numbers.expireHours.value = shop.expireHours;
  for (const radio of document.querySelectorAll('input[name="qrMode"]')) radio.checked = radio.value === shop.qrMode;
  const printable = shop.qrMode !== 'dynamic';
  $('static-actions').hidden = !printable;
  $('rotate-help').hidden = !printable;
  renderLogo();
}

function bindForms() {
  $('form-info').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const ok = await save({
      name: f.name.value,
      preparingMessage: f.preparingMessage.value,
      readyMessage: f.readyMessage.value,
    }, e.target);
    if (ok) toast('البيانات اتحفظت');
  });

  $('form-numbers').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const ok = await save({ maxNumber: Number(f.maxNumber.value), expireHours: Number(f.expireHours.value) }, e.target);
    if (ok) toast('الأرقام اتحفظت');
  });

  $('form-pin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const f = form.elements;
    if (f.newPin.value !== f.confirmPin.value) {
      formError(form, { message: 'الرقمين الجداد مش زي بعض', data: { field: 'confirmPin' } });
      return;
    }
    const ok = await save({ currentPin: f.currentPin.value, newPin: f.newPin.value }, form);
    if (ok) {
      form.reset();
      toast('الرقم السري اتغيّر');
    }
  });

  $('qr-mode').addEventListener('change', async (e) => {
    const ok = await save({ qrMode: e.target.value });
    if (ok) toast('نوع الكود اتغيّر');
    else renderShop();
  });

  const rotate = $('rotate-key');
  rotate.addEventListener('click', async () => {
    if (rotate.dataset.armed !== 'true') {
      rotate.dataset.armed = 'true';
      rotate.textContent = 'دوس تاني للتأكيد';
      setTimeout(() => {
        rotate.dataset.armed = '';
        rotate.textContent = 'غيّر الكود الثابت';
      }, 4000);
      return;
    }
    rotate.dataset.armed = '';
    rotate.textContent = 'غيّر الكود الثابت';
    const ok = await save({ rotateStaticKey: true });
    if (ok) toast('الكود الثابت اتغيّر. اطبع الجديد');
  });

  $('logout').addEventListener('click', async () => {
    try {
      await api(`${base}/logout`, { method: 'POST' });
    } finally {
      location.href = `/bar/${encodeURIComponent(shopId)}`;
    }
  });
}

async function boot() {
  let state;
  try {
    state = await loadStaffState(shopId, $('login-root'));
  } catch (err) {
    $('login-root').innerHTML = `<p class="login">${esc(err.message)}</p>`;
    return;
  }
  shop = state.shop;
  $('app').hidden = false;
  $('back').href = `/bar/${encodeURIComponent(shopId)}`;
  $('back').innerHTML = icons.back(22);
  $('download-static').href = `${base}/qr.svg?kind=static&download=1`;
  $('download-static').innerHTML = `${icons.download()}<span>نزّل الكود الثابت (SVG)</span>`;
  $('logout').innerHTML = `${icons.logout()}<span>خروج من الجهاز ده</span>`;
  renderShop();
  bindLogo();
  bindForms();
}

boot();

import { accentFromImage, applyTheme, brandTheme, MONO_COLOR, readableAccent } from './color.js';
import { icons } from './icons.js';
import { loadStaffState, toast } from './staff.js';
import { api, elapsedLabel, esc, shopIdFromPath } from './util.js';

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LOGO_MAX = 2 * 1024 * 1024;
const DEFAULT_ACCENT = '#9db7d4';

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
    // A new logo brings its own color.
    const color = await accentFromFile(file);
    if (await save({ accentColor: color })) toast(logoColorMessage(color));
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    URL.revokeObjectURL(localUrl);
    drop.classList.remove('is-busy');
    renderLogo();
  }
  return undefined;
}

// ---------- shop accent ----------

const logoColorMessage = (color) => {
  if (!color) return 'الشعار اتحفظ، بس معرفناش نقرا ألوانه. اختار لون من تحت';
  return color === MONO_COLOR ? 'الشعار أبيض وأسود، فالصفحات بقت رمادي زيه' : 'الصفحات بقت بألوان الشعار';
};

async function accentFromFile(file) {
  try {
    const bitmap = await createImageBitmap(file);
    return accentFromImage(bitmap);
  } catch {
    return null;
  }
}

function accentFromLogoUrl(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(accentFromImage(img)));
    img.addEventListener('error', () => resolve(null));
    img.src = url;
  });
}

function previewAccent(hex) {
  const box = document.querySelector('.accent');
  const accent = hex ? readableAccent(hex) : null;
  box.style.setProperty('--shop-accent', accent ? accent.color : DEFAULT_ACCENT);
  box.style.setProperty('--shop-ink', accent ? accent.ink : '#17191d');
  applyTheme(document.documentElement, hex ? brandTheme(hex) : null);
}

function renderAccent() {
  previewAccent(shop.accentColor);
  $('accent-input').value = shop.accentColor ?? DEFAULT_ACCENT;
  $('accent-note').textContent = shop.accentColor
    ? 'بيظهر في كل الصفحات: العميل والكاشير وشاشة الكود ولوحة صاحب المحل'
    : 'اللون الافتراضي. ارفع شعار أو اختار لون';
  $('accent-reset').hidden = !shop.accentColor;
}

function bindAccent() {
  const input = $('accent-input');
  input.addEventListener('input', () => previewAccent(input.value));
  input.addEventListener('change', async () => {
    if (await save({ accentColor: input.value })) toast('لون المحل اتحفظ');
  });
  $('accent-auto').addEventListener('click', async () => {
    if (!shop.logoUrl) return toast('ارفع شعار الأول', 'error');
    const color = await accentFromLogoUrl(shop.logoUrl);
    if (await save({ accentColor: color })) toast(logoColorMessage(color));
    return undefined;
  });
  $('accent-reset').addEventListener('click', async () => {
    if (await save({ accentColor: null })) toast('رجعنا للون الافتراضي');
  });
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

// ---------- POS link ----------

let pos = null;

function posStatus() {
  const box = $('pos-status');
  const last = pos.last;
  box.dataset.tone = '';
  if (!last) {
    box.textContent = 'لسه موصلش حاجة من السيستم. أول طلب يوصل هيظهر هنا.';
  } else if (last.unread) {
    box.dataset.tone = 'alert';
    box.textContent = `السيستم بعت ${elapsedLabel(last.at)} بس معرفناش رقم الطلب. الحقول اللي وصلت: ${last.keys.join('، ') || 'مفيش'}. ابعتها لدعم السيستم أو لينا.`;
  } else {
    box.dataset.tone = 'ok';
    const kind = last.cancelled ? ' (اتلغى)' : last.delivery ? ' (ديليفري)' : '';
    box.textContent = `متوصل. آخر طلب من السيستم: رقم ${last.number}${kind}، ${elapsedLabel(last.at)}.`;
  }
}

const posMessage = (url) => `عايزين السيستم يبعت كل طلب جديد على اللينك ده (POST بـ JSON):
${url}
{ "number": رقم الطلب اللي على الفاتورة, "type": نوع الطلب (delivery أو dine_in أو takeaway) }
لو الطلب اتلغى يتبعت معاه "status": "cancelled". ولو بتعرفوا تبعتوا طلباتكم بالشكل بتاعكم، ابعتوها على نفس اللينك وهو بيقرا أسماء الحقول المعروفة.`;

function renderPos() {
  $('pos-url').value = pos.url;
  $('pos-url-foodics').value = `${pos.url}?delivery=3`;
  $('pos-message').value = posMessage(pos.url);
  posStatus();
}

async function copyText(text, message) {
  await navigator.clipboard?.writeText(text).catch(() => {});
  toast(message);
}

const hourLabel = (h) => {
  if (h === 0) return '12 بالليل';
  if (h === 12) return '12 الضهر';
  return h < 6 ? `${h} بالليل` : `${h} الصبح`;
};

function bindPos() {
  $('pos-only').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (await save({ posOnly: on })) toast(on ? 'الأرقام بقت من السيستم بس' : 'أي حد يمسح الكود ياخد رقم تاني');
  });
  $('pos-copy').addEventListener('click', () => copyText(pos.url, 'اللينك اتنسخ'));
  $('pos-message-copy').addEventListener('click', () => copyText($('pos-message').value, 'الرسالة اتنسخت'));
  $('pos-test').addEventListener('click', async () => {
    try {
      const res = await api(pos.url, { method: 'POST', body: { test: true, number: 123, type: 'delivery' } });
      toast(res.ok ? 'اللينك شغال. العد متغيّرش، ده كان اختبار بس' : 'اللينك مردّش زي المفروض', res.ok ? 'info' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  const rotate = $('pos-rotate');
  rotate.addEventListener('click', async () => {
    if (rotate.dataset.armed !== 'true') {
      rotate.dataset.armed = 'true';
      rotate.textContent = 'اللينك القديم هيقف. دوس تاني';
      setTimeout(() => {
        rotate.dataset.armed = '';
        rotate.textContent = 'غيّر اللينك';
      }, 4000);
      return;
    }
    rotate.dataset.armed = '';
    rotate.textContent = 'غيّر اللينك';
    try {
      pos = await api(`${base}/pos/rotate`, { method: 'POST', body: {} });
      renderPos();
      toast('اللينك اتغيّر. الصق الجديد في السيستم');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function loadPos() {
  try {
    pos = await api(`${base}/pos`);
    renderPos();
  } catch {
    /* the next refresh retries */
  }
}

// ---------- forms ----------

function renderShop() {
  const info = $('form-info').elements;
  info.preparingMessage.value = shop.preparingMessage;
  info.readyMessage.value = shop.readyMessage;
  const numbers = $('form-numbers').elements;
  numbers.maxNumber.value = shop.maxNumber;
  numbers.expireHours.value = shop.expireHours;
  numbers.lateAfterMinutes.value = shop.lateAfterMinutes;
  numbers.dayStartHour.value = String(shop.dayStartHour ?? 0);
  $('tz-note').textContent = `توقيت الفرع: ${shop.timezone ?? 'توقيت مصر (الافتراضي)'}. لو الفرع في بلد تانية كلّم Aurexis تغيّره.`;
  $('pos-only').checked = Boolean(shop.posOnly);
  for (const radio of document.querySelectorAll('input[name="qrMode"]')) radio.checked = radio.value === shop.qrMode;
  const printable = shop.qrMode !== 'dynamic';
  $('static-actions').hidden = !printable;
  $('rotate-help').hidden = !printable;
  renderLogo();
  renderAccent();
}

function bindForms() {
  $('form-info').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const ok = await save({
      preparingMessage: f.preparingMessage.value,
      readyMessage: f.readyMessage.value,
    }, e.target);
    if (ok) toast('الرسايل اتحفظت');
  });

  $('form-numbers').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const ok = await save({
      maxNumber: Number(f.maxNumber.value),
      expireHours: Number(f.expireHours.value),
      lateAfterMinutes: Number(f.lateAfterMinutes.value),
      dayStartHour: Number(f.dayStartHour.value),
    }, e.target);
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
  $('day-start').innerHTML = Array.from({ length: 13 }, (_, h) => `<option value="${h}">${hourLabel(h)}</option>`).join('');
  renderShop();
  bindLogo();
  bindAccent();
  bindForms();
  bindPos();
  await loadPos();
  setInterval(loadPos, 15_000);
}

boot();

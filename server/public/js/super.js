import { ago, branchCardHtml } from './dashboard.js';
import { openForm, showResult } from './forms.js';
import { icons } from './icons.js';
import { toast } from './staff.js';
import { api, esc } from './util.js';

const POLL_MS = 10_000;
const ACTIVITY_PAGE = 15;
const FEATURE_LABEL = { review: 'التقييم بعد الاستلام', loyalty: 'كارت الولاء', promo: 'مساحة الإعلان' };
const $ = (id) => document.getElementById(id);

let overview = null;
let activity = [];
let activityShown = ACTIVITY_PAGE;

const post = (path, body = {}) => api(`/api/super${path}`, { method: 'POST', body });
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const allBranches = () => overview.brands.flatMap((b) => b.branches);
const findBranch = (id) => allBranches().find((b) => b.id === id);
const findBrand = (id) => overview.brands.find((b) => b.id === id);

// ---------- login ----------

function showLogin() {
  const root = $('login-root');
  root.innerHTML = `
    <form class="login" novalidate>
      <h1>لوحة الإدارة</h1>
      <p class="muted">اكتب كلمة السر</p>
      <input class="input" name="password" type="password" autocomplete="current-password" aria-label="كلمة السر" required>
      <p class="form-error" hidden></p>
      <button class="btn btn-primary btn-block" type="submit">دخول</button>
    </form>`;
  const form = root.querySelector('form');
  form.elements.password.focus();
  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = form.querySelector('.form-error');
      try {
        await api('/api/super/login', { method: 'POST', body: { password: form.elements.password.value } });
        root.innerHTML = '';
        resolve();
      } catch (err) {
        error.textContent = err.status === 404 ? 'لوحة الإدارة مقفولة (SUPER_PASSWORD_HASH مش متظبط)' : err.message;
        error.hidden = false;
        form.elements.password.select();
      }
    });
  });
}

// ---------- "محتاج منك" ----------

function attentionItems() {
  const items = [];
  for (const brand of overview.brands) {
    if (!brand.owners.length) {
      items.push({ text: `${brand.name}: مفيش حساب لصاحب البراند`, act: 'owner', id: brand.id, label: 'اعمل حساب' });
    }
    if (!brand.branches.length) {
      items.push({ text: `${brand.name}: البراند لسه ملوش فروع`, act: 'branch', id: brand.id, label: 'ضيف فرع' });
    }
    for (const b of brand.branches) {
      const { status, daysLeft, reason } = b.plan;
      if (status === 'suspended') {
        const why = reason === 'manual' ? 'إنت موقّفه' : reason === 'trial_ended' ? 'التجربة خلصت' : 'الدفع اتأخر';
        items.push({ tone: 'alert', text: `${b.name}: متوقف (${why})، والعملاء مش قادرين ياخدوا أرقام`,
          act: reason === 'manual' ? 'resume' : 'payment', id: b.id, label: reason === 'manual' ? 'شغّله' : 'سجّل دفعة' });
      } else if (status === 'past_due') {
        items.push({ tone: 'alert', text: `${b.name}: متأخر في الدفع، وهيتوقف بعد ${daysLeft} يوم`, act: 'payment', id: b.id, label: 'سجّل دفعة' });
      } else if (status === 'trial' && daysLeft <= 1) {
        items.push({ text: `${b.name}: التجربة بتخلص ${daysLeft === 0 ? 'النهارده' : 'بكرة'}`, act: 'payment', id: b.id, label: 'سجّل دفعة' });
      }
      // Low internal ratings this week (1-2 stars): worth a call to the owner.
      const low = b.lowRatings7d ?? [];
      if (low.length) {
        const quote = low.find((r) => r.comment)?.comment;
        items.push({ text: `${b.name}: ${low.length === 1 ? 'تقييم واطي' : `${low.length} تقييمات واطية`} الأسبوع ده${quote ? ` («${quote.slice(0, 60)}»)` : ''}` });
      }
    }
  }
  const dayAgo = Date.now() - 86400000;
  const failed = activity.filter((e) => e.action === 'super.login_failed' && e.at > dayAgo).length;
  if (failed >= 3) items.push({ tone: 'alert', text: `${failed} محاولات دخول غلط للوحة الإدارة في آخر 24 ساعة` });
  // Urgent (red) first.
  return items.sort((a, b) => (b.tone === 'alert') - (a.tone === 'alert'));
}

function renderAttention() {
  const items = attentionItems();
  $('attention').innerHTML = items.length
    ? items.map((it) => `
        <li data-tone="${it.tone ?? ''}">
          <span>${esc(it.text)}</span>
          ${it.act ? `<button class="btn btn-sm" data-act="${it.act}" data-id="${esc(it.id)}" type="button">${esc(it.label)}</button>` : ''}
        </li>`).join('')
    : '<li class="all-good">كل الفروع تمام، مفيش حاجة محتاجة منك دلوقتي.</li>';
}

// ---------- brands ----------

function renderBrands() {
  const now = overview.serverNow;
  if (!overview.brands.length) {
    $('brands').innerHTML = '<p class="empty-note">مفيش براندات لسه. ابدأ بـ «براند جديد» فوق.</p>';
    return;
  }
  $('brands').innerHTML = overview.brands.map((brand) => {
    const owner = brand.owners[0];
    const cards = brand.branches.map((b) => branchCardHtml(b, {
      now,
      actions: `
        <button class="btn btn-sm btn-primary" data-act="enter" data-id="${esc(b.id)}" data-page="bar" type="button">ادخل الفرع</button>
        <button class="btn btn-sm" data-act="enter" data-id="${esc(b.id)}" data-page="settings" type="button">الإعدادات</button>
        <button class="btn btn-sm btn-quiet" data-act="menu" data-id="${esc(b.id)}" type="button">المزيد</button>`,
    })).join('');
    return `
      <section class="brand-section">
        <div class="dash-head">
          <div>
            <h2>${esc(brand.name)}</h2>
            <p class="sub">${owner ? `صاحب البراند: <span dir="ltr">${esc(owner.username)}</span>` : 'مفيش حساب لصاحب البراند'}</p>
          </div>
          <div class="actions">
            <button class="btn btn-sm btn-quiet" data-act="owner" data-id="${esc(brand.id)}" type="button">${owner ? 'كلمة سر صاحب البراند' : 'حساب صاحب البراند'}</button>
            <button class="btn btn-sm" data-act="branch" data-id="${esc(brand.id)}" type="button">فرع جديد</button>
          </div>
        </div>
        ${cards ? `<div class="cards">${cards}</div>` : '<p class="empty-note">البراند ده لسه ملوش فروع.</p>'}
      </section>`;
  }).join('');
}

// ---------- activity ----------

const ACTION_TEXT = {
  'super.login': () => 'دخول لوحة الإدارة',
  'super.login_failed': () => 'محاولة دخول غلط للوحة الإدارة',
  'brand.create': (e) => `براند جديد${e.detail?.name ? `: ${e.detail.name}` : ''}`,
  'branch.create': (e) => `فرع جديد${e.detail?.name ? `: ${e.detail.name}` : ''}`,
  'owner.create': (e) => `حساب صاحب البراند (${e.detail?.username ?? ''})`,
  'owner.reset': (e) => `كلمة سر جديدة لصاحب البراند (${e.detail?.username ?? ''})`,
  'owner.login': () => 'دخول صفحة البراند',
  'branch.rename': (e) => `تغيير اسم الفرع لـ «${e.detail?.name ?? ''}»`,
  'branch.pin_reset': () => 'رقم سري جديد للموظفين',
  'branch.trial_extend': (e) => `مدّ التجربة ${e.detail?.days ?? ''} يوم`,
  'branch.payment': (e) => `دفعة ${e.detail?.amountEgp ?? ''} جنيه (من ${e.detail?.periodStart ?? ''} لحد ${e.detail?.periodEnd ?? ''})`,
  'branch.suspend': () => 'إيقاف الفرع',
  'branch.resume': () => 'تشغيل الفرع تاني',
  'feature.force_off': (e) => `قفل خاصية: ${FEATURE_LABEL[e.detail?.feature] ?? e.detail?.feature ?? ''}`,
  'feature.release': (e) => `رجّع خاصية لصاحب البراند: ${FEATURE_LABEL[e.detail?.feature] ?? ''}`,
  'branch.impersonate': () => 'دخول الفرع من لوحة الإدارة',
};

function actorText(actor, e) {
  // A failed login is someone who did NOT know the password: never "you".
  if (e.action === 'super.login_failed') return e.ip ? `حد من ${e.ip}` : 'حد';
  if (actor === 'super') return 'إنت';
  if (actor === 'cli') return 'سطر الأوامر';
  if (actor === 'admin-token') return 'Admin API';
  if (actor.startsWith('owner:')) {
    const id = Number(actor.slice(6));
    const owner = overview.brands.flatMap((b) => b.owners).find((o) => o.id === id);
    return owner ? `صاحب البراند (${owner.username})` : 'صاحب البراند';
  }
  return actor;
}

function targetText(e) {
  if (e.action === 'brand.create' || e.action === 'branch.create') return ''; // the name is already in the text
  if (e.branch_id) return findBranch(e.branch_id)?.name ?? e.branch_id;
  if (e.brand_id) return findBrand(e.brand_id)?.name ?? e.brand_id;
  return '';
}

function renderActivity() {
  const showLogins = $('show-logins').checked;
  const list = activity.filter((e) => showLogins || !['super.login', 'owner.login'].includes(e.action));
  const now = Date.now();
  $('activity').innerHTML = list.slice(0, activityShown).map((e) => {
    const target = targetText(e);
    return `
      <li data-tone="${e.action === 'super.login_failed' ? 'alert' : ''}">
        <span class="who" ${e.ip && e.action === 'super.login_failed' ? 'dir="auto"' : ''}>${esc(actorText(e.actor, e))}</span>
        <span class="what">${esc((ACTION_TEXT[e.action] ?? (() => e.action))(e))}${target ? `<span class="muted">، ${esc(target)}</span>` : ''}</span>
        <time class="muted" datetime="${new Date(e.at).toISOString()}" title="${esc(new Date(e.at).toLocaleString('ar-EG'))}">${esc(ago(e.at, now))}</time>
      </li>`;
  }).join('') || '<li class="muted">مفيش عمليات لسه</li>';
  $('activity-more').hidden = list.length <= activityShown;
}

// ---------- data ----------

async function refresh() {
  try {
    const [o, a] = await Promise.all([api('/api/super/overview'), api('/api/super/audit?limit=200')]);
    overview = o;
    activity = a.entries;
    renderAttention();
    renderBrands();
    renderActivity();
  } catch (err) {
    if (err.status === 401) location.reload();
  }
}

async function done(message) {
  toast(message);
  await refresh();
}

// ---------- actions ----------

// Super enters any branch directly: a 1h staff session (audited), then the page opens.
// The tab is opened inside the click, before the request, so popup blockers allow it.
async function enterBranch(id, page) {
  const tab = window.open('about:blank', '_blank');
  try {
    await post(`/branches/${encodeURIComponent(id)}/impersonate`);
    const url = `/${page}/${encodeURIComponent(id)}`;
    if (tab) tab.location.href = url;
    else location.href = url;
    refresh();
  } catch (err) {
    tab?.close();
    toast(err.message, 'error');
  }
}

function newBrand() {
  openForm({
    title: 'براند جديد',
    intro: 'بعد البراند هتضيف فروعه، وتعمل حساب لصاحبه.',
    fields: [
      { name: 'name', label: 'اسم البراند', placeholder: 'كافيه إكس' },
      { name: 'id', label: 'المعرّف (حروف إنجليزي صغيرة، بيظهر في الروابط)', dir: 'ltr', placeholder: 'cafex' },
    ],
    submit: 'اعمل البراند',
    onSubmit: async (v) => {
      await post('/brands', { id: v.id.trim(), name: v.name });
      await done('البراند اتعمل');
    },
  });
}

function newBranch(brandId) {
  openForm({
    title: 'فرع جديد',
    intro: 'الفرع بيبدأ بتجربة مجانية، وبعد كده بتسجّل الدفع من «المزيد».',
    fields: [
      { name: 'name', label: 'اسم الفرع', placeholder: 'كافيه إكس الكوربة' },
      { name: 'area', label: 'المنطقة', placeholder: 'الكوربة' },
      { name: 'id', label: 'المعرّف', dir: 'ltr', value: `${brandId}-` },
      { name: 'pin', label: 'الرقم السري للموظفين (4–8 أرقام)', inputmode: 'numeric', dir: 'ltr' },
    ],
    submit: 'اعمل الفرع',
    onSubmit: async (v) => {
      const { urls } = await post(`/brands/${encodeURIComponent(brandId)}/branches`, { ...v, id: v.id.trim() });
      await done('الفرع اتعمل');
      showResult({ title: 'روابط الفرع (ابعتها للمحل)', lines: [['البار', urls.bar], ['شاشة الكود', urls.qr], ['الإعدادات', urls.settings]] });
    },
  });
}

function ownerAccount(brandId) {
  const owner = findBrand(brandId)?.owners[0];
  openForm({
    title: owner ? 'كلمة سر جديدة لصاحب البراند' : 'حساب صاحب البراند',
    intro: owner
      ? 'الجلسات القديمة هتقفل. سيب كلمة السر فاضية عشان تتعمل تلقائي.'
      : 'صاحب البراند بيدخل يشوف فروعه بس. سيب كلمة السر فاضية عشان تتعمل تلقائي.',
    fields: [
      { name: 'username', label: 'اسم المستخدم', dir: 'ltr', value: owner?.username ?? '' },
      ...(owner ? [] : [{ name: 'email', label: 'الإيميل (اختياري)', type: 'email', dir: 'ltr' }]),
      { name: 'password', label: 'كلمة السر (اختياري)', type: 'text', dir: 'ltr' },
    ],
    submit: 'احفظ',
    onSubmit: async (v) => {
      const body = { username: v.username.trim(), email: v.email || null };
      if (v.password) body.password = v.password;
      const res = await post(`/brands/${encodeURIComponent(brandId)}/owners`, body);
      await done('اتحفظ');
      showResult({ title: 'بيانات دخول صاحب البراند', lines: [['الرابط', res.loginUrl], ['اسم المستخدم', res.owner.username], ['كلمة السر', res.password]] });
    },
  });
}

function branchMenu(id) {
  const b = findBranch(id);
  if (!b) return;
  const manualStop = b.plan.status === 'suspended' && b.plan.reason === 'manual';
  const items = [
    ['payment', 'سجّل دفعة'],
    ['trial', 'مدّ التجربة'],
    ['qr', 'افتح شاشة الكود'],
    ['rename', 'غيّر الاسم'],
    ['pin', 'رقم سري جديد للموظفين'],
    ['features', 'الخصائص'],
    [manualStop ? 'resume' : 'suspend', manualStop ? 'شغّل الفرع تاني' : 'وقّف الفرع'],
  ];
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <h2 id="sheet-title">${esc(b.name)}</h2>
      <div class="sheet-actions menu-list">
        ${items.map(([k, label]) => `<button class="btn btn-block ${k === 'suspend' ? 'btn-danger' : ''}" data-op="${k}" type="button">${esc(label)}</button>`).join('')}
        <button class="btn btn-quiet btn-block" data-op="close" type="button">رجوع</button>
      </div>
    </div>`;
  document.body.append(backdrop);
  backdrop.addEventListener('click', (e) => {
    const op = e.target.closest('[data-op]')?.dataset.op;
    if (e.target !== backdrop && !op) return;
    backdrop.remove();
    if (op && op !== 'close') branchAction(op, b);
  });
}

function branchAction(op, b) {
  const path = `/branches/${encodeURIComponent(b.id)}`;
  if (op === 'qr') {
    enterBranch(b.id, 'qr');
  } else if (op === 'rename') {
    openForm({
      title: 'اسم الفرع', fields: [{ name: 'name', label: 'الاسم', value: b.name }],
      onSubmit: async (v) => { await post(`${path}/rename`, v); await done('الاسم اتغيّر'); },
    });
  } else if (op === 'pin') {
    openForm({
      title: 'رقم سري جديد للموظفين', intro: 'كل أجهزة البار هتخرج وتحتاج الرقم الجديد.',
      fields: [{ name: 'pin', label: 'الرقم السري (4–8 أرقام)', inputmode: 'numeric', dir: 'ltr' }],
      onSubmit: async (v) => { await post(`${path}/pin`, v); await done('الرقم السري اتغيّر'); },
    });
  } else if (op === 'trial') {
    openForm({
      title: 'مدّ التجربة', fields: [{ name: 'days', label: 'كام يوم زيادة؟', type: 'number', value: '7', dir: 'ltr' }],
      onSubmit: async (v) => { await post(`${path}/trial`, { days: Number(v.days) }); await done('التجربة اتمدّت'); },
    });
  } else if (op === 'payment') {
    openForm({
      title: `دفعة: ${b.name}`,
      intro: 'الفرع بيفضل شغّال لحد آخر يوم في الفترة.',
      fields: [
        { name: 'amountEgp', label: 'المبلغ (جنيه)', type: 'number', dir: 'ltr' },
        { name: 'periodStart', label: 'من يوم', type: 'date', value: today(), dir: 'ltr' },
        { name: 'periodEnd', label: 'لحد يوم', type: 'date', value: plusDays(30), dir: 'ltr' },
        { name: 'note', label: 'ملاحظة (اختياري)' },
      ],
      submit: 'سجّل الدفعة',
      onSubmit: async (v) => {
        await post(`${path}/payments`, { ...v, amountEgp: Number(v.amountEgp) });
        await done('الدفعة اتسجلت');
      },
    });
  } else if (op === 'features') {
    openForm({
      title: 'الخصائص',
      intro: 'صاحب البراند بيشغّل الخصائص ويقفلها. من هنا تقدر تقفل أي خاصية حتى لو هو مشغّلها.',
      fields: Object.keys(FEATURE_LABEL).map((f) => ({
        name: f, label: FEATURE_LABEL[f], type: 'select',
        value: b.forcedOff.includes(f) ? 'off' : 'owner',
        options: [{ value: 'owner', label: 'حسب صاحب البراند' }, { value: 'off', label: 'مقفولة من الإدارة' }],
      })),
      onSubmit: async (v) => {
        for (const f of Object.keys(FEATURE_LABEL)) {
          const forcedOff = v[f] === 'off';
          if (forcedOff !== b.forcedOff.includes(f)) await post(`${path}/features`, { feature: f, forcedOff });
        }
        await done('الخصائص اتحفظت');
      },
    });
  } else if (op === 'suspend') {
    openForm({
      title: `وقّف ${b.name}؟`, intro: 'العملاء مش هيقدروا ياخدوا أرقام جديدة، والطلبات المفتوحة هتكمل عادي.',
      submit: 'وقّف الفرع', danger: true,
      onSubmit: async () => { await post(`${path}/suspend`); await done('الفرع اتوقف'); },
    });
  } else if (op === 'resume') {
    post(`${path}/resume`).then(() => done('الفرع اشتغل تاني')).catch((err) => toast(err.message, 'error'));
  }
}

function onAction(el) {
  const { act, id, page } = el.dataset;
  if (act === 'enter') enterBranch(id, page);
  else if (act === 'menu') branchMenu(id);
  else if (act === 'branch') newBranch(id);
  else if (act === 'owner') ownerAccount(id);
  else if (act === 'payment' || act === 'resume') {
    const b = findBranch(id);
    if (b) branchAction(act, b);
  }
}

// ---------- boot ----------

async function boot() {
  for (;;) {
    try {
      await api('/api/super/overview');
      break;
    } catch (err) {
      if (err.status !== 401 && err.status !== 404) throw err;
      await showLogin();
    }
  }
  $('app').hidden = false;
  $('logout').innerHTML = icons.logout(22);
  await refresh();
  setInterval(refresh, POLL_MS);

  $('new-brand').addEventListener('click', newBrand);
  $('logout').addEventListener('click', async () => {
    await api('/api/super/logout', { method: 'POST' });
    location.reload();
  });
  for (const id of ['brands', 'attention']) {
    $(id).addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (el) onAction(el);
    });
  }
  $('show-logins').addEventListener('change', () => {
    activityShown = ACTIVITY_PAGE;
    renderActivity();
  });
  $('activity-more').addEventListener('click', () => {
    activityShown += ACTIVITY_PAGE;
    renderActivity();
  });
}

boot().catch((err) => {
  $('login-root').innerHTML = `<p class="login">${esc(err.message)}</p>`;
});

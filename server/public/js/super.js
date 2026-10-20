import { branchCardHtml } from './dashboard.js';
import { openForm, showResult } from './forms.js';
import { icons } from './icons.js';
import { toast } from './staff.js';
import { api, esc } from './util.js';

const POLL_MS = 10_000;
const FEATURE_LABEL = { review: 'التقييم بعد الاستلام', loyalty: 'كارت الولاء', promo: 'مساحة الإعلان' };
const $ = (id) => document.getElementById(id);
let overview = null;

const post = (path, body = {}) => api(`/api/super${path}`, { method: 'POST', body });
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

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
      }
    });
  });
}

// ---------- render ----------

function render() {
  const now = overview.serverNow;
  $('updated').textContent = `آخر تحديث ${new Date().toLocaleTimeString('ar-EG')}`;
  if (!overview.brands.length) {
    $('brands').innerHTML = '<p class="empty-note">مفيش براندات لسه. ابدأ بـ «براند جديد».</p>';
    return;
  }
  $('brands').innerHTML = overview.brands.map((brand) => {
    const owners = brand.owners.length ? brand.owners.map((o) => esc(o.username)).join('، ') : 'مفيش حساب مالك';
    const cards = brand.branches.map((b) => branchCardHtml(b, {
      now,
      actions: `<button class="btn btn-sm" data-act="menu" data-branch="${esc(b.id)}" type="button">إجراءات</button>
                <a class="btn btn-sm btn-quiet" href="/bar/${encodeURIComponent(b.id)}" target="_blank" rel="noopener">البار</a>`,
    })).join('');
    return `
      <section class="brand-section" data-brand="${esc(brand.id)}">
        <div class="dash-head">
          <div><h2>${esc(brand.name)}</h2><p class="sub"><span dir="ltr">${esc(brand.id)}</span>، المالك: ${owners}</p></div>
          <div class="actions">
            <button class="btn btn-sm" data-act="owner" data-brand="${esc(brand.id)}" type="button">حساب المالك</button>
            <button class="btn btn-sm btn-primary" data-act="branch" data-brand="${esc(brand.id)}" type="button">فرع جديد</button>
          </div>
        </div>
        ${cards ? `<div class="cards">${cards}</div>` : '<p class="empty-note">البراند ده لسه ملوش فروع.</p>'}
      </section>`;
  }).join('');
}

async function refresh() {
  try {
    overview = await api('/api/super/overview');
    render();
  } catch (err) {
    if (err.status === 401) location.reload();
  }
}

async function loadAudit() {
  const { entries } = await api('/api/super/audit?limit=50');
  $('audit').innerHTML = entries.map((e) => `
    <tr>
      <td class="num">${esc(new Date(e.at).toLocaleString('ar-EG'))}</td>
      <td dir="ltr">${esc(e.actor)}</td>
      <td dir="ltr">${esc(e.action)}</td>
      <td dir="ltr">${esc([e.brand_id, e.branch_id].filter(Boolean).join(' / '))}</td>
      <td dir="ltr">${esc(e.detail ? JSON.stringify(e.detail) : '')}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">مفيش عمليات لسه</td></tr>';
}

const findBranch = (id) => overview.brands.flatMap((b) => b.branches).find((b) => b.id === id);

async function done(message) {
  toast(message);
  await Promise.all([refresh(), loadAudit()]);
}

// ---------- actions ----------

function newBrand() {
  openForm({
    title: 'براند جديد',
    fields: [
      { name: 'id', label: 'المعرّف (إنجليزي)', dir: 'ltr', placeholder: 'cafex' },
      { name: 'name', label: 'الاسم', placeholder: 'كافيه إكس' },
    ],
    submit: 'اعمل البراند',
    onSubmit: async (v) => {
      await post('/brands', v);
      await done('البراند اتعمل');
    },
  });
}

function newBranch(brandId) {
  openForm({
    title: 'فرع جديد',
    intro: `المعرّف لازم يبدأ بـ ${brandId}-، والفرع بيبدأ بتجربة مجانية.`,
    fields: [
      { name: 'id', label: 'المعرّف', dir: 'ltr', value: `${brandId}-` },
      { name: 'name', label: 'اسم الفرع' },
      { name: 'area', label: 'المنطقة' },
      { name: 'pin', label: 'الرقم السري للموظفين', inputmode: 'numeric', dir: 'ltr' },
    ],
    submit: 'اعمل الفرع',
    onSubmit: async (v) => {
      const { urls } = await post(`/brands/${encodeURIComponent(brandId)}/branches`, v);
      await done('الفرع اتعمل');
      showResult({ title: 'روابط الفرع', lines: [['البار', urls.bar], ['شاشة الكود', urls.qr], ['الإعدادات', urls.settings]] });
    },
  });
}

function ownerAccount(brandId) {
  openForm({
    title: 'حساب المالك',
    intro: 'لو اسم المستخدم موجود، كلمة السر بتتغير والجلسات القديمة بتقفل. سيب كلمة السر فاضية عشان تتعمل تلقائي.',
    fields: [
      { name: 'username', label: 'اسم المستخدم', dir: 'ltr' },
      { name: 'email', label: 'الإيميل (اختياري)', type: 'email', dir: 'ltr' },
      { name: 'password', label: 'كلمة السر (اختياري)', type: 'text', dir: 'ltr' },
    ],
    submit: 'احفظ الحساب',
    onSubmit: async (v) => {
      const body = { username: v.username.trim(), email: v.email || null };
      if (v.password) body.password = v.password;
      const res = await post(`/brands/${encodeURIComponent(brandId)}/owners`, body);
      await done('حساب المالك اتحفظ');
      showResult({ title: 'بيانات الدخول', lines: [['الرابط', res.loginUrl], ['اسم المستخدم', res.owner.username], ['كلمة السر', res.password]] });
    },
  });
}

function branchMenu(id) {
  const b = findBranch(id);
  if (!b) return;
  const suspended = b.plan.status === 'suspended' && b.plan.reason === 'manual';
  const items = [
    ['impersonate', 'افتح كفرع (ساعة)'],
    ['rename', 'غيّر الاسم'],
    ['pin', 'رقم سري جديد للموظفين'],
    ['trial', 'مدّ التجربة'],
    ['payment', 'سجّل دفعة'],
    ['features', 'الخصائص'],
    [suspended ? 'resume' : 'suspend', suspended ? 'شغّل الفرع تاني' : 'وقّف الفرع'],
  ];
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <h2 id="sheet-title">${esc(b.name)}</h2>
      <p class="muted" dir="ltr">${esc(b.id)}</p>
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
  if (op === 'impersonate') {
    post(`${path}/impersonate`).then(({ url }) => {
      loadAudit();
      window.open(url, '_blank', 'noopener');
    }).catch((err) => toast(err.message, 'error'));
  } else if (op === 'rename') {
    openForm({
      title: 'اسم الفرع', fields: [{ name: 'name', label: 'الاسم', value: b.name }],
      onSubmit: async (v) => { await post(`${path}/rename`, v); await done('الاسم اتغيّر'); },
    });
  } else if (op === 'pin') {
    openForm({
      title: 'رقم سري جديد', intro: 'كل أجهزة البار هتخرج وتحتاج الرقم الجديد.',
      fields: [{ name: 'pin', label: 'الرقم السري (4–8 أرقام)', inputmode: 'numeric', dir: 'ltr' }],
      onSubmit: async (v) => { await post(`${path}/pin`, v); await done('الرقم السري اتغيّر'); },
    });
  } else if (op === 'trial') {
    openForm({
      title: 'مدّ التجربة', fields: [{ name: 'days', label: 'عدد الأيام', type: 'number', value: '7', dir: 'ltr' }],
      onSubmit: async (v) => { await post(`${path}/trial`, { days: Number(v.days) }); await done('التجربة اتمدّت'); },
    });
  } else if (op === 'payment') {
    openForm({
      title: 'تسجيل دفعة',
      fields: [
        { name: 'amountEgp', label: 'المبلغ (جنيه)', type: 'number', dir: 'ltr' },
        { name: 'periodStart', label: 'من', type: 'date', value: today(), dir: 'ltr' },
        { name: 'periodEnd', label: 'لحد', type: 'date', value: plusDays(30), dir: 'ltr' },
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
      intro: 'صاحب البراند بيشغّل ويقفل الخصائص. من هنا تقدر تقفل أي خاصية غصب عنه.',
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
      title: 'وقّف الفرع', intro: 'العملاء مش هيقدروا ياخدوا أرقام جديدة، والطلبات المفتوحة هتكمل عادي.',
      submit: 'وقّف الفرع', danger: true,
      onSubmit: async () => { await post(`${path}/suspend`); await done('الفرع اتوقف'); },
    });
  } else if (op === 'resume') {
    post(`${path}/resume`).then(() => done('الفرع اشتغل تاني')).catch((err) => toast(err.message, 'error'));
  }
}

// ---------- boot ----------

async function boot() {
  for (;;) {
    try {
      overview = await api('/api/super/overview');
      break;
    } catch (err) {
      if (err.status !== 401 && err.status !== 404) throw err;
      await showLogin();
    }
  }
  $('app').hidden = false;
  $('logout').innerHTML = icons.logout(22);
  render();
  loadAudit();
  setInterval(refresh, POLL_MS);

  $('new-brand').addEventListener('click', newBrand);
  $('audit-refresh').addEventListener('click', loadAudit);
  $('logout').addEventListener('click', async () => {
    await api('/api/super/logout', { method: 'POST' });
    location.reload();
  });
  $('brands').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'menu') branchMenu(el.dataset.branch);
    if (el.dataset.act === 'branch') newBranch(el.dataset.brand);
    if (el.dataset.act === 'owner') ownerAccount(el.dataset.brand);
  });
}

boot().catch((err) => {
  $('login-root').innerHTML = `<p class="login">${esc(err.message)}</p>`;
});


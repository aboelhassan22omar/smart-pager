import { mountAnalytics } from './analytics.js';
import { applyTheme } from './color.js';
import { appInviteText, branchCardHtml, devicesHtml } from './dashboard.js';
import { openForm } from './forms.js';
import { icons } from './icons.js';
import { toast } from './staff.js';
import { api, esc, shopIdFromPath } from './util.js';

const POLL_MS = 30_000;
const $ = (id) => document.getElementById(id);
const brandId = shopIdFromPath(location.pathname);
const base = `/api/brand/${encodeURIComponent(brandId)}`;
let data = null;
let appView = null;

function showLogin() {
  const root = $('login-root');
  root.innerHTML = `
    <form class="login login-account" novalidate>
      <h1>دخول صاحب البراند</h1>
      <input class="input" name="username" dir="ltr" autocomplete="username" placeholder="اسم المستخدم" aria-label="اسم المستخدم" required>
      <input class="input" name="password" type="password" autocomplete="current-password" placeholder="كلمة السر" aria-label="كلمة السر" required>
      <p class="form-error" hidden></p>
      <button class="btn btn-primary btn-block" type="submit">دخول</button>
    </form>`;
  const form = root.querySelector('form');
  form.elements.username.focus();
  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = form.querySelector('.form-error');
      try {
        const res = await api('/api/brand/login', {
          method: 'POST',
          body: { username: form.elements.username.value.trim(), password: form.elements.password.value },
        });
        // An owner always lands on their own brand.
        if (res.brandId !== brandId) {
          location.href = `/brand/${encodeURIComponent(res.brandId)}`;
          return;
        }
        root.innerHTML = '';
        resolve();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    });
  });
}

// ---------- sections: a tab bar on phones, pills in the header on wider screens ----------

const TABS = [
  ['branches', 'الفروع', icons.store],
  ['analytics', 'التحليلات', icons.chart],
  ['apps', 'التطبيقات', icons.phone],
  ['account', 'حسابي', icons.user],
];
const TAB_KEY = `sp:owner-tab:${brandId}`;

function renderTabs() {
  for (const nav of document.querySelectorAll('[data-tabs]')) {
    const pills = nav.classList.contains('nav');
    nav.innerHTML = TABS.map(([id, label, icon]) => (pills
      ? `<button class="nav-link" type="button" data-tab="${id}">${icon(18)}${label}</button>`
      : `<button type="button" data-tab="${id}"><span class="tab-icon">${icon(22)}</span>${label}</button>`)).join('');
    nav.addEventListener('click', (e) => {
      const el = e.target.closest('[data-tab]');
      if (el) showTab(el.dataset.tab, { scroll: true });
    });
  }
}

function showTab(id, { scroll = false } = {}) {
  if (!TABS.some(([t]) => t === id)) id = 'branches';
  for (const pane of document.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== id;
  for (const el of document.querySelectorAll('[data-tab]')) {
    const on = el.dataset.tab === id;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    /* private mode */
  }
  if (scroll) window.scrollTo({ top: 0 });
}

function firstTab() {
  const fromHash = location.hash.slice(1);
  if (fromHash) return fromHash;
  try {
    return localStorage.getItem(TAB_KEY) ?? 'branches';
  } catch {
    return 'branches';
  }
}

/** Today in every branch together, above the cards. */
function todayHtml(branches) {
  const sum = (k) => branches.reduce((n, b) => n + (b[k] ?? 0), 0);
  const open = branches.filter((b) => b.screens > 0).length;
  const late = sum('lateToday');
  return `
    <div class="today-tile"><span>طلبات النهارده</span><strong class="num">${sum('ordersToday')}</strong></div>
    <div class="today-tile"><span>مفتوح دلوقتي</span><strong class="num">${sum('openNow')}</strong></div>
    <div class="today-tile"><span>متأخر</span><strong class="num ${late ? 'is-alert' : ''}">${late}</strong></div>
    <p class="today-note"><span class="dot" data-online="${open > 0}"></span>الكاشير مفتوح في ${open} من ${branches.length} ${branches.length === 1 ? 'فرع' : 'فروع'}</p>`;
}

function render() {
  applyTheme(document.documentElement, data.brand.theme);
  $('brand-name').textContent = data.brand.name;
  $('brand-name').title = data.brand.name;
  document.title = `فروعي — ${data.brand.name}`;
  $('owner-line').textContent = data.demo ? 'نسخة الديمو: ده اللي صاحب المحل بيشوفه' : `داخل باسم ${data.owner.username}`;
  const logo = data.branches.find((b) => b.logoUrl)?.logoUrl;
  $('brand-logo').innerHTML = logo ? `<img src="${esc(logo)}" alt="">` : esc(data.brand.name.slice(0, 1));
  $('today').innerHTML = data.branches.length ? todayHtml(data.branches) : '';
  renderAccount();
  const now = Date.now();
  $('branches').innerHTML = data.branches.length
    ? `<div class="cards">${data.branches.map((b) => branchCardHtml(b, {
      now,
      actions: `<button class="btn btn-sm" data-act="features" data-branch="${esc(b.id)}" type="button">الخصائص</button>
        <button class="btn btn-sm" data-act="rename" data-branch="${esc(b.id)}" type="button">غيّر الاسم</button>`,
    })).join('')}</div>`
    : '<p class="empty-note">لسه مفيش فروع. كلّم Aurexis عشان نضيفها.</p>';
}

// ---------- account: the owner's own email and phone ----------

const notSet = '<span class="muted">مش متسجّل</span>';

function renderAccount() {
  const o = data.owner;
  // The demo signs visitors in by itself; editing or logging out would only strand them.
  $('account-body').innerHTML = `
    <dl class="account-card">
      <div><dt>اسم المستخدم</dt><dd dir="ltr">${esc(o.username)}</dd></div>
      <div><dt>الإيميل</dt><dd dir="ltr">${o.email ? esc(o.email) : notSet}</dd></div>
      <div><dt>التليفون</dt><dd dir="ltr">${o.phone ? esc(o.phone) : notSet}</dd></div>
    </dl>
    <p class="muted small">الإيميل والتليفون اختياريين. بنستخدمهم عشان نكلمك لو فيه حاجة تخص الفروع أو الاشتراك.</p>
    ${data.demo ? '' : `
    <div class="account-actions">
      <button class="btn btn-primary" data-act="contact" type="button">عدّل الإيميل والتليفون</button>
      <button class="btn btn-quiet" data-act="logout" type="button">${icons.logout(20)}خروج</button>
    </div>`}`;
}

function accountAction(act) {
  if (act === 'logout') {
    api(`${base}/logout`, { method: 'POST' }).finally(() => location.reload());
    return;
  }
  openForm({
    title: 'بياناتك',
    intro: 'الاتنين اختياريين. سيب الخانة فاضية عشان تشيلها.',
    fields: [
      { name: 'email', label: 'الإيميل', type: 'email', dir: 'ltr', value: data.owner.email ?? '', placeholder: 'name@example.com' },
      { name: 'phone', label: 'التليفون', type: 'tel', inputmode: 'tel', dir: 'ltr', value: data.owner.phone ?? '', placeholder: '01xxxxxxxxx' },
    ],
    onSubmit: async (v) => {
      const res = await api(`${base}/account`, { method: 'POST', body: { email: v.email ?? '', phone: v.phone ?? '' } });
      data.owner = res.owner;
      renderAccount();
      toast('اتحفظ');
    },
  });
}

// ---------- cashier app: link + password to forward, and where it is installed ----------

const copyBtn = (value) => `<button class="link-btn" data-copy="${esc(value)}" type="button">انسخ</button>`;

function renderApp() {
  if (!appView) {
    $('app-body').innerHTML = '<p class="empty-note">مش قادرين نجيب بيانات التطبيق دلوقتي. جرّب كمان شوية.</p>';
    return;
  }
  if (!appView.enabled) {
    $('app-body').innerHTML = '<p class="empty-note">تطبيق الكاشير لسه مش متفعّل لبراندك. كلّم Aurexis عشان يتفعّل.</p>';
    return;
  }
  $('app-body').innerHTML = `
    <div class="creds">
      <dl class="creds-list">
        <div><dt>لينك التحميل</dt><dd dir="ltr"><a href="${esc(appView.url)}" target="_blank" rel="noopener">${esc(appView.url.replace(/^https?:\/\//, ''))}</a>${copyBtn(appView.url)}</dd></div>
        <div><dt>الباسورد</dt><dd dir="ltr">${appView.password ? `<span>${esc(appView.password)}</span>${copyBtn(appView.password)}` : '<span class="muted">اسأل Aurexis</span>'}</dd></div>
      </dl>
      <button class="btn btn-sm btn-primary" data-act="invite" type="button">انسخ رسالة لمديرين الفروع</button>
    </div>
    <p class="muted">ابعت الرسالة دي لمديرين الفروع. كل فرع بينزّل التطبيق على جهاز الكاشير (أندرويد أو ويندوز)، ويختار فرعه ويكتب الرقم السري بتاعه. أي جهاز تفصله بيرجع يطلب الفرع والرقم السري.</p>
    ${devicesHtml(appView, data.branches, {
      actions: (d) => `
        <button class="link-btn" data-act="device-rename" data-device="${esc(d.id)}" type="button">غيّر الاسم</button>
        <button class="link-btn" data-act="device-revoke" data-device="${esc(d.id)}" type="button">افصل</button>`,
    })}`;
}

async function loadApp() {
  try {
    appView = await api(`${base}/app`);
  } catch {
    appView = null;
  }
  renderApp();
}

function appAction(el) {
  const act = el.dataset.act;
  if (el.dataset.copy !== undefined) {
    navigator.clipboard?.writeText(el.dataset.copy).then(() => toast('اتنسخ'), () => {});
    return;
  }
  if (act === 'invite') {
    navigator.clipboard?.writeText(appInviteText(appView, data.brand.name)).then(() => toast('الرسالة اتنسخت'), () => {});
    return;
  }
  const device = appView.devices.find((d) => d.id === el.dataset.device);
  if (!device) return;
  const path = `${base}/devices/${encodeURIComponent(device.id)}`;
  if (act === 'device-rename') {
    openForm({
      title: 'اسم الجهاز',
      fields: [{ name: 'name', label: 'الاسم', value: device.name, placeholder: 'مثلًا: كاشير 1', maxlength: 40 }],
      onSubmit: async (v) => {
        await api(`${path}/rename`, { method: 'POST', body: { name: v.name } });
        await loadApp();
      },
    });
  } else if (act === 'device-revoke') {
    openForm({
      title: `افصل «${device.name}»؟`,
      intro: 'التطبيق على الجهاز ده هيرجع يطلب الفرع والرقم السري. استخدمها لو الجهاز اتسرق أو اتغيّر.',
      submit: 'افصل',
      danger: true,
      onSubmit: async () => {
        await api(`${path}/revoke`, { method: 'POST', body: {} });
        toast('الجهاز اتفصل');
        await loadApp();
      },
    });
  }
}

const FORCED_HINT = 'مقفولة من الإدارة';

/** One feature switch; a feature the super forced off is shown but can't be changed. */
function featureToggle(b, feature, label, hint) {
  const forced = b.forcedOff.includes(feature);
  return { name: `ff_${feature}`, type: 'toggle', label, hint: forced ? FORCED_HINT : hint, value: b.toggles[feature], disabled: forced };
}

/** Extra fields per feature, filled in by the loyalty and promo phases. */
function featureFields(b) {
  const reviewHint = `خاص بفرع ${b.name} بس، ومن هنا بس بيتحط. من Google Business Profile بتاع الفرع ← اطلب تقييمات ← انسخ اللينك`;
  return [
    { type: 'heading', label: 'التقييم' },
    featureToggle(b, 'review', 'التقييم بعد الاستلام', 'نجوم لينا وزرار تقييم جوجل، لكل العملاء'),
    {
      name: 'googlePlaceId', label: 'لينك تقييم جوجل للفرع ده', dir: 'ltr', value: b.legacyReviewUrl ?? b.googlePlaceId ?? '',
      placeholder: 'https://g.page/r/…/review', hint: reviewHint,
    },
    { type: 'heading', label: 'بطاقة الختم' },
    featureToggle(b, 'loyalty', 'ختم مع كل طلب', 'العميل بياخد ختم لما يستلم، وهدية كل كام طلب'),
    { name: 'loyaltyEvery', label: 'الهدية كل كام طلب', type: 'number', inputmode: 'numeric', dir: 'ltr', value: b.loyaltyEvery, hint: 'من 2 لـ 20' },
    { name: 'loyaltyRewardText', label: 'الهدية', value: b.loyaltyRewardText, placeholder: 'مثلًا: مشروب ببلاش', maxlength: 60 },
    { type: 'heading', label: 'عرض وقت الانتظار' },
    featureToggle(b, 'promo', 'عرض تحت رقم الطلب', 'بيظهر بس وهو مستني طلبه'),
    { name: 'promoText', label: 'نص العرض', type: 'textarea', value: b.promoText, maxlength: 120, placeholder: 'مثلًا: جرّب الكرواسون الجديد' },
    {
      name: 'promoImage', label: 'صورة العرض', type: 'file', accept: 'image/png,image/jpeg,image/webp',
      hint: b.promoImageUrl ? 'فيه صورة دلوقتي. اختار صورة تانية عشان تغيّرها' : 'PNG أو JPG أو WEBP، أقل من 500 كيلوبايت',
    },
    ...(b.promoImageUrl ? [{ name: 'promoImageRemove', type: 'toggle', label: 'شيل الصورة', value: false }] : []),
    { name: 'promoStartsAt', label: 'يبدأ من (اختياري)', type: 'date', dir: 'ltr', value: b.promoStartsAt ?? '' },
    { name: 'promoEndsAt', label: 'لحد (اختياري)', type: 'date', dir: 'ltr', value: b.promoEndsAt ?? '' },
  ];
}

function featureBody(b, v) {
  const features = {};
  for (const f of ['review', 'loyalty', 'promo']) {
    if (!b.forcedOff.includes(f)) features[f] = v[`ff_${f}`] === 'on';
  }
  return {
    features,
    googlePlaceId: v.googlePlaceId ?? '',
    loyaltyEvery: Number(v.loyaltyEvery),
    loyaltyRewardText: v.loyaltyRewardText ?? '',
    promoText: v.promoText ?? '',
    promoStartsAt: v.promoStartsAt ?? '',
    promoEndsAt: v.promoEndsAt ?? '',
  };
}

function openFeatures(b) {
  openForm({
    title: `خصائص ${b.name}`,
    intro: 'كل خاصية تقدر تشغلها أو تقفلها في أي وقت، والبيانات بتفضل محفوظة.',
    fields: featureFields(b),
    onSubmit: async (v) => {
      const branchBase = `${base}/branches/${encodeURIComponent(b.id)}`;
      const image = v.promoImage instanceof File && v.promoImage.size ? v.promoImage : null;
      if (image && image.size > 500 * 1024) {
        throw Object.assign(new Error('الصورة لازم تكون أقل من 500 كيلوبايت'), { data: { field: 'promoImage' } });
      }
      await api(`${branchBase}/settings`, { method: 'POST', body: featureBody(b, v) });
      if (image) await api(`${branchBase}/promo-image`, { method: 'POST', raw: image, contentType: image.type });
      else if (v.promoImageRemove === 'on') await api(`${branchBase}/promo-image`, { method: 'DELETE', body: {} });
      toast('اتحفظ');
      await refresh();
    },
  });
}

async function refresh() {
  try {
    data = await api(`${base}/overview`);
    render();
    await loadApp();
  } catch (err) {
    if (err.status === 401) location.reload();
  }
}

async function boot() {
  for (;;) {
    try {
      data = await api(`${base}/overview`);
      break;
    } catch (err) {
      if (err.status !== 401) throw err;
      await showLogin();
    }
  }
  $('app').hidden = false;
  document.body.classList.add('has-tabbar');
  renderTabs();
  showTab(firstTab());
  addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  render();
  await loadApp();
  mountAnalytics($('analytics'), { base, branches: data.branches });
  $('app-body').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act], [data-copy]');
    if (el) appAction(el);
  });
  setInterval(refresh, POLL_MS);

  $('account-body').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el) accountAction(el.dataset.act);
  });
  $('branches').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const branch = data.branches.find((b) => b.id === el.dataset.branch);
    if (el.dataset.act === 'features') {
      openFeatures(branch);
      return;
    }
    openForm({
      title: 'اسم الفرع',
      intro: 'الاسم ده بيظهر للعملاء على شاشة الطلب وشاشة الكود.',
      fields: [{ name: 'name', label: 'الاسم', value: branch.name }],
      onSubmit: async (v) => {
        await api(`${base}/branches/${encodeURIComponent(branch.id)}/settings`, { method: 'POST', body: { name: v.name } });
        toast('الاسم اتغيّر');
        await refresh();
      },
    });
  });
}

boot().catch((err) => {
  $('login-root').innerHTML = `<p class="login">${esc(err.message)}</p>`;
});

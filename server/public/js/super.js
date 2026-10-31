import { ago, appInviteText, branchCardHtml, devicesHtml, PLATFORM_LABEL } from './dashboard.js';
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
// The main view shows live brands and branches only; trashed ones live behind the trash icon.
const liveBrands = () => overview.brands.filter((b) => !b.deletedAt);
const liveBranches = (brand) => brand.branches.filter((b) => !b.deletedAt);
const trashedBranches = () => liveBrands().flatMap((brand) => brand.branches.filter((b) => b.deletedAt));
const TRASH_REASON = { manual: 'إنت مسحته', trial_ended: 'التجربة خلصت من غير دفع', brand: 'مع البراند' };
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
  // The demo café's sample ratings and visitors' orders aren't anything to act on.
  for (const brand of liveBrands().filter((b) => !b.demo)) {
    if (!brand.owners.length) {
      items.push({ text: `${brand.name}: مفيش حساب لصاحب البراند`, act: 'owner', id: brand.id, label: 'اعمل حساب' });
    }
    if (!brand.branches.length) {
      items.push({ text: `${brand.name}: البراند لسه ملوش فروع`, act: 'branch', id: brand.id, label: 'ضيف فرع' });
    }
    for (const b of liveBranches(brand)) {
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
  // Trials that ended unpaid go to the trash by themselves; say so for a day.
  const autoTrashed = trashedBranches().filter((b) => b.deletedReason === 'trial_ended' && Date.now() - b.deletedAt < 86400000);
  if (autoTrashed.length) {
    items.push({
      text: `${autoTrashed.map((b) => b.name).join('، ')}: التجربة خلصت من غير دفع، فاتنقل لسلة المهملات`,
      act: 'trash', id: '', label: 'افتح السلة',
    });
  }
  // Backups: nightly at 03:30; a failure or a gap of more than a day and a half needs a look.
  const backup = overview.backup;
  if (backup && !backup.ok) {
    items.push({ tone: 'alert', text: `النسخة الاحتياطية بتاعة ${backup.day} فشلت: ${backup.errors[0] ?? ''}`, act: 'backup', id: '', label: 'جرّب تاني' });
  } else if (backup && Date.now() - backup.at > 36 * 3600_000) {
    items.push({ tone: 'alert', text: `آخر نسخة احتياطية من ${ago(backup.at)}`, act: 'backup', id: '', label: 'اعمل نسخة دلوقتي' });
  }
  // Cashier apps: devices off for a day or more, and page errors from devices.
  for (const brand of liveBrands()) {
    const { staleDevices = [], errors24h = 0 } = brand.appIssues ?? {};
    if (staleDevices.length > 2) {
      items.push({ text: `${brand.name}: ${staleDevices.length} أجهزة كاشير مقفولة من يوم أو أكتر`, act: 'app', id: brand.id, label: 'افتح' });
    } else {
      for (const d of staleDevices) {
        items.push({ text: `${brand.name}: جهاز «${d.name}» في ${d.branchName} مقفول ${ago(d.lastSeenAt)}`, act: 'app', id: brand.id, label: 'افتح' });
      }
    }
    if (errors24h) {
      items.push({ text: `${brand.name}: ${errors24h} ${errors24h === 1 ? 'خطأ' : 'أخطاء'} من أجهزة الكاشير في آخر 24 ساعة`, act: 'app-errors', id: brand.id, label: 'سجل الأخطاء' });
    }
  }
  const dayAgo = Date.now() - 86400000;
  const failed = activity.filter((e) => e.action === 'super.login_failed' && e.at > dayAgo).length;
  if (failed >= 3) items.push({ tone: 'alert', text: `${failed} محاولات دخول غلط للوحة الإدارة في آخر 24 ساعة` });
  // Urgent (red) first.
  return items.sort((a, b) => (b.tone === 'alert') - (a.tone === 'alert'));
}

function renderBackupLine() {
  const b = overview.backup;
  const when = b ? new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' }).format(b.at) : null;
  const offsite = b?.offsite ? (b.offsite.ok ? '، ونسخة برّه السيرفر' : '، والرفع برّه السيرفر فشل') : '';
  $('backup-line').textContent = b
    ? `آخر نسخة احتياطية ${when}، ${b.branches} فرع${offsite}. بتتعمل كل يوم 3:30 الفجر وبتفضل 7 أيام.`
    : 'لسه مفيش نسخة احتياطية. بتتعمل لوحدها كل يوم 3:30 الفجر.';
}

function renderAttention() {
  renderBackupLine();
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

const copyBtn = (value) => `<button class="link-btn" data-copy="${esc(value)}" type="button">انسخ</button>`;

/** Owner login: link, username and password, always on screen, with an edit button. */
function ownerCredsHtml(brand) {
  const owner = brand.owners[0];
  if (!owner) {
    return `
      <div class="creds">
        <p class="muted">مفيش حساب لصاحب البراند لسه.</p>
        <button class="btn btn-sm" data-act="owner" data-id="${esc(brand.id)}" type="button">اعمل حساب</button>
      </div>`;
  }
  const url = `${overview.publicUrl}/brand/${brand.id}`;
  const password = owner.password
    ? `<span>${esc(owner.password)}</span>${copyBtn(owner.password)}`
    : '<span class="muted" dir="rtl">مش معروفة (اتعملت قبل ما نحفظها). دوس تعديل وغيّرها مرة</span>';
  return `
    <div class="creds">
      <dl class="creds-list">
        <div><dt>رابط الدخول</dt><dd dir="ltr"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ''))}</a>${copyBtn(url)}</dd></div>
        <div><dt>اسم المستخدم</dt><dd dir="ltr"><span>${esc(owner.username)}</span>${copyBtn(owner.username)}</dd></div>
        <div><dt>كلمة السر</dt><dd dir="ltr">${password}</dd></div>
      </dl>
      <button class="btn btn-sm" data-act="owner" data-id="${esc(brand.id)}" type="button">تعديل</button>
    </div>`;
}

function pinLineHtml(b) {
  const pin = b.pin
    ? `<strong class="num" dir="ltr">${esc(b.pin)}</strong>${copyBtn(b.pin)}`
    : '<span class="muted">مش معروف (اتعمل قبل ما نحفظه)</span>';
  return `
    <p class="cred-line">
      <span class="muted">الرقم السري للموظفين</span>
      ${pin}
      <button class="link-btn" data-act="pin" data-id="${esc(b.id)}" type="button">تعديل</button>
    </p>`;
}

function renderBrands() {
  const now = overview.serverNow;
  const brands = liveBrands();
  if (!brands.length) {
    $('brands').innerHTML = '<p class="empty-note">مفيش براندات لسه. ابدأ بـ «براند جديد» فوق.</p>';
    return;
  }
  $('brands').innerHTML = brands.map((brand) => {
    const cards = liveBranches(brand).map((b) => branchCardHtml(b, {
      now,
      extra: pinLineHtml(b),
      actions: `
        <button class="btn btn-sm btn-primary" data-act="enter" data-id="${esc(b.id)}" data-page="bar" type="button">ادخل الفرع</button>
        <button class="btn btn-sm" data-act="enter" data-id="${esc(b.id)}" data-page="settings" type="button">الإعدادات</button>
        <button class="btn btn-sm btn-quiet" data-act="menu" data-id="${esc(b.id)}" type="button">المزيد</button>`,
    })).join('');
    const empty = brand.branches.length ? 'كل فروع البراند ده في سلة المهملات.' : 'البراند ده لسه ملوش فروع.';
    return `
      <section class="brand-section">
        <div class="dash-head">
          <h2>${esc(brand.name)}</h2>
          <div class="actions">
            <button class="btn btn-sm" data-act="app" data-id="${esc(brand.id)}" type="button">تطبيق الكاشير${brand.appEnabled ? '' : ' (مقفول)'}</button>
            <button class="btn btn-sm" data-act="branch" data-id="${esc(brand.id)}" type="button">فرع جديد</button>
            <button class="icon-link icon-sm" data-act="trash-brand" data-id="${esc(brand.id)}" type="button"
                    aria-label="انقل البراند لسلة المهملات" title="انقل البراند لسلة المهملات">${icons.trash(18)}</button>
          </div>
        </div>
        ${ownerCredsHtml(brand)}
        ${cards ? `<div class="cards">${cards}</div>` : `<p class="empty-note">${empty}</p>`}
      </section>`;
  }).join('');
}

// ---------- trash ----------

function renderTrashButton() {
  const n = overview.brands.filter((b) => b.deletedAt).length + trashedBranches().length;
  $('trash').innerHTML = `${icons.trash(22)}${n ? `<span class="badge num">${n}</span>` : ''}`;
  $('trash').setAttribute('aria-label', n ? `سلة المهملات (${n})` : 'سلة المهملات');
}

const dayText = (ts) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'numeric', year: 'numeric' }).format(ts);

function openTrash() {
  const rows = [
    ...overview.brands.filter((b) => b.deletedAt).map((brand) => ({
      kind: 'brand', id: brand.id, name: brand.name, at: brand.deletedAt,
      sub: `براند، ومعاه ${brand.branches.filter((b) => b.deletedReason === 'brand').length} فرع`,
    })),
    ...trashedBranches().map((b) => ({
      kind: 'branch', id: b.id, name: b.name, at: b.deletedAt,
      sub: `${findBrand(b.brandId)?.name ?? ''}، ${TRASH_REASON[b.deletedReason] ?? ''}`,
    })),
  ].sort((a, b) => b.at - a.at);
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <h2 id="sheet-title">سلة المهملات</h2>
      <p class="muted">كل البيانات محفوظة. اللي هنا مش بيظهر في اللوحة، والعملاء مش بياخدوا منه أرقام لحد ما ترجّعه.</p>
      <ul class="trash-list">
        ${rows.map((r) => `
          <li>
            <div><strong>${esc(r.name)}</strong><span class="muted">${esc(r.sub)}، ${esc(dayText(r.at))}</span></div>
            <button class="btn btn-sm" data-restore="${r.kind}" data-id="${esc(r.id)}" type="button">رجّع</button>
          </li>`).join('') || '<li class="muted">السلة فاضية.</li>'}
      </ul>
      <div class="sheet-actions"><button class="btn btn-quiet btn-block" data-close type="button">رجوع</button></div>
    </div>`;
  document.body.append(backdrop);
  backdrop.addEventListener('click', (e) => {
    const restore = e.target.closest('[data-restore]');
    if (e.target === backdrop || e.target.closest('[data-close]') || restore) backdrop.remove();
    if (restore) restoreItem(restore.dataset.restore, restore.dataset.id);
  });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') backdrop.remove();
  });
  backdrop.querySelector('[data-close]').focus();
}

function restoreItem(kind, id) {
  const fail = (err) => toast(err.message, 'error');
  if (kind === 'brand') {
    post(`/brands/${encodeURIComponent(id)}/restore`).then(() => done('البراند رجع')).catch(fail);
    return;
  }
  const b = findBranch(id);
  // A trial that ended needs more days, or the branch goes straight back to the trash.
  const trialOver = b && b.paidUntil == null && b.trialEndsAt != null && b.trialEndsAt <= Date.now();
  if (!trialOver) {
    post(`/branches/${encodeURIComponent(id)}/restore`).then(() => done('الفرع رجع')).catch(fail);
    return;
  }
  openForm({
    title: `رجّع ${b.name}`,
    intro: 'التجربة بتاعته خلصت. اديله أيام تجربة زيادة، وبعد كده سجّل الدفعة من «المزيد».',
    fields: [{ name: 'trialDays', label: 'أيام تجربة زيادة', type: 'number', value: '7', dir: 'ltr' }],
    submit: 'رجّع الفرع',
    onSubmit: async (v) => {
      await post(`/branches/${encodeURIComponent(id)}/restore`, { trialDays: Number(v.trialDays) });
      await done('الفرع رجع');
    },
  });
}

// ---------- activity ----------

const ACTION_TEXT = {
  'super.login': () => 'دخول لوحة الإدارة',
  'super.login_failed': () => 'محاولة دخول غلط للوحة الإدارة',
  'brand.create': (e) => `براند جديد${e.detail?.name ? `: ${e.detail.name}` : ''}`,
  'branch.create': (e) => `فرع جديد${e.detail?.name ? `: ${e.detail.name}` : ''}`,
  'owner.create': (e) => `حساب صاحب البراند (${e.detail?.username ?? ''})`,
  'owner.reset': (e) => `كلمة سر جديدة لصاحب البراند (${e.detail?.username ?? ''})`,
  'owner.rename': (e) => `اسم مستخدم جديد لصاحب البراند (${e.detail?.username ?? ''})`,
  'owner.login': () => 'دخول صفحة البراند',
  'branch.trash': (e) => (e.detail?.reason === 'trial_ended' ? 'التجربة خلصت من غير دفع، فالفرع اتنقل لسلة المهملات' : 'نقل الفرع لسلة المهملات'),
  'branch.restore': (e) => `رجوع الفرع من سلة المهملات${e.detail?.trialDays ? ` (تجربة ${e.detail.trialDays} يوم)` : ''}`,
  'brand.trash': () => 'نقل البراند لسلة المهملات',
  'brand.restore': () => 'رجوع البراند من سلة المهملات',
  'app.password': () => 'باسورد لينك تحميل التطبيق',
  'app.icon': () => 'أيقونة تطبيق الكاشير',
  'app.download': (e) => `تحميل التطبيق (${PLATFORM_LABEL[e.detail?.platform] ?? ''})`,
  'device.link': (e) => `جهاز كاشير اتربط: ${e.detail?.name ?? ''} (${PLATFORM_LABEL[e.detail?.platform] ?? ''})`,
  'device.rename': (e) => `اسم جهاز جديد: ${e.detail?.name ?? ''}`,
  'device.revoke': (e) => `فصل جهاز: ${e.detail?.name ?? ''}`,
  'device.reload': (e) => `تحديث شاشة جهاز: ${e.detail?.name ?? ''}`,
  'branch.rename': (e) => `تغيير اسم الفرع لـ «${e.detail?.name ?? ''}»`,
  'branch.pin_reset': () => 'رقم سري جديد للموظفين',
  'branch.trial_extend': (e) => `مدّ التجربة ${e.detail?.days ?? ''} يوم`,
  'branch.payment': (e) => `دفعة ${e.detail?.amountEgp ?? ''} جنيه (من ${e.detail?.periodStart ?? ''} لحد ${e.detail?.periodEnd ?? ''})`,
  'branch.suspend': () => 'إيقاف الفرع',
  'branch.resume': () => 'تشغيل الفرع تاني',
  'feature.force_off': (e) => `قفل خاصية: ${FEATURE_LABEL[e.detail?.feature] ?? e.detail?.feature ?? ''}`,
  'feature.release': (e) => `رجّع خاصية لصاحب البراند: ${FEATURE_LABEL[e.detail?.feature] ?? ''}`,
  'branch.impersonate': () => 'دخول الفرع من لوحة الإدارة',
  'branch.owner_settings': () => 'تعديل خصائص الفرع',
  'feature.enable': (e) => `تشغيل خاصية: ${FEATURE_LABEL[e.detail?.feature] ?? ''}`,
  'feature.disable': (e) => `قفل خاصية: ${FEATURE_LABEL[e.detail?.feature] ?? ''}`,
  'promo.image': () => 'صورة عرض جديدة',
  'backup.run': (e) => `نسخة احتياطية${e.detail?.ok === false ? ' (فيها أخطاء)' : ''}`,
};

function actorText(actor, e) {
  // A failed login is someone who did NOT know the password: never "you".
  if (e.action === 'super.login_failed') return e.ip ? `حد من ${e.ip}` : 'حد';
  if (actor === 'super') return 'إنت';
  if (actor === 'cli') return 'سطر الأوامر';
  if (actor === 'system') return 'تلقائي';
  if (actor === 'download') return 'صفحة التحميل';
  if (actor.startsWith('device:')) return 'جهاز كاشير';
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

// ---------- "دلوقتي": who has what open right now ----------

const num = (n) => String(n ?? 0);

function renderLive() {
  const live = overview.live;
  if (!live) return;
  const demo = live.demo;
  const demoUrl = `${overview.publicUrl}/demo`;
  const tile = (value, label, sub = '') => `
    <div class="live-tile">
      <p class="live-num num">${num(value)}</p>
      <p class="live-label">${label}</p>
      ${sub ? `<p class="live-sub">${sub}</p>` : ''}
    </div>`;
  $('live').innerHTML = `
    ${tile(demo.open, 'فاتحين لينك الديمو', `النهارده ${num(demo.today.visits)} زيارة من ${num(demo.today.visitors)} شخص. من الأول ${num(demo.total.visitors)} شخص`)}
    ${tile(live.bar, 'أجهزة فاتحة الكاشير', live.bar ? `في ${num(live.branches)} فرع` : 'مفيش فرع فاتح دلوقتي')}
    ${tile(live.qr, 'شاشات الكود مفتوحة')}
    ${tile(live.appsOnline, 'تطبيقات كاشير شغالة')}
    ${tile(live.customers, 'عملاء مستنيين طلبهم')}`;
  $('demo-link').innerHTML = `لينك الديمو: <a href="${esc(demoUrl)}" target="_blank" rel="noopener" dir="ltr">${esc(demoUrl)}</a> ${copyBtn(demoUrl)}`;
}

// ---------- data ----------

async function refresh() {
  try {
    const [o, a] = await Promise.all([api('/api/super/overview'), api('/api/super/audit?limit=200')]);
    overview = o;
    activity = a.entries;
    renderLive();
    renderAttention();
    renderBrands();
    renderTrashButton();
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

async function backupNow(button) {
  button.disabled = true;
  try {
    const status = await api('/api/super/backup', { method: 'POST', body: {} });
    await done(status.ok ? `النسخة الاحتياطية اتعملت (${status.branches} فرع)` : 'النسخة اتعملت بس فيه أخطاء');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

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
  if (owner) {
    editOwner(brandId, owner);
    return;
  }
  openForm({
    title: 'حساب صاحب البراند',
    intro: 'صاحب البراند بيدخل يشوف فروعه بس. سيب كلمة السر فاضية عشان تتعمل تلقائي.',
    fields: [
      { name: 'username', label: 'اسم المستخدم', dir: 'ltr' },
      { name: 'email', label: 'الإيميل (اختياري)', type: 'email', dir: 'ltr' },
      { name: 'password', label: 'كلمة السر (اختياري)', type: 'text', dir: 'ltr' },
    ],
    submit: 'احفظ',
    onSubmit: async (v) => {
      const body = { username: v.username.trim(), email: v.email || null };
      if (v.password) body.password = v.password;
      await post(`/brands/${encodeURIComponent(brandId)}/owners`, body);
      await done('الحساب اتعمل، وبياناته ظاهرة تحت اسم البراند');
    },
  });
}

// Username and password in place. Only a new password signs the owner out.
function editOwner(brandId, owner) {
  openForm({
    title: 'بيانات صاحب البراند',
    intro: 'لو غيّرت كلمة السر، صاحب البراند هيخرج ويدخل بالجديدة.',
    fields: [
      { name: 'username', label: 'اسم المستخدم', dir: 'ltr', value: owner.username },
      {
        name: 'password', label: 'كلمة السر (8 حروف على الأقل)', type: 'text', dir: 'ltr',
        value: owner.password ?? '', placeholder: owner.password ? '' : 'اكتب كلمة سر جديدة',
      },
    ],
    submit: 'احفظ',
    onSubmit: async (v) => {
      const body = { username: v.username.trim() };
      if (v.password && v.password !== owner.password) body.password = v.password;
      await post(`/brands/${encodeURIComponent(brandId)}/owners/${owner.id}`, body);
      await done('اتحفظ');
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
    ['features', 'الخصائص'],
    [manualStop ? 'resume' : 'suspend', manualStop ? 'شغّل الفرع تاني' : 'وقّف الفرع'],
    ['trash', 'انقل لسلة المهملات'],
  ];
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <h2 id="sheet-title">${esc(b.name)}</h2>
      <div class="sheet-actions menu-list">
        ${items.map(([k, label]) => `<button class="btn btn-block ${k === 'suspend' || k === 'trash' ? 'btn-danger' : ''}" data-op="${k}" type="button">${esc(label)}</button>`).join('')}
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
      title: 'الرقم السري للموظفين', intro: 'لو غيّرته، كل أجهزة البار هتخرج وتحتاج الرقم الجديد.',
      fields: [{ name: 'pin', label: 'الرقم السري (4–8 أرقام)', inputmode: 'numeric', dir: 'ltr', value: b.pin ?? '' }],
      onSubmit: async (v) => {
        if (v.pin.trim() === b.pin) return;
        await post(`${path}/pin`, { pin: v.pin.trim() });
        await done('الرقم السري اتغيّر');
      },
    });
  } else if (op === 'trash') {
    openForm({
      title: `انقل ${b.name} لسلة المهملات؟`,
      intro: 'الفرع هيختفي من هنا ومن صفحة صاحب البراند، والعملاء مش هيقدروا ياخدوا أرقام. كل بياناته محفوظة وتقدر ترجّعه من السلة.',
      submit: 'انقل للسلة', danger: true,
      onSubmit: async () => { await post(`${path}/trash`); await done('الفرع اتنقل لسلة المهملات'); },
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

// ---------- cashier app ----------

const ICON_SIZES = [432, 256];

/** Square PNG from the logo: background color, logo centered inside the adaptive-icon safe zone. */
async function renderIcon(file, background, size) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    g.fillStyle = background;
    g.fillRect(0, 0, size, size);
    // Android masks the outer third (circle, squircle); Windows shows the whole square.
    const box = size * (size === 432 ? 0.56 : 0.78);
    const scale = Math.min(box / img.naturalWidth, box / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const ERRORS_SHOWN = 15;

/** The devices' error log: newest first, details folded. */
function errorsHtml(errors, all) {
  if (!errors.length) return '<p class="muted">مفيش أخطاء من الأجهزة. أي خطأ أو انقطاع طويل في الاتصال بيظهر هنا.</p>';
  const now = Date.now();
  const rows = (all ? errors : errors.slice(0, ERRORS_SHOWN)).map((e) => `
    <li data-kind="${esc(e.kind)}">
      <details>
        <summary>
          <span class="err-msg">${esc(e.message)}${e.count > 1 ? ` <span class="muted">(${e.count} مرة)</span>` : ''}</span>
          <span class="muted">${esc(e.deviceName)}، ${esc(e.branchName)}، ${esc(ago(e.lastAt, now) ?? '')}</span>
        </summary>
        <pre dir="ltr">${esc([`page: ${e.page ?? '-'}`, `app: ${e.version ?? '-'}`,
          `first: ${new Date(e.firstAt).toLocaleString('en-GB')}`, `last: ${new Date(e.lastAt).toLocaleString('en-GB')}`,
          e.detail ?? ''].join('\n'))}</pre>
      </details>
    </li>`).join('');
  const more = !all && errors.length > ERRORS_SHOWN
    ? `<button class="link-btn" data-op="errors-all" type="button">اعرض الكل (${errors.length})</button>` : '';
  return `<ul class="error-log">${rows}</ul>${more}`;
}

async function appSheet(brandId, { focusErrors = false } = {}) {
  let showAllErrors = false;
  const brand = findBrand(brandId);
  const base = `/brands/${encodeURIComponent(brandId)}`;
  let view;
  try {
    view = await api(`/api/super${base}/app`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const close = () => backdrop.remove();
  const missing = Object.entries(view.platforms).filter(([, p]) => !p.available).map(([k]) => PLATFORM_LABEL[k]);

  const render = () => {
    const branches = liveBranches(findBrand(brandId) ?? brand);
    backdrop.innerHTML = `
      <div class="sheet app-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <h2 id="sheet-title">تطبيق الكاشير: ${esc(brand.name)}</h2>
        <p class="muted">صاحب البراند بيبعت اللينك والباسورد لمديرين الفروع، وكل فرع بينزّل التطبيق على جهاز الكاشير ويدخل بالرقم السري بتاعه.</p>
        ${missing.length ? `<p class="note">نسخة ${esc(missing.join(' و'))} لسه مش على السيرفر، فزرارها مش هيظهر في صفحة التحميل.</p>` : ''}
        ${view.enabled ? `
          <dl class="creds-list app-creds">
            <div><dt>لينك التحميل</dt><dd dir="ltr"><a href="${esc(view.url)}" target="_blank" rel="noopener">${esc(view.url.replace(/^https?:\/\//, ''))}</a>${copyBtn(view.url)}</dd></div>
            <div><dt>الباسورد</dt><dd dir="ltr">${view.password ? `<span>${esc(view.password)}</span>${copyBtn(view.password)}` : '<span class="muted">مش معروف</span>'}
              <button class="link-btn" data-op="password" type="button">تعديل</button></dd></div>
          </dl>
          <button class="btn btn-sm" data-op="invite" type="button">انسخ رسالة جاهزة لصاحب البراند</button>`
        : `<p>اللينك مقفول لحد ما تحط له باسورد.</p>
          <button class="btn btn-primary btn-sm" data-op="password" type="button">حط باسورد وشغّل اللينك</button>`}
        <h3 class="form-heading">أيقونة واسم التطبيق</h3>
        <div class="app-icon-row">
          <img class="app-icon-preview" src="${esc(view.iconUrl)}" alt="" width="64" height="64">
          <div>
            <p>الاسم على الجهاز: <strong>${esc(brand.name)}</strong></p>
            <p class="muted">${view.customIcon ? 'أيقونة البراند' : 'الأيقونة الافتراضية. ارفع لوجو البراند عشان تبقى باسمه وشكله.'}</p>
            <div class="actions">
              <button class="btn btn-sm" data-op="icon" type="button">ارفع اللوجو</button>
              ${view.customIcon ? '<button class="btn btn-sm btn-quiet" data-op="icon-reset" type="button">رجّع الافتراضية</button>' : ''}
            </div>
          </div>
        </div>
        <h3 class="form-heading">الأجهزة</h3>
        ${devicesHtml(view, branches, {
          actions: (d) => `
            ${d.online ? `<button class="link-btn" data-op="reload" data-device="${esc(d.id)}" type="button">حدّث الشاشة</button>` : ''}
            <button class="link-btn" data-op="revoke" data-device="${esc(d.id)}" type="button">افصل</button>`,
        })}
        <h3 class="form-heading" id="app-errors">سجل الأخطاء</h3>
        ${errorsHtml(view.errors ?? [], showAllErrors)}
        <div class="sheet-actions"><button class="btn btn-quiet btn-block" data-op="close" type="button">رجوع</button></div>
      </div>`;
  };

  const reload = async () => {
    view = await api(`/api/super${base}/app`);
    await refresh();
    render();
  };

  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  backdrop.addEventListener('click', async (e) => {
    if (e.target === backdrop) return close();
    const copy = e.target.closest('[data-copy]');
    if (copy) return copyValue(copy.dataset.copy);
    const op = e.target.closest('[data-op]')?.dataset.op;
    if (op === 'close') close();
    else if (op === 'invite') copyValue(appInviteText(view, brand.name));
    else if (op === 'password') {
      openForm({
        title: 'باسورد لينك التحميل',
        intro: 'أي حد عايز ينزّل التطبيق لازم يكتبه. سيبه فاضي عشان يتعمل تلقائي. الأجهزة اللي متركبة مش بتتأثر.',
        fields: [{ name: 'password', label: 'الباسورد (8 حروف على الأقل)', type: 'text', dir: 'ltr', value: view.password ?? '' }],
        onSubmit: async (v) => {
          view = await post(`${base}/app`, v.password ? { password: v.password } : {});
          await refresh();
          render();
          toast('اتحفظ');
        },
      });
    } else if (op === 'icon') {
      openForm({
        title: 'أيقونة التطبيق',
        intro: 'اللوجو بيتحط في نص مربع بلون الخلفية اللي تختاره. الأحسن لوجو PNG بخلفية شفافة.',
        fields: [
          { name: 'logo', label: 'اللوجو', type: 'file', accept: 'image/png,image/jpeg,image/webp' },
          { name: 'background', label: 'لون الخلفية', type: 'color', value: '#ffffff', dir: 'ltr' },
        ],
        submit: 'ارفع',
        onSubmit: async (v) => {
          if (!(v.logo instanceof File) || !v.logo.size) throw Object.assign(new Error('اختار صورة اللوجو'), { data: { field: 'logo' } });
          for (const size of ICON_SIZES) {
            const png = await renderIcon(v.logo, v.background || '#ffffff', size);
            await api(`/api/super${base}/app-icon?size=${size}`, { method: 'POST', raw: png, contentType: 'image/png' });
          }
          await reload();
          toast('الأيقونة اتحفظت. التحميلات الجاية هتبقى بيها');
        },
      });
    } else if (op === 'icon-reset') {
      await api(`/api/super${base}/app-icon`, { method: 'DELETE', body: {} });
      await reload();
    } else if (op === 'reload') {
      const id = e.target.closest('[data-device]').dataset.device;
      try {
        await post(`${base}/devices/${encodeURIComponent(id)}/reload`);
        toast('الشاشة اتحدّثت على الجهاز');
      } catch (err) {
        toast(err.message, 'error');
      }
    } else if (op === 'errors-all') {
      showAllErrors = true;
      render();
    } else if (op === 'revoke') {
      const id = e.target.closest('[data-device]').dataset.device;
      const d = view.devices.find((x) => x.id === id);
      openForm({
        title: `افصل «${d.name}»؟`,
        intro: 'التطبيق على الجهاز ده هيرجع لصفحة اختيار الفرع والرقم السري.',
        submit: 'افصل', danger: true,
        onSubmit: async () => {
          await post(`${base}/devices/${encodeURIComponent(id)}/revoke`);
          await reload();
        },
      });
    }
  });
  render();
  document.body.append(backdrop);
  backdrop.querySelector('[data-op="close"]').focus();
  if (focusErrors) backdrop.querySelector('#app-errors')?.scrollIntoView({ block: 'start' });
}

function trashBrand(id) {
  const brand = findBrand(id);
  openForm({
    title: `انقل ${brand.name} لسلة المهملات؟`,
    intro: 'البراند وكل فروعه هيختفوا من هنا، وصاحب البراند مش هيقدر يدخل، والعملاء مش هياخدوا أرقام. كل البيانات محفوظة وتقدر ترجّعه من السلة.',
    submit: 'انقل للسلة', danger: true,
    onSubmit: async () => { await post(`/brands/${encodeURIComponent(id)}/trash`); await done('البراند اتنقل لسلة المهملات'); },
  });
}

async function copyValue(value) {
  await navigator.clipboard?.writeText(value).catch(() => {});
  toast('اتنسخ');
}

function onAction(el) {
  const { act, id, page } = el.dataset;
  if (el.dataset.copy !== undefined) copyValue(el.dataset.copy);
  else if (act === 'enter') enterBranch(id, page);
  else if (act === 'trash-brand') trashBrand(id);
  else if (act === 'app') appSheet(id);
  else if (act === 'app-errors') appSheet(id, { focusErrors: true });
  else if (act === 'trash') openTrash();
  else if (act === 'pin') {
    const b = findBranch(id);
    if (b) branchAction('pin', b);
  }
  else if (act === 'menu') branchMenu(id);
  else if (act === 'branch') newBranch(id);
  else if (act === 'owner') ownerAccount(id);
  else if (act === 'backup') backupNow(el);
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
  $('trash').addEventListener('click', openTrash);
  $('logout').addEventListener('click', async () => {
    await api('/api/super/logout', { method: 'POST' });
    location.reload();
  });
  $('backup-now').addEventListener('click', (e) => backupNow(e.currentTarget));
  for (const id of ['brands', 'attention', 'demo-link']) {
    $(id).addEventListener('click', (e) => {
      const el = e.target.closest('[data-act], [data-copy]');
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

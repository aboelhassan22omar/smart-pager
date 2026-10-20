import { mountAnalytics } from './analytics.js';
import { branchCardHtml } from './dashboard.js';
import { openForm } from './forms.js';
import { icons } from './icons.js';
import { toast } from './staff.js';
import { api, esc, shopIdFromPath } from './util.js';

const POLL_MS = 30_000;
const $ = (id) => document.getElementById(id);
const brandId = shopIdFromPath(location.pathname);
const base = `/api/brand/${encodeURIComponent(brandId)}`;
let data = null;

function showLogin() {
  const root = $('login-root');
  root.innerHTML = `
    <form class="login" novalidate>
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

function render() {
  $('brand-name').textContent = data.brand.name;
  document.title = `فروعي — ${data.brand.name}`;
  $('owner-line').textContent = `داخل باسم ${data.owner.username}`;
  const now = Date.now();
  $('branches').innerHTML = data.branches.length
    ? `<div class="cards">${data.branches.map((b) => branchCardHtml(b, {
      now,
      actions: `<button class="btn btn-sm" data-act="features" data-branch="${esc(b.id)}" type="button">الخصائص</button>
        <button class="btn btn-sm" data-act="rename" data-branch="${esc(b.id)}" type="button">غيّر الاسم</button>`,
    })).join('')}</div>`
    : '<p class="empty-note">لسه مفيش فروع. كلّم Aurexis عشان نضيفها.</p>';
}

const FORCED_HINT = 'مقفولة من الإدارة';

/** One feature switch; a feature the super forced off is shown but can't be changed. */
function featureToggle(b, feature, label, hint) {
  const forced = b.forcedOff.includes(feature);
  return { name: `ff_${feature}`, type: 'toggle', label, hint: forced ? FORCED_HINT : hint, value: b.toggles[feature], disabled: forced };
}

/** Extra fields per feature, filled in by the loyalty and promo phases. */
function featureFields(b) {
  const reviewHint = !b.googlePlaceId && b.legacyReviewUrl ? 'شغال دلوقتي بالرابط القديم' : 'من Google Business Profile ← اطلب تقييمات';
  return [
    { type: 'heading', label: 'التقييم' },
    featureToggle(b, 'review', 'التقييم بعد الاستلام', 'نجوم لينا وزرار تقييم جوجل، لكل العملاء'),
    {
      name: 'googlePlaceId', label: 'Google Place ID', dir: 'ltr', value: b.googlePlaceId ?? '',
      placeholder: 'ChIJ… أو رابط فيه placeid=', hint: reviewHint,
    },
    { type: 'heading', label: 'بطاقة الختم' },
    featureToggle(b, 'loyalty', 'ختم مع كل طلب', 'العميل بياخد ختم لما يستلم، وهدية كل كام طلب'),
    { type: 'heading', label: 'عرض وقت الانتظار' },
    featureToggle(b, 'promo', 'عرض تحت رقم الطلب', 'بيظهر بس وهو مستني طلبه'),
  ];
}

function featureBody(b, v) {
  const features = {};
  for (const f of ['review', 'loyalty', 'promo']) {
    if (!b.forcedOff.includes(f)) features[f] = v[`ff_${f}`] === 'on';
  }
  return { features, googlePlaceId: v.googlePlaceId ?? '' };
}

function openFeatures(b) {
  openForm({
    title: `خصائص ${b.name}`,
    intro: 'كل خاصية تقدر تشغلها أو تقفلها في أي وقت، والبيانات بتفضل محفوظة.',
    fields: featureFields(b),
    onSubmit: async (v) => {
      await api(`${base}/branches/${encodeURIComponent(b.id)}/settings`, { method: 'POST', body: featureBody(b, v) });
      toast('اتحفظ');
      await refresh();
    },
  });
}

async function refresh() {
  try {
    data = await api(`${base}/overview`);
    render();
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
  $('logout').innerHTML = icons.logout(22);
  render();
  mountAnalytics($('analytics'), { base, branches: data.branches });
  setInterval(refresh, POLL_MS);

  $('logout').addEventListener('click', async () => {
    await api(`${base}/logout`, { method: 'POST' });
    location.reload();
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

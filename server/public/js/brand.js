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
      actions: `<button class="btn btn-sm" data-act="rename" data-branch="${esc(b.id)}" type="button">غيّر الاسم</button>`,
    })).join('')}</div>`
    : '<p class="empty-note">لسه مفيش فروع. كلّم Aurexis عشان نضيفها.</p>';
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
    const el = e.target.closest('[data-act="rename"]');
    if (!el) return;
    const branch = data.branches.find((b) => b.id === el.dataset.branch);
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

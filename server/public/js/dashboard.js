// Rendering shared by /super and /brand/:brand.

import { esc } from './util.js';

export const PLAN_LABEL = {
  trial: 'تجربة',
  active: 'مفعّل',
  past_due: 'متأخر في الدفع',
  suspended: 'متوقف',
};

export function planText(plan) {
  const label = PLAN_LABEL[plan.status] ?? plan.status;
  if (plan.daysLeft == null) return label;
  if (plan.status === 'past_due') return `${label}، بيتوقف بعد ${plan.daysLeft} يوم`;
  return `${label}، فاضل ${plan.daysLeft} يوم`;
}

export function ago(ts, now = Date.now()) {
  if (!ts) return null;
  const m = Math.floor((now - ts) / 60000);
  if (m < 1) return 'دلوقتي';
  if (m < 60) return `من ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `من ${h} ساعة`;
  return `من ${Math.floor(h / 24)} يوم`;
}

const logoHtml = (b) => (b.logoUrl ? `<img src="${esc(b.logoUrl)}" alt="">` : esc(b.name.slice(0, 1)));

function metaLine(b, now) {
  const k = b.screenKinds ?? { bar: b.screens, qr: 0 };
  const parts = b.screens
    ? [k.bar ? `الكاشير مفتوح على ${k.bar} جهاز` : '', k.qr ? `شاشة الكود على ${k.qr}` : ''].filter(Boolean)
    : ['مفيش شاشة مفتوحة'];
  if (b.apps?.linked) parts.push(`التطبيق على ${b.apps.linked} جهاز`);
  const last = ago(b.lastActivityAt, now);
  parts.push(last ? `آخر طلب ${last}` : 'لسه مفيش طلبات');
  if (b.avgRating7d != null) parts.push(`التقييم ${b.avgRating7d.toFixed(1)}`);
  return parts.join('، ');
}

export function branchCardHtml(b, { now, actions = '', extra = '' } = {}) {
  return `
    <article class="branch-card" data-plan="${esc(b.plan.status)}" data-id="${esc(b.id)}">
      <div class="branch-top">
        <span class="branch-logo">${logoHtml(b)}</span>
        <div class="branch-name">
          <strong>${esc(b.name)}</strong>
          ${b.area ? `<span>${esc(b.area)}</span> ` : ''}<span class="branch-id" dir="ltr">${esc(b.id)}</span>
        </div>
      </div>
      <p class="branch-plan"><span class="pill" data-plan="${esc(b.plan.status)}">${esc(planText(b.plan))}</span></p>
      <dl class="stats">
        <div><dt>طلبات النهارده</dt><dd class="num">${b.ordersToday}</dd></div>
        <div><dt>مفتوح دلوقتي</dt><dd class="num">${b.openNow}</dd></div>
        <div><dt>متأخر</dt><dd class="num ${b.lateToday ? 'is-alert' : ''}">${b.lateToday}</dd></div>
      </dl>
      <p class="branch-meta"><span class="dot" data-online="${b.screens > 0}"></span>${esc(metaLine(b, now))}</p>
      ${extra}
      ${actions ? `<div class="card-actions">${actions}</div>` : ''}
    </article>`;
}

// ---------- cashier app (shared by /super and /brand) ----------

export const PLATFORM_LABEL = { android: 'أندرويد', windows: 'ويندوز' };

function deviceStatus(d, now) {
  if (d.needsPin) return { tone: 'alert', text: 'محتاج الرقم السري الجديد' };
  if (d.online) return { tone: 'ok', text: 'شغال دلوقتي' };
  return { tone: '', text: `آخر ظهور ${ago(d.lastSeenAt, now) ?? ''}` };
}

/** The message the owner forwards to branch managers. */
export function appInviteText(view, brandName) {
  return [
    `تطبيق الكاشير بتاع ${brandName}`,
    `اللينك: ${view.url}`,
    `الباسورد: ${view.password ?? '(اسأل صاحب البراند)'}`,
    'افتح اللينك من جهاز الكاشير (أندرويد أو ويندوز)، نزّل التطبيق وثبّته، وبعدين اختار فرعك واكتب الرقم السري بتاع الفرع.',
  ].join('\n');
}

/**
 * Devices grouped by branch, every live branch listed (so "not installed yet" shows).
 * `actions(d)` returns the buttons for one device.
 */
export function devicesHtml(view, branches, { now = Date.now(), actions = () => '' } = {}) {
  const byBranch = new Map(branches.map((b) => [b.id, []]));
  for (const d of view.devices) byBranch.get(d.branchId)?.push(d);
  const installed = branches.filter((b) => byBranch.get(b.id).length).length;
  const rows = branches.map((b) => {
    const list = byBranch.get(b.id);
    const items = list.map((d) => {
      const st = deviceStatus(d, now);
      return `
        <li>
          <div>
            <strong>${esc(d.name)}</strong>
            <span class="muted">${esc(PLATFORM_LABEL[d.platform] ?? d.platform)}${d.model ? `، ${esc(d.model)}` : ''}${d.version ? `، نسخة ${esc(d.version)}` : ''}</span>
          </div>
          <span class="device-state" data-tone="${st.tone}"><span class="dot" data-online="${d.online}"></span>${esc(st.text)}</span>
          <span class="device-actions">${actions(d)}</span>
        </li>`;
    }).join('');
    return `
      <div class="device-branch" data-empty="${!list.length}">
        <h4>${esc(b.name)}</h4>
        ${items ? `<ul class="device-list">${items}</ul>` : '<p class="muted">لسه ماتركبش على أي جهاز</p>'}
      </div>`;
  }).join('');
  return `
    <p class="apps-summary">التطبيق متركب في <strong class="num">${installed}</strong> من <strong class="num">${branches.length}</strong> فرع،
      والتحميلات: أندرويد <span class="num">${view.downloads.android.count}</span>، ويندوز <span class="num">${view.downloads.windows.count}</span></p>
    <div class="device-branches">${rows}</div>`;
}

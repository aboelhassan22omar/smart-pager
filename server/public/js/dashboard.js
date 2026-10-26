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
  const parts = [b.screens ? `${b.screens} شاشة متصلة` : 'مفيش شاشة متصلة'];
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

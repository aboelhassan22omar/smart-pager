// Customer stamp card (DESIGN §18.5): "3 من 5", and the reward when one is waiting.
// Stamps come only from staff handing over an order; nothing here depends on reviews.

import { icons } from './icons.js';
import { esc } from './util.js';

/**
 * @param card         {every, stamps, rewardText, rewards} from GET /loyalty (or the SSE event)
 * @param orderReward  the reward attached to the current order ({text, redeemed}) or null
 * @param closed       the current order is closed
 */
export function loyaltyHtml(card, { orderReward = null, closed = false } = {}) {
  const every = Math.max(1, Number(card.every) || 1);
  const stamps = Math.min(every, Math.max(0, Number(card.stamps) || 0));
  let note = '';
  if (orderReward && !orderReward.redeemed && !closed) {
    note = `<p class="loyalty-note is-reward">${icons.gift(18)}<span>عندك مكافأة: <strong>${esc(orderReward.text)}</strong>، قولها للكاشير</span></p>`;
  } else if (orderReward?.redeemed) {
    note = `<p class="loyalty-note">${icons.gift(18)}<span>استلمت مكافأتك، بالهنا</span></p>`;
  } else if (card.rewards > 0) {
    note = `<p class="loyalty-note is-reward">${icons.gift(18)}<span>كسبت <strong>${esc(card.rewardText)}</strong>، هتلاقيها في طلبك الجاي</span></p>`;
  }
  let dots = '';
  for (let i = 1; i <= every; i++) dots += `<i class="stamp${i <= stamps ? ' is-on' : ''}"></i>`;
  return `
    <div class="loyalty-head">
      <p class="loyalty-title">بطاقة الختم</p>
      <p class="loyalty-count"><span class="num">${stamps}</span> من <span class="num">${every}</span></p>
    </div>
    <div class="stamps" role="img" aria-label="${stamps} ختم من ${every}">${dots}</div>
    <p class="loyalty-rule">كل ${every} طلبات: ${esc(card.rewardText)}</p>
    ${note}`;
}

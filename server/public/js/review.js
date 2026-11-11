// After pickup: the Google review button, for every customer (DESIGN §18.4).
//
// NO REVIEW GATING: nothing is asked first, the button is there whatever the customer thinks,
// and nothing (stamps, rewards) depends on it. The page's own stars are gone; a customer who
// wants to tell the management something has «رسالة للإدارة» at the bottom (customer.js).

import { t } from './texts.js';
import { esc } from './util.js';

/** @param googleUrl  the branch's Google review link (or null: nothing to show) */
export function reviewHtml({ googleUrl = null } = {}) {
  if (!googleUrl) return '';
  return `<p class="review-title">${esc(t('review_title'))}</p>
    <a class="btn btn-primary btn-block" id="review-link" href="${esc(googleUrl)}" target="_blank" rel="noopener">${esc(t('review_google'))}</a>`;
}

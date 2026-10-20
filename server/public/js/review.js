// Post-pickup review card (DESIGN §18.4).
//
// NO REVIEW GATING: the Google button is rendered for every customer, at the same time as
// the internal stars, whatever rating they give or don't give. We never ask satisfaction
// first and only send happy customers to Google, and nothing (stamps, rewards) depends on it.

import { icons } from './icons.js';
import { esc } from './util.js';

/**
 * @param googleUrl  the branch's Google review link (or null)
 * @param feedback   internal feedback enabled for the branch
 * @param rating     0 (none yet) .. 5
 * @param sent       internal feedback already submitted
 */
export function reviewHtml({ googleUrl = null, feedback = false, rating = 0, sent = false, comment = '' } = {}) {
  let html = '<p class="review-title">عجبتك التجربة؟</p>';
  if (feedback) {
    html += '<div class="review-stars" role="radiogroup" aria-label="تقييمك من 5">';
    for (let i = 1; i <= 5; i++) {
      html += `<button type="button" class="star${i <= rating ? ' is-on' : ''}" data-rating="${i}" role="radio"
        aria-checked="${i === rating}" aria-label="${i} من 5" ${sent ? 'disabled' : ''}>${icons.star(30)}</button>`;
    }
    html += '</div>';
    if (sent) {
      html += '<p class="review-thanks">شكراً، رأيك وصلنا</p>';
    } else if (rating) {
      html += `<textarea class="input review-comment" id="review-comment" maxlength="500" rows="2"
        placeholder="تحب تقولنا حاجة؟ (اختياري)">${esc(comment)}</textarea>
        <button class="btn btn-block" id="review-send" type="button">ابعت رأيك</button>`;
    } else {
      html += '<p class="review-sub">قيّمنا من 1 لـ 5</p>';
    }
  }
  if (googleUrl) {
    html += `<a class="btn btn-primary btn-block" id="review-link" href="${esc(googleUrl)}" target="_blank" rel="noopener">قيّمنا على جوجل</a>`;
  }
  return html;
}

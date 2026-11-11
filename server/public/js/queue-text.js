// Queue copy for the customer card: "قدامك 2 طلب، حوالي 5–8 دقايق" (each sentence can be
// reworded by the brand, see texts.js). The ETA arrives as absolute times and counts down
// locally (no polling).
import { t } from './texts.js';

export function aheadText(n) {
  if (n === 0) return t('ahead_next');
  if (n === 1) return t('ahead_one');
  if (n === 2) return t('ahead_two');
  return t('ahead_many', { n });
}

export function etaText(eta, now = Date.now()) {
  if (!eta) return '';
  const high = Math.ceil((eta.highAt - now) / 60_000);
  if (high <= 0) return t('eta_soon');
  const low = Math.max(1, Math.ceil((eta.lowAt - now) / 60_000));
  return low >= high ? t('eta_one', { high }) : t('eta_range', { low, high });
}

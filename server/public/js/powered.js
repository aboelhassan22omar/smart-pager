// "Powered by AUREXIS" footer, fixed at the bottom of every page (splash included).
// Not inside a brand's cashier app: that one carries the brand's name only.

import { isCashierApp } from './util.js';

export const AUREXIS_URL = 'https://aurexis.cc/';
// The colored brand mark, same file the aurexis.cc header uses.
export const AUREXIS_LOGO = 'https://aurexis.cc/brand/aurexis-mark.svg';

export function mountPoweredBy(doc) {
  if (doc.getElementById('powered-by')) return doc.getElementById('powered-by');

  const footer = doc.createElement('footer');
  footer.id = 'powered-by';
  footer.className = 'powered-by';
  footer.setAttribute('dir', 'ltr');

  const link = doc.createElement('a');
  link.href = AUREXIS_URL;
  link.target = '_blank';
  link.rel = 'noopener';

  const label = doc.createElement('span');
  label.textContent = 'Powered by';

  const logo = doc.createElement('img');
  logo.src = AUREXIS_LOGO;
  logo.alt = '';
  logo.width = 17;
  logo.height = 16;
  logo.addEventListener('error', () => {
    logo.hidden = true;
  });

  const brand = doc.createElement('strong');
  brand.textContent = 'AUREXIS';

  link.append(label, logo, brand);
  footer.append(link);
  doc.body.append(footer);
  return footer;
}

if (typeof document !== 'undefined' && !isCashierApp(document)) mountPoweredBy(document);

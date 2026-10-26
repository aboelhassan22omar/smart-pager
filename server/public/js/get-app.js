// /app/<brand>: the brand's cashier app download page. Password first, then one button per
// platform (this device's platform first) and the install steps for it.

import { api, esc, shopIdFromPath } from './util.js';

const $ = (id) => document.getElementById(id);
const brandId = shopIdFromPath(location.pathname);

const PLATFORMS = {
  android: {
    button: 'نزّل لأندرويد',
    note: 'موبايل أو تابلت أو جهاز كاشير أندرويد 7 أو أحدث',
    steps: [
      'دوس «نزّل لأندرويد». لو المتصفح قال إن الملف ممكن يكون ضار، دوس «نزّل برضه».',
      'افتح الملف من الإشعار أو من «التنزيلات».',
      'لو ظهر إن التثبيت من المصدر ده مش مسموح: دوس «الإعدادات»، فعّل «السماح من المصدر ده»، وارجع.',
      'دوس «تثبيت». لو Google Play Protect سأل، دوس «تثبيت على أي حال».',
      'افتح التطبيق، اختار الفرع، واكتب الرقم السري بتاع الفرع. خلاص.',
    ],
  },
  windows: {
    button: 'نزّل لويندوز',
    note: 'ويندوز 10 أو 11',
    steps: [
      'دوس «نزّل لويندوز». لو المتصفح سأل، اختار «احتفظ بالملف».',
      'افتح الملف المضغوط ودوس مرتين على البرنامج اللي جواه.',
      'لو ظهرت رسالة «Windows protected your PC»: دوس «More info» وبعدين «Run anyway».',
      'البرنامج بيعمل اختصار على سطح المكتب باسم البراند وبيفتح لوحده.',
      'اختار الفرع، واكتب الرقم السري بتاع الفرع. خلاص.',
    ],
  },
};

function detect() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  return null;
}

function showSteps(platform) {
  $('steps-title').textContent = platform === 'android' ? 'التثبيت على أندرويد' : 'التثبيت على ويندوز';
  $('steps').innerHTML = PLATFORMS[platform].steps.map((s) => `<li>${esc(s)}</li>`).join('');
  for (const card of document.querySelectorAll('.platform')) card.dataset.active = String(card.dataset.platform === platform);
}

function showDownloads(info, links) {
  const here = detect();
  const order = here === 'windows' ? ['windows', 'android'] : ['android', 'windows'];
  $('platforms').innerHTML = order.map((p) => {
    const ready = info.platforms[p]?.available;
    const primary = p === (here ?? order[0]);
    return `
      <article class="platform" data-platform="${p}">
        <div>
          <h2>${esc(p === 'android' ? 'أندرويد' : 'ويندوز')}</h2>
          <p class="muted">${esc(PLATFORMS[p].note)}</p>
        </div>
        ${ready
          ? `<a class="btn ${primary ? 'btn-primary' : ''} btn-block" href="${esc(links[p])}" data-platform="${p}" download>${esc(PLATFORMS[p].button)}</a>`
          : '<p class="muted">لسه مش جاهز، جرّب كمان شوية</p>'}
      </article>`;
  }).join('');
  $('platforms').addEventListener('click', (e) => {
    const card = e.target.closest('.platform');
    if (card) showSteps(card.dataset.platform);
  });
  showSteps(here ?? order[0]);
  $('unlock').hidden = true;
  $('downloads').hidden = false;
  if (!here) {
    $('error').hidden = false;
    $('error').textContent = 'التطبيق للكاشير على أندرويد أو ويندوز. افتح اللينك ده من جهاز الكاشير نفسه.';
  }
}

async function boot() {
  let info;
  try {
    info = await api(`/api/app/${encodeURIComponent(brandId)}`);
  } catch (err) {
    $('error').hidden = false;
    $('error').textContent = err.message;
    return;
  }
  $('brand-name').textContent = info.name;
  document.title = `${info.name}: تطبيق الكاشير`;
  $('icon').src = info.iconUrl;

  const form = $('unlock');
  form.hidden = false;
  form.elements.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const error = form.querySelector('.form-error');
    const button = form.querySelector('button');
    button.disabled = true;
    error.hidden = true;
    try {
      const { links } = await api(`/api/app/${encodeURIComponent(brandId)}/unlock`, {
        method: 'POST', body: { password: form.elements.password.value.trim() },
      });
      showDownloads(info, links);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      form.elements.password.select();
    } finally {
      button.disabled = false;
    }
  });
}

boot();

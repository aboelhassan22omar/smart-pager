import { applyTheme } from './color.js';
import { icons } from './icons.js';
import { loadStaffState, staffEvents } from './staff.js';
import { esc, shopIdFromPath } from './util.js';
import { keepAwake } from './wakelock.js';

const $ = (id) => document.getElementById(id);
const shopId = shopIdFromPath(location.pathname);
const svgUrl = (kind) => `/api/bar/${encodeURIComponent(shopId)}/qr.svg?kind=${kind}&t=${Date.now()}`;
const orderSvgUrl = (id) => `/api/bar/${encodeURIComponent(shopId)}/qr.svg?order=${encodeURIComponent(id)}`;

let qr = null;
let clockOffset = 0;

// ---------- order QR mode: the screen facing the customer shows each new order's own QR ----------

const ORDER_SHOW_MS = 120_000;
const LEAD = 'امسح الكود بكاميرا الموبايل عشان تاخد رقم طلبك';
let orderMode = false;
let orderShare = true;
let shown = null; // { id, number, ref }
let idleTimer = null;

function showIdle() {
  shown = null;
  clearTimeout(idleTimer);
  $('qr-frame').hidden = true;
  $('qr-order').hidden = true;
  $('qr-lead').textContent = 'أهلاً بيك! كود طلبك هيظهر هنا أول ما الكاشير يسجّله';
  $('qr-note').textContent = 'امسحه بكاميرا الموبايل، وموبايلك هيرن أول ما طلبك يجهز.';
}

function showOrder(o) {
  shown = o;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(showIdle, ORDER_SHOW_MS);
  $('qr-frame').hidden = false;
  swapImage($('qr-img'), orderSvgUrl(o.id));
  $('qr-order').hidden = false;
  $('qr-order').textContent = `طلب رقم ${o.ref ?? o.number}`;
  $('qr-lead').textContent = 'امسح الكود عشان تتابع طلبك، وموبايلك يرن أول ما يجهز';
  $('qr-note').textContent = orderShare
    ? 'معاك حد؟ يقدر يمسح نفس الكود ويتابع نفس الطلب.'
    : 'الكود ده لطلبك انت بس.';
}

function swapImage(img, src) {
  const next = new Image();
  next.addEventListener('load', () => {
    img.src = src;
    img.classList.remove('is-swapping');
  });
  img.classList.add('is-swapping');
  next.src = src;
}

function render(state) {
  qr = state.qr;
  clockOffset = qr.serverNow - Date.now();
  applyTheme(document.documentElement, state.shop.theme);
  const logo = $('qr-logo');
  logo.hidden = !state.shop.logoUrl;
  if (state.shop.logoUrl && logo.dataset.src !== state.shop.logoUrl) {
    logo.dataset.src = state.shop.logoUrl;
    logo.innerHTML = '';
    const img = new Image(84, 84);
    img.alt = '';
    img.src = state.shop.logoUrl;
    img.addEventListener('error', () => {
      logo.hidden = true;
    });
    logo.append(img);
  }
  $('shop-name').textContent = state.shop.name;
  $('print-shop').textContent = state.shop.name;
  document.title = `الكود — ${state.shop.name}`;

  orderMode = Boolean(state.shop.orderQr);
  orderShare = state.shop.orderShare !== false;
  if (orderMode) {
    $('countdown').hidden = true;
    $('print').hidden = true;
    if (shown) showOrder(shown);
    else showIdle();
    return;
  }
  clearTimeout(idleTimer);
  shown = null;
  $('qr-frame').hidden = false;
  $('qr-order').hidden = true;
  $('qr-lead').textContent = LEAD;

  const dynamic = qr.mode !== 'static';
  const printable = qr.mode !== 'dynamic';
  swapImage($('qr-img'), svgUrl(dynamic ? 'dynamic' : 'static'));
  $('countdown').hidden = !dynamic;

  $('print').hidden = !printable;
  if (printable) $('print-img').src = svgUrl('static');

  $('qr-note').textContent = {
    dynamic: 'الكود بيتغير بعد كل عميل وكل شوية، عشان محدش يستخدم صورة قديمة منه.',
    static: 'ده الكود الثابت. اطبعه وحطه على الكاونتر.',
    both: 'الكود اللي على الشاشة بيتغير. والكود المطبوع شغّال كمان.',
  }[qr.mode];
}

function tick() {
  if (qr && qr.mode !== 'static' && !orderMode) {
    const left = Math.max(0, qr.expiresAt - (Date.now() + clockOffset));
    const ratio = Math.min(1, left / (qr.rotateSeconds * 1000));
    $('countdown-bar').style.transform = `scaleX(${ratio})`;
    $('countdown-text').textContent = `الكود هيتغير بعد ${Math.ceil(left / 1000)} ثانية`;
  }
  requestAnimationFrame(tick);
}

async function boot() {
  let state;
  try {
    state = await loadStaffState(shopId, $('login-root'));
  } catch (err) {
    $('login-root').innerHTML = `<p class="login">${esc(err.message)}</p>`;
    return;
  }
  $('app').hidden = false;
  $('back').href = `/bar/${encodeURIComponent(shopId)}`;
  $('back').innerHTML = icons.back(22);
  $('print').innerHTML = `${icons.print()}<span>اطبع الكود الثابت</span>`;
  $('print').addEventListener('click', () => window.print());
  render(state);
  requestAnimationFrame(tick);

  keepAwake();
  document.addEventListener('pointerdown', () => keepAwake(), { once: true });

  const reload = async () => {
    try {
      render(await loadStaffState(shopId, $('login-root')));
    } catch {
      /* next event retries */
    }
  };

  staffEvents(
    shopId,
    {
      nonce: (info) => {
        const modeChanged = qr && info.mode !== qr.mode;
        qr = info;
        clockOffset = info.serverNow - Date.now();
        if (orderMode) return;
        if (modeChanged) reload();
        else if (info.mode !== 'static') swapImage($('qr-img'), svgUrl('dynamic'));
        if (info.mode !== 'dynamic') $('print-img').src = svgUrl('static');
      },
      'order-qr': (o) => {
        if (orderMode) showOrder(o);
      },
      // The order on screen was cancelled: back to the welcome.
      order: ({ order }) => {
        if (orderMode && shown && order?.id === shown.id && ['cancelled', 'expired'].includes(order.status)) showIdle();
      },
      shop: reload,
    },
    (online) => {
      if (online) reload();
    },
    { screen: 'qr' },
  );
}

boot();

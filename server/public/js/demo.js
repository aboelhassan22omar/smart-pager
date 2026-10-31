import { api, esc } from './util.js';

// The demo page: frames the real customer, cashier, QR and owner pages of the demo café
// (the server already signed this visitor in as its cashier and owner).

const $ = (id) => document.getElementById(id);
const wide = window.matchMedia('(min-width: 1000px)');
const CLOSED = ['picked', 'expired', 'cancelled'];

let info = null;
let active = null;
let order = null;

// ---------- tabs ----------

function show(pane) {
  if (wide.matches && pane === 'customer') pane = active && active !== 'customer' ? active : 'bar';
  active = pane;
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.pane === pane;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const el of document.querySelectorAll('.pane')) {
    el.hidden = el.dataset.pane !== pane;
    // QR and owner frames load the first time they are opened.
    const frame = el.querySelector('iframe[data-lazy]');
    if (!el.hidden && frame?.dataset.lazy && !frame.getAttribute('src')) frame.src = frame.dataset.lazy;
  }
  if (pane === 'customer') $('tab-customer').removeAttribute('data-badge');
}

function bindTabs() {
  const tabs = $('tabs');
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) show(tab.dataset.pane);
  });
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...tabs.querySelectorAll('.tab')].filter((t) => t.offsetParent);
    const i = all.findIndex((t) => t.dataset.pane === active);
    // RTL: the left arrow goes to the next tab.
    const next = all[(i + (e.key === 'ArrowLeft' ? 1 : -1) + all.length) % all.length];
    show(next.dataset.pane);
    next.focus();
  });
  wide.addEventListener('change', () => show(active));
}

// ---------- the guide line follows the visitor's own order ----------

function guide(html, tone = '') {
  $('guide').innerHTML = html;
  $('guide').dataset.tone = tone;
}

function onOrder(next) {
  const was = order?.status;
  order = next;
  $('new-order').hidden = !CLOSED.includes(order.status);
  const n = `<span class="num">${esc(order.number)}</span>`;
  if (order.status === 'preparing') {
    guide(wide.matches
      ? `معاك رقم ${n}. دوس عليه دوسة واحدة في شاشة الكاشير، وشوف موبايل العميل.`
      : `معاك رقم ${n}. افتح «الكاشير» ودوس على الرقم دوسة واحدة، وبعدين ارجع لـ«العميل».`);
  } else if (order.status === 'ready') {
    guide(`رقم ${n} جاهز وموبايل العميل بيرن دلوقتي. دوسة تانية عند الكاشير يعني العميل استلم.`, 'ready');
    // On a phone the customer screen is behind a tab: bring it up while it rings.
    if (was !== 'ready' && !wide.matches) {
      if (active === 'customer') return;
      $('tab-customer').dataset.badge = '1';
      show('customer');
    }
  } else if (order.status === 'picked') {
    guide('العميل استلم. افتح «صاحب المكان» وشوف عدد الطلبات ووقت التحضير والتقييمات، أو خد رقم جديد.');
  } else {
    guide('الطلب ده اتقفل. خد رقم جديد وجرّب تاني.');
  }
}

// ---------- customer phone ----------

const savedOrder = () => {
  try {
    return localStorage.getItem(`sp:order:${info.shopId}`);
  } catch {
    return null;
  }
};

function openCustomer(path) {
  $('phone-start').hidden = true;
  const frame = $('frame-customer');
  frame.hidden = false;
  frame.src = path;
}

function claim() {
  openCustomer(info.customerPath);
}

async function boot() {
  bindTabs();
  show(wide.matches ? 'bar' : 'customer');
  try {
    info = await api('/api/demo');
  } catch (err) {
    guide(esc(err.message));
    return;
  }
  const shop = encodeURIComponent(info.shopId);
  $('frame-bar').src = `/bar/${shop}`;
  $('frame-qr').dataset.lazy = `/qr/${shop}`;
  $('frame-owner').dataset.lazy = `/brand/${encodeURIComponent(info.brandId)}`;
  if (!active || active === 'qr' || active === 'owner') show(active);

  // A visitor coming back picks their open order up again (or gets a new number when it
  // closed meanwhile); a first visit starts at "scan the code".
  if (savedOrder()) openCustomer(info.customerPath);
  else guide('ابدأ من موبايل العميل: دوس «امسح الكود وخد رقم».');
  $('claim').addEventListener('click', claim);
  $('new-order').addEventListener('click', () => {
    $('new-order').hidden = true;
    claim();
  });

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'sp:order') return;
    onOrder(e.data);
  });

  // Keeps this visitor in the super dashboard's "demo open now" count.
  new EventSource('/api/demo/live');
}

boot();

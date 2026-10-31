import { Chime } from './chime.js';
import { icons } from './icons.js';
import { loadStaffState, staffEvents, toast } from './staff.js';
import { api, elapsedLabel, esc, shopIdFromPath } from './util.js';

const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;
const STATUS_LABEL = { preparing: 'بيتحضّر', ready: 'جاهز' };
const LATE_CHIME_KEY = 'sp:late-chime';

const $ = (id) => document.getElementById(id);
const shopId = shopIdFromPath(location.pathname);
const base = `/api/bar/${encodeURIComponent(shopId)}`;
const chime = new Chime();
const orders = new Map();
const fresh = new Set();
let sheetOrderId = null;
let lateAfterMs = 10 * 60_000;
const lateAlerted = new Set();

const lateChimeOn = () => {
  try {
    return localStorage.getItem(LATE_CHIME_KEY) === '1';
  } catch {
    return false;
  }
};
const isLate = (o, now = Date.now()) => o.status === 'preparing' && now - o.createdAt > lateAfterMs;

// ---------- render ----------

function sorted() {
  return [...orders.values()].sort((a, b) => a.createdAt - b.createdAt);
}

// Loyalty reward attached to the order and not handed over yet.
const hasReward = (o) => Boolean(o.reward && !o.reward.redeemed);

function tileHtml(o) {
  const late = isLate(o);
  const icon = o.status === 'ready' ? icons.bell(14) : icons.clock(14);
  const rings = o.status === 'ready' && o.notifyCount > 1 ? ` ×${o.notifyCount}` : '';
  const label = late ? 'متأخر' : STATUS_LABEL[o.status];
  const gift = hasReward(o);
  return `
    <button class="tile${fresh.has(o.id) ? ' is-new' : ''}${late ? ' is-late' : ''}" role="listitem" type="button"
            data-id="${esc(o.id)}" data-status="${esc(o.status)}"
            aria-label="طلب ${esc(o.number)}، ${esc(label)}${gift ? '، عليه مكافأة' : ''}">
      ${gift ? `<span class="tile-gift" title="عليه مكافأة">${icons.gift(16)}</span>` : ''}
      <span class="tile-num num">${esc(o.number)}</span>
      <span class="tile-foot">
        <span class="tile-status">${icon}${esc(label)}${esc(rings)}</span>
        <span>${esc(elapsedLabel(o.createdAt))}</span>
      </span>
    </button>`;
}

// One chime per order when it crosses the late threshold (only if this screen opted in).
function checkLate() {
  for (const o of orders.values()) {
    if (isLate(o) && !lateAlerted.has(o.id)) {
      lateAlerted.add(o.id);
      if (lateChimeOn()) chime.play('order');
    }
  }
}

function renderGrid() {
  const list = sorted();
  checkLate();
  $('grid').innerHTML = list.map(tileHtml).join('');
  $('empty').hidden = list.length > 0;
  const ready = list.filter((o) => o.status === 'ready').length;
  $('board-meta').textContent = list.length
    ? `${list.length} طلب مفتوح، منهم ${ready} جاهز`
    : '';
  fresh.clear();
}

function upsert(o) {
  if (o.status === 'preparing' || o.status === 'ready') orders.set(o.id, o);
  else orders.delete(o.id);
  if (sheetOrderId === o.id) closeSheet();
  renderGrid();
}

// ---------- actions ----------

async function act(id, path, body) {
  try {
    const updated = await api(`${base}/orders/${encodeURIComponent(id)}/${path}`, { method: 'POST', body: body ?? {} });
    upsert(updated);
    return updated;
  } catch (err) {
    toast(err.message, 'error');
    if (err.status === 404 || err.status === 409) refreshState();
    return null;
  }
}

async function advance(id) {
  const o = orders.get(id);
  if (!o) return;
  const updated = await act(id, 'advance');
  if (updated?.status === 'ready') toast(`رقم ${updated.number} جاهز. بنرن على العميل`);
  if (updated?.status === 'picked') {
    toast(hasReward(o) ? `رقم ${updated.number} اتسلّم. المكافأة متسلّمتش، هتفضل لطلبه الجاي` : `رقم ${updated.number} اتسلّم`);
  }
}

// ---------- long-press sheet ----------

function openSheet(id) {
  const o = orders.get(id);
  if (!o) return;
  sheetOrderId = id;
  $('sheet-title').textContent = `طلب رقم ${o.number}`;
  $('sheet-sub').textContent = `${STATUS_LABEL[o.status]}، ${elapsedLabel(o.createdAt)}`;
  const buttons = $('sheet').querySelectorAll('[data-act]');
  for (const b of buttons) {
    const a = b.dataset.act;
    if (a === 'renotify') {
      b.innerHTML = `${icons.bell()}<span>رنّ على العميل تاني</span>`;
      b.hidden = o.status !== 'ready';
    } else if (a === 'preparing') {
      b.innerHTML = `${icons.undo()}<span>رجّعه للتحضير</span>`;
      b.hidden = o.status !== 'ready';
    } else if (a === 'picked') {
      b.innerHTML = `${icons.bag()}<span>اتسلّم</span>`;
    } else if (a === 'cancelled') {
      b.innerHTML = `${icons.trash()}<span>إلغاء الطلب</span>`;
      b.dataset.confirm = '';
    } else if (a === 'redeem') {
      b.innerHTML = `${icons.gift()}<span>سلّم المكافأة: ${esc(o.reward?.text ?? '')}</span>`;
      b.hidden = !hasReward(o);
    }
  }
  $('sheet').hidden = false;
  $('sheet').querySelector('[data-act="picked"]').focus();
}

function closeSheet() {
  sheetOrderId = null;
  $('sheet').hidden = true;
}

async function onSheetAction(button) {
  const id = sheetOrderId;
  const a = button.dataset.act;
  if (a === 'close' || !id) return closeSheet();
  if (a === 'cancelled' && button.dataset.confirm !== 'armed') {
    button.dataset.confirm = 'armed';
    button.querySelector('span').textContent = 'دوس تاني لتأكيد الإلغاء';
    return undefined;
  }
  closeSheet();
  if (a === 'renotify') {
    const o = await act(id, 'renotify');
    if (o) toast(`رنّينا على رقم ${o.number} تاني`);
  } else if (a === 'redeem') {
    const o = await act(id, 'redeem');
    if (o) toast(`مكافأة رقم ${o.number} اتسجّلت`);
  } else {
    const o = await act(id, 'status', { status: a });
    if (o && a === 'cancelled') toast(`طلب ${o.number} اتلغى`);
  }
  return undefined;
}

// ---------- tap vs long press ----------

function bindGrid() {
  const grid = $('grid');
  let press = null;

  const clear = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press.tile.classList.remove('is-pressing');
    press = null;
  };

  grid.addEventListener('pointerdown', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile || e.button > 0) return;
    unlockSound();
    tile.classList.add('is-pressing');
    press = {
      tile,
      x: e.clientX,
      y: e.clientY,
      long: false,
      timer: setTimeout(() => {
        if (!press) return;
        press.long = true;
        navigator.vibrate?.(15);
        openSheet(tile.dataset.id);
      }, LONG_PRESS_MS),
    };
  });

  grid.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_CANCEL_PX) clear();
  });

  grid.addEventListener('pointerup', (e) => {
    if (!press) return;
    const { tile, long } = press;
    clear();
    if (!long && e.target.closest('.tile') === tile) advance(tile.dataset.id);
  });

  grid.addEventListener('pointercancel', clear);
  grid.addEventListener('contextmenu', (e) => e.preventDefault());

  // Keyboard: Enter/Space advances, Shift+Enter opens the sheet.
  grid.addEventListener('keydown', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    if (e.shiftKey) openSheet(tile.dataset.id);
    else advance(tile.dataset.id);
  });
}

// ---------- sound ----------

// Always on, no button: the chime starts right away where the browser allows it (the cashier
// app, or after typing the PIN), and otherwise on the first touch or key anywhere on the page.
function unlockSound() {
  if (chime.unlocked) return;
  chime.unlock();
}

function keepSoundOn() {
  unlockSound();
  const events = ['pointerdown', 'keydown', 'touchend'];
  const onGesture = () => {
    unlockSound();
    if (chime.unlocked) for (const e of events) document.removeEventListener(e, onGesture, true);
  };
  for (const e of events) document.addEventListener(e, onGesture, true);
}

// ---------- boot ----------

async function refreshState() {
  try {
    const state = await api(`${base}/state`);
    applyState(state);
  } catch (err) {
    if (err.status === 401) location.reload();
  }
}

const PLAN_MESSAGE = {
  suspended: () => 'الخدمة متوقفة مؤقتًا: العملاء مش هيقدروا ياخدوا أرقام جديدة. الطلبات المفتوحة بتكمل عادي. كلّم Aurexis.',
  past_due: (p) => `الاشتراك متأخر. الخدمة هتتوقف بعد ${p.daysLeft} يوم لو ما اتجددتش.`,
  trial: (p) => `فترة تجريبية: فاضل ${p.daysLeft} يوم.`,
};

function renderPlan(plan) {
  const banner = $('plan-banner');
  const message = plan && PLAN_MESSAGE[plan.status];
  banner.hidden = !message;
  if (message) {
    banner.dataset.plan = plan.status;
    banner.textContent = message(plan);
  }
}

function applyState(state) {
  renderPlan(state.plan);
  lateAfterMs = (state.shop.lateAfterMinutes ?? 10) * 60_000;
  $('shop-name').textContent = state.shop.name;
  document.title = `الطلبات — ${state.shop.name}`;
  orders.clear();
  for (const o of state.orders) orders.set(o.id, o);
  renderGrid();
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
  $('link-qr').href = `/qr/${encodeURIComponent(shopId)}`;
  $('link-qr').innerHTML = icons.qr(22);
  $('link-settings').href = `/settings/${encodeURIComponent(shopId)}`;
  $('link-settings').innerHTML = icons.settings(22);
  keepSoundOn();
  applyState(state);
  bindGrid();

  $('sheet').addEventListener('click', (e) => {
    if (e.target === $('sheet')) return closeSheet();
    const button = e.target.closest('[data-act]');
    if (button) onSheetAction(button);
    return undefined;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
  });

  staffEvents(
    shopId,
    {
      order: ({ action, order }) => {
        if (action === 'created') {
          fresh.add(order.id);
          chime.play('order');
        }
        upsert(order);
      },
      shop: (shop) => {
        $('shop-name').textContent = shop.name;
        lateAfterMs = (shop.lateAfterMinutes ?? 10) * 60_000;
        renderGrid();
      },
    },
    (online) => {
      $('dot').dataset.online = String(online);
      $('dot').title = online ? 'متصل' : 'مش متصل';
      if (online) refreshState();
    },
  );

  // Late tiles must turn red on time, so the grid re-renders every 15s.
  setInterval(renderGrid, 15_000);
  const lateToggle = $('late-chime');
  lateToggle.checked = lateChimeOn();
  lateToggle.addEventListener('change', () => {
    try {
      localStorage.setItem(LATE_CHIME_KEY, lateToggle.checked ? '1' : '0');
    } catch {
      /* private mode */
    }
    if (lateToggle.checked) unlockSound();
  });
}

boot();

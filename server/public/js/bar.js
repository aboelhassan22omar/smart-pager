import { Chime } from './chime.js';
import { watchAppUpdates } from './app-update.js';
import { accentFromImage, applyTheme } from './color.js';
import { icons } from './icons.js';
import { loadStaffState, staffEvents, toast } from './staff.js';
import { api, elapsedLabel, esc, holdReloadWhile, reloadOnNewVersion, shopIdFromPath } from './util.js';

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
// What the receipt says: "2-1008" from a POS with several terminals, else the number.
const receiptNo = (o) => o.ref ?? String(o.number);
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
            aria-label="طلب ${esc(receiptNo(o))}${o.receipt ? `، فاتورة ${esc(o.receipt)}` : ''}، ${esc(label)}${gift ? '، عليه مكافأة' : ''}">
      ${gift ? `<span class="tile-gift" title="عليه مكافأة">${icons.gift(16)}</span>` : ''}
      <span class="tile-num num">${esc(receiptNo(o))}</span>
      ${o.receipt ? `<span class="tile-receipt">فاتورة <span class="num">${esc(o.receipt)}</span></span>` : ''}
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
  // Two screens on one branch: an older view (a late reply, a late event) never wins.
  const known = orders.get(o.id);
  if (known && (o.rev ?? 0) < (known.rev ?? 0)) return;
  if (o.status === 'preparing' || o.status === 'ready') orders.set(o.id, o);
  else orders.delete(o.id);
  if (sheetOrderId === o.id) closeSheet();
  renderGrid();
}

// ---------- the count: next and last number, + and − ----------

let lastCounter = null;
function renderCounter(counter) {
  if (!counter) return;
  lastCounter = counter;
  $('count-next').textContent = String(counter.next ?? '—');
  $('count-last').textContent = counter.last == null ? 'لسه مفيش' : String(counter.last);
  $('count-minus').disabled = counter.last == null;
  $('count-waiting').hidden = !counter.waiting;
  $('count-waiting').textContent = counter.waiting
    ? `${manualMode ? 'فواتير' : 'أرقام من السيستم'} مستنية سكان: ${counter.waiting}` : '';
}

// ---------- takeaway numbers typed by the cashier ----------

let manualMode = false;

function setModes(shop) {
  manualMode = Boolean(shop.manualNumbers);
  $('manual').hidden = !manualMode;
  $('manual-help').hidden = !manualMode;
  // Typed receipts make the orders here; «طلب جديد» would skip the receipt.
  $('new-order').hidden = !shop.orderQr || manualMode;
}

async function addReceipt(e) {
  e.preventDefault();
  const input = $('manual-receipt');
  const receipt = input.value.trim();
  if (!receipt) return input.focus();
  const button = $('manual').querySelector('button');
  button.disabled = true;
  try {
    const res = await api(`${base}/receipts`, { method: 'POST', body: { receipt } });
    liveCounter(res.counter);
    if (res.order) upsert(res.order);
    input.value = '';
    toast(res.repeated
      ? `فاتورة ${res.receipt} متسجلة قبل كده، رقمها ${res.number}`
      : `فاتورة ${res.receipt}: رقم التيكاواي ${res.number}`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    input.focus();
  }
  return undefined;
}

// A typed receipt cancelled: the number in the field, «الغي الفاتورة», then the same button
// again to confirm (no browser dialog: the apps don't all show one).
let cancelArmed = null;
async function cancelReceipt() {
  const input = $('manual-receipt');
  const button = $('manual-cancel');
  const receipt = input.value.trim();
  if (!receipt) {
    toast('اكتب رقم الفاتورة اللي عايز تلغيها الأول', 'error');
    return input.focus();
  }
  if (cancelArmed?.receipt !== receipt) {
    clearTimeout(cancelArmed?.timer);
    button.textContent = `متأكد؟ الغي ${receipt}`;
    button.classList.add('btn-danger');
    cancelArmed = {
      receipt,
      timer: setTimeout(() => {
        cancelArmed = null;
        button.textContent = 'الغي الفاتورة';
        button.classList.remove('btn-danger');
      }, 4000),
    };
    return undefined;
  }
  clearTimeout(cancelArmed.timer);
  cancelArmed = null;
  button.textContent = 'الغي الفاتورة';
  button.classList.remove('btn-danger');
  try {
    const res = await api(`${base}/receipts/cancel`, { method: 'POST', body: { receipt } });
    liveCounter(res.counter);
    if (res.order) upsert(res.order);
    input.value = '';
    toast(`فاتورة ${res.receipt} اتلغت (رقم ${res.number})`);
  } catch (err) {
    toast(err.message, 'error');
  }
  return undefined;
}

// Order QR mode: the order exists now; the customer screen shows its QR.
async function newOrder() {
  const button = $('new-order');
  button.disabled = true;
  try {
    const order = await api(`${base}/orders`, { method: 'POST', body: {} });
    upsert(order);
    toast(`طلب رقم ${order.number}: الكود بتاعه ظاهر على شاشة العميل`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// Two screens pressing + together: the live count from the server (an event) is newer than a
// reply that arrives after it, so that reply only shows when no event came in meanwhile.
let counterEvents = 0;
const liveCounter = (counter) => {
  counterEvents++;
  renderCounter(counter);
};

async function adjustCount(delta) {
  const seen = counterEvents;
  try {
    const counter = await api(`${base}/counter`, { method: 'POST', body: { delta } });
    if (counterEvents === seen) renderCounter(counter);
    toast(delta > 0 ? `عدّينا رقم ${counter.last}. الجاي ${counter.next}` : `رجعنا رقم. الجاي ${counter.next}`);
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ kind: 'counter', delta });
      const next = Math.max(1, (Number($('count-next').textContent) || 1) + delta);
      renderCounter({ next, last: next > 1 ? next - 1 : null });
      return;
    }
    toast(err.message, 'error');
    if (err.status === 409) refreshState();
  }
}

// ---------- no connection: taps are kept and sent when it is back ----------

const QUEUE_KEY = `sp:queue:${shopId}`;
const isOffline = (err) => err.status === 0;
let queue = [];
let flushing = false;

try {
  queue = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
} catch {
  queue = [];
}

function saveQueue() {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* private mode: the queue still lives in memory */
  }
  const n = queue.length;
  $('offline').hidden = !n;
  $('offline').textContent = n
    ? `مفيش اتصال بالسيرفر. ${n === 1 ? 'فيه دوسة محفوظة' : n === 2 ? 'فيه دوستين محفوظين' : `فيه ${n} دوسات محفوظة`}، وهيتبعتوا أول ما الاتصال يرجع. العملاء مش هيترن عليهم لحد ساعتها.`
    : '';
}

function enqueue(item) {
  const rid = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  queue.push({ ...item, rid });
  saveQueue();
  toast('اتسجّل على الجهاز، وهيتبعت أول ما الاتصال يرجع');
}

// In order, one at a time. "Already done" (404/409) counts as sent; no connection stops here.
async function flushQueue() {
  if (flushing || !queue.length) return;
  flushing = true;
  try {
    while (queue.length) {
      const item = queue[0];
      try {
        if (item.kind === 'status') {
          await api(`${base}/orders/${encodeURIComponent(item.id)}/status`, { method: 'POST', body: { status: item.status, ...(item.from ? { from: item.from } : {}) } });
        } else {
          await api(`${base}/counter`, { method: 'POST', body: { delta: item.delta }, headers: { 'x-request-id': item.rid } });
        }
      } catch (err) {
        if (isOffline(err)) return;
      }
      queue.shift();
      saveQueue();
    }
    toast('الاتصال رجع، وكل الدوسات اتبعتت');
  } finally {
    flushing = false;
    if (!queue.length) refreshState();
  }
}

// ---------- actions ----------

const NEXT_STATUS = { preparing: 'ready', ready: 'picked' };

async function act(id, path, body) {
  // Every change says what this screen saw, so a second screen can't move the order twice.
  const seen = orders.get(id)?.status;
  try {
    const updated = await api(`${base}/orders/${encodeURIComponent(id)}/${path}`, { method: 'POST', body: { ...(body ?? {}), ...(seen ? { from: seen } : {}) } });
    upsert(updated);
    return updated;
  } catch (err) {
    if (err.status === 409 && err.data?.order) {
      upsert(err.data.order);
      toast(err.message);
      return null;
    }
    // Status changes wait for the connection; the screen moves on right away.
    const o = orders.get(id);
    const status = path === 'advance' ? NEXT_STATUS[o?.status] : body?.status;
    if (isOffline(err) && o && status) {
      enqueue({ kind: 'status', id, status, from: seen });
      upsert({ ...o, status });
      return null;
    }
    toast(err.message, 'error');
    if (err.status === 404 || err.status === 409) refreshState();
    return null;
  }
}

async function advance(id) {
  const o = orders.get(id);
  if (!o) return;
  const updated = await act(id, 'advance');
  if (updated?.status === 'ready') toast(`رقم ${receiptNo(updated)} جاهز. بنرن على العميل`);
  if (updated?.status === 'picked') {
    toast(hasReward(o) ? `رقم ${receiptNo(updated)} اتسلّم. المكافأة متسلّمتش، هتفضل لطلبه الجاي` : `رقم ${receiptNo(updated)} اتسلّم`);
  }
}

// ---------- long-press sheet ----------

function openSheet(id) {
  const o = orders.get(id);
  if (!o) return;
  sheetOrderId = id;
  $('sheet-title').textContent = `طلب رقم ${receiptNo(o)}`;
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
    if (o) toast(`رنّينا على رقم ${receiptNo(o)} تاني`);
  } else if (a === 'redeem') {
    const o = await act(id, 'redeem');
    if (o) toast(`مكافأة رقم ${receiptNo(o)} اتسجّلت`);
  } else {
    const o = await act(id, 'status', { status: a });
    if (o && a === 'cancelled') toast(`طلب ${receiptNo(o)} اتلغى`);
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
  // Taps still waiting to be sent would be undone by the server's older view.
  if (queue.length) return;
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

// Branches whose logo was uploaded before colors could be read from any logo: done once, here,
// because reading the image takes a browser. A branch that chose the default stays on it.
let themeChecked = false;
function readLogoColorOnce(shop) {
  if (themeChecked || !shop.logoUrl || shop.accentColor || shop.themeVersion) return;
  themeChecked = true;
  const img = new Image();
  img.addEventListener('load', async () => {
    const color = accentFromImage(img);
    if (!color) return;
    const res = await api(`${base}/settings`, { method: 'POST', body: { accentColor: color } }).catch(() => null);
    if (res) applyTheme(document.documentElement, res.shop.theme);
  });
  img.src = shop.logoUrl;
}

function applyState(state) {
  applyTheme(document.documentElement, state.shop.theme);
  readLogoColorOnce(state.shop);
  renderPlan(state.plan);
  renderCounter(state.counter);
  lateAfterMs = (state.shop.lateAfterMinutes ?? 10) * 60_000;
  setModes(state.shop);
  $('shop-name').textContent = state.shop.name;
  document.title = `الطلبات — ${state.shop.name}`;
  orders.clear();
  for (const o of state.orders) orders.set(o.id, o);
  renderGrid();
}

async function boot() {
  reloadOnNewVersion();
  let state;
  try {
    state = await loadStaffState(shopId, $('login-root'));
  } catch (err) {
    $('login-root').innerHTML = `<p class="login">${esc(err.message)}</p>`;
    return;
  }
  $('app').hidden = false;
  watchAppUpdates();
  $('link-qr').href = `/qr/${encodeURIComponent(shopId)}`;
  $('link-qr').innerHTML = icons.qr(22);
  $('link-settings').href = `/settings/${encodeURIComponent(shopId)}`;
  $('link-settings').innerHTML = icons.settings(22);
  keepSoundOn();
  applyState(state);
  bindGrid();
  $('count-plus').addEventListener('click', () => adjustCount(1));
  $('new-order').addEventListener('click', newOrder);
  $('manual').addEventListener('submit', addReceipt);
  $('manual-cancel').addEventListener('click', cancelReceipt);
  $('count-minus').addEventListener('click', () => adjustCount(-1));

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
      counter: liveCounter,
      // The super changed this branch (plan, trial, payment, name...): the state, now.
      state: refreshState,
      order: ({ action, order, counter }) => {
        liveCounter(counter);
        if (action === 'created') {
          fresh.add(order.id);
          chime.play('order');
        }
        upsert(order);
      },
      shop: (shop) => {
        $('shop-name').textContent = shop.name;
        applyTheme(document.documentElement, shop.theme);
        lateAfterMs = (shop.lateAfterMinutes ?? 10) * 60_000;
        setModes(shop);
        renderCounter(lastCounter);
        renderGrid();
      },
    },
    (online) => {
      $('dot').dataset.online = String(online);
      $('dot').title = online ? 'متصل' : 'مش متصل';
      if (!online) return;
      if (queue.length) flushQueue();
      else refreshState();
    },
  );
  saveQueue();
  flushQueue();
  // A new version waits for taps made offline to be sent first.
  holdReloadWhile(() => queue.length > 0);

  // Late tiles must turn red on time, so the grid re-renders every 15s.
  setInterval(() => {
    renderGrid();
    flushQueue();
  }, 15_000);
  // The count restarts at midnight with no event to announce it.
  setInterval(refreshState, 60_000);
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

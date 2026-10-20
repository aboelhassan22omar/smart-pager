import { Chime } from './chime.js';
import { icons } from './icons.js';
import { loadStaffState, staffEvents, toast } from './staff.js';
import { api, elapsedLabel, esc, shopIdFromPath } from './util.js';

const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;
const STATUS_LABEL = { preparing: 'بيتحضّر', ready: 'جاهز' };

const $ = (id) => document.getElementById(id);
const shopId = shopIdFromPath(location.pathname);
const base = `/api/bar/${encodeURIComponent(shopId)}`;
const chime = new Chime();
const orders = new Map();
const fresh = new Set();
let sheetOrderId = null;

// ---------- render ----------

function sorted() {
  return [...orders.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function tileHtml(o) {
  const icon = o.status === 'ready' ? icons.bell(14) : icons.clock(14);
  const rings = o.status === 'ready' && o.notifyCount > 1 ? ` ×${o.notifyCount}` : '';
  return `
    <button class="tile${fresh.has(o.id) ? ' is-new' : ''}" role="listitem" type="button"
            data-id="${esc(o.id)}" data-status="${esc(o.status)}"
            aria-label="طلب ${esc(o.number)}، ${esc(STATUS_LABEL[o.status])}">
      <span class="tile-num num">${esc(o.number)}</span>
      <span class="tile-foot">
        <span class="tile-status">${icon}${esc(STATUS_LABEL[o.status])}${esc(rings)}</span>
        <span>${esc(elapsedLabel(o.createdAt))}</span>
      </span>
    </button>`;
}

function renderGrid() {
  const list = sorted();
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
  if (updated?.status === 'picked') toast(`رقم ${updated.number} اتسلّم`);
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

function unlockSound() {
  if (chime.unlocked) return;
  chime.unlock();
  $('sound').hidden = true;
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

function applyState(state) {
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
  $('sound').innerHTML = `${icons.sound(18)}<span>دوس هنا عشان يشتغل صوت الطلبات الجديدة</span>`;
  $('sound').hidden = false;
  $('sound').addEventListener('click', () => {
    unlockSound();
    chime.play('order');
  });
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
      },
    },
    (online) => {
      $('dot').dataset.online = String(online);
      $('dot').title = online ? 'متصل' : 'مش متصل';
      if (online) refreshState();
    },
  );

  setInterval(renderGrid, 30_000);
}

boot();

import { Chime } from './chime.js';
import { applyTheme } from './color.js';
import { icons } from './icons.js';
import { loyaltyHtml } from './loyalty-card.js';
import { aheadText, etaText } from './queue-text.js';
import { applyTexts, setTexts, t } from './texts.js';
import { reviewHtml } from './review.js';
import { api, base64UrlToBytes, elapsedLabel, esc, isIOS, shopIdFromPath, sleep, SPLASH_MIN_MS } from './util.js';
import { keepAwake, releaseAwake } from './wakelock.js';

const CLOSED = ['picked', 'expired', 'cancelled'];
const STATUS_ICON = { preparing: 'clock', ready: 'check', picked: 'check', expired: 'cross', cancelled: 'cross' };
const RING_EVERY_MS = 2600;
const POLL_MS = 10_000;
// POS-only branches: how long the page waits for the cashier's system to send this order.
const POS_WAIT_MS = 45_000;
const MAX_OTHERS = 3;

const $ = (id) => document.getElementById(id);
const shopId = shopIdFromPath(location.pathname);
const params = new URLSearchParams(location.search);
const storageKey = `sp:order:${shopId}`;
// Loyalty device token: lives in an httpOnly cookie, mirrored here in case the cookie is lost.
const deviceKey = `sp:dev:${shopId}`;
// Other open orders of this phone at this branch (a second order while the first is cooking).
const othersKey = `sp:others:${shopId}`;
// Every customer call is scoped to this branch; an order id is only valid under its own branch.
const branchApi = `/api/b/${encodeURIComponent(shopId)}`;
const chime = new Chime();
const startedAt = performance.now();

let shop = null;
let order = null;
let events = null;
let pollTimer = null;
let bannerTimer = null;
let ringing = false;
let loyalty = null; // {every, stamps, rewardText, rewards} while the branch runs a stamp card

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode */
    }
  },
};

// What the receipt says: "2-1008" from a POS with several terminals, else the number.
const label = (o) => o.ref ?? String(o.number);

// This phone's own id for the claim rate limit (phones on mobile data share IPs).
function clientId() {
  let id = store.get('sp:cid');
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    store.set('sp:cid', id);
  }
  return id;
}

function paintLogo(el, size) {
  el.textContent = '';
  if (shop?.logoUrl) {
    const img = new Image(size, size);
    img.alt = '';
    img.src = shop.logoUrl;
    img.addEventListener('error', () => {
      el.textContent = shop.name.slice(0, 1);
    });
    el.append(img);
  } else if (shop) {
    el.textContent = shop.name.slice(0, 1);
  }
}

let splashDone = false;
async function holdSplash() {
  if (splashDone) return;
  splashDone = true;
  const left = SPLASH_MIN_MS - (performance.now() - startedAt);
  if (left > 0) await sleep(left);
  const splash = $('splash');
  splash.classList.add('is-leaving');
  setTimeout(() => {
    splash.hidden = true;
  }, 450);
  const app = $('app');
  app.hidden = false;
  app.classList.add('is-entering');
}

function fatal(message) {
  for (const id of ['card', 'enable', 'pick', 'again', 'waiting']) $(id).hidden = true;
  $('fatal-message').textContent = message;
  $('fatal').hidden = false;
}

// ---------- rendering ----------

function renderQueue() {
  const el = $('card-queue');
  const q = order?.status === 'preparing' ? order.queue : null;
  el.hidden = !q;
  if (!q) return;
  const eta = etaText(q.eta);
  el.innerHTML = `<strong>${esc(aheadText(q.ahead))}</strong>${eta ? `، ${esc(eta)}` : ''}`;
}

// Promo (owner-set): only while preparing, under the number, plain text + image, no links.
function renderPromo() {
  const box = $('card-promo');
  const promo = order?.status === 'preparing' ? shop?.promo : null;
  box.hidden = !promo;
  if (!promo || box.dataset.painted === '1') return;
  box.dataset.painted = '1';
  box.textContent = '';
  if (promo.imageUrl) {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.src = promo.imageUrl;
    box.append(img);
  }
  if (promo.text) {
    const p = document.createElement('p');
    p.textContent = promo.text;
    box.append(p);
  }
}

// Inside the demo page (/demo) the order's state goes up to it, so it can point at this screen.
function tellDemo() {
  if (window.parent === window) return;
  window.parent.postMessage({ type: 'sp:order', id: order.id, number: order.number, status: order.status }, location.origin);
}

function render() {
  tellDemo();
  const card = $('card');
  card.dataset.status = order.status;
  $('card-shop').textContent = order.shopName;
  $('card-number').textContent = label(order);
  // Takeaway numbers typed by the cashier: the receipt it was given for, under the number.
  $('card-receipt').hidden = !order.receipt;
  $('card-receipt').textContent = order.receipt ? `فاتورة ${order.receipt}` : '';
  $('card-message').textContent = order.status === 'picked' ? t('msg_picked') : order.message;
  $('card-icon').innerHTML = icons[STATUS_ICON[order.status] ?? 'clock'](20);
  $('card-when').textContent = elapsedLabel(order.createdAt);
  document.title = `طلب ${label(order)} — ${order.shopName}`;

  const closed = CLOSED.includes(order.status);
  $('enable').hidden = closed || order.status === 'ready';
  $('ios-hint').hidden = closed || order.status === 'ready' || !isIOS(navigator) || isStandalone();
  renderPushHint();
  renderReview();
  renderNote();
  renderQueue();
  renderPromo();
  renderLoyalty();

  if (order.status === 'ready') showReady();
  else hideReady();
}

const deviceHeaders = () => {
  const token = store.get(deviceKey);
  return token ? { 'x-device-token': token } : {};
};

function renderLoyalty() {
  const box = $('loyalty');
  box.hidden = !loyalty || !order;
  if (box.hidden) return;
  box.innerHTML = loyaltyHtml(loyalty, { orderReward: order.reward, closed: CLOSED.includes(order.status) });
}

async function loadLoyalty() {
  if (!shop?.loyalty) return;
  try {
    const card = await api(`${branchApi}/loyalty`, { headers: deviceHeaders() });
    loyalty = card.enabled ? card : null;
  } catch {
    loyalty = null;
  }
  renderLoyalty();
}

// After pickup, every customer gets the Google button (no review gating; see review.js).
let reviewBound = false;

function renderReview() {
  const box = $('review');
  const show = order.status === 'picked' && Boolean(shop?.googleReviewUrl);
  box.hidden = !show;
  if (!show) return;
  box.innerHTML = reviewHtml({ googleUrl: shop.googleReviewUrl });
  if (reviewBound) return;
  reviewBound = true;
  box.addEventListener('click', (e) => {
    if (e.target.closest('#review-link')) {
      navigator.sendBeacon?.(`${branchApi}/orders/${encodeURIComponent(order.id)}/review-click`, '');
    }
  });
}

// «رسالة للإدارة»: its own box at the bottom of the page, on/off per branch. One message per
// order; the brand owner reads them in the analytics. Rebuilt only when its state changes, so
// an order update never wipes what the customer is typing.
const note = { text: '', sent: false, shown: null, bound: false };

function renderNote() {
  const box = $('note');
  const show = Boolean(shop?.messageBox) && !['cancelled', 'expired'].includes(order.status);
  box.hidden = !show;
  if (!show) return;
  if (order.noteSent) note.sent = true;
  const state = note.sent ? 'sent' : 'form';
  if (note.shown === state) return;
  note.shown = state;
  box.innerHTML = note.sent
    ? `<p class="note-title">${esc(t('note_title'))}</p><p class="note-thanks">${esc(t('note_thanks'))}</p>`
    : `<p class="note-title">${esc(t('note_title'))}</p>
       <p class="note-hint">${esc(t('note_hint'))}</p>
       <textarea class="input note-text" id="note-text" maxlength="500" rows="3" placeholder="${esc(t('note_placeholder'))}">${esc(note.text)}</textarea>
       <p class="note-error" id="note-error" role="alert" hidden></p>
       <button class="btn btn-block" id="note-send" type="button">${esc(t('note_send'))}</button>`;
  if (note.bound) return;
  note.bound = true;
  box.addEventListener('input', (e) => {
    if (e.target.id === 'note-text') note.text = e.target.value;
  });
  box.addEventListener('click', async (e) => {
    const send = e.target.closest('#note-send');
    if (!send) return;
    const text = note.text.trim();
    if (!text) {
      $('note-text')?.focus();
      return;
    }
    send.disabled = true;
    try {
      await api(`${branchApi}/orders/${encodeURIComponent(order.id)}/note`, { method: 'POST', body: { text } });
      note.sent = true;
    } catch (err) {
      if (err.status === 409) {
        note.sent = true;
      } else {
        send.disabled = false;
        $('note-error').textContent = err.message;
        $('note-error').hidden = false;
        return;
      }
    }
    renderNote();
  });
}

function showReady() {
  $('ready-mark').innerHTML = icons.check(72);
  $('ready-number').textContent = label(order);
  $('ready-message').textContent = order.message;
  $('ready').hidden = false;
  document.body.classList.add('is-ready');
  const acked = Number(store.get(`sp:ack:${order.id}`) ?? 0);
  if (order.notifyCount > acked) startRinging();
  else $('ready-hint').hidden = true;
}

function hideReady() {
  stopRinging(false);
  $('ready').hidden = true;
  document.body.classList.remove('is-ready');
}

// ---------- alarm ----------

function startRinging() {
  if (ringing) return;
  ringing = true;
  chime.unlock();
  $('ready').classList.add('is-ringing');
  $('ready-hint').hidden = false;
  chime.loop('ready', RING_EVERY_MS, () => navigator.vibrate?.([400, 160, 400, 160, 700]));
  setTimeout(() => {
    document.addEventListener('pointerdown', acknowledge, { once: true });
    document.addEventListener('keydown', acknowledge, { once: true });
  }, 0);
}

function stopRinging(remember = true) {
  if (!ringing) return;
  ringing = false;
  chime.stop();
  navigator.vibrate?.(0);
  $('ready').classList.remove('is-ringing');
  $('ready-hint').hidden = true;
  document.removeEventListener('pointerdown', acknowledge);
  document.removeEventListener('keydown', acknowledge);
  if (remember && order) store.set(`sp:ack:${order.id}`, String(order.notifyCount));
}

function acknowledge() {
  stopRinging(true);
}

// ---------- live updates ----------

function apply(next) {
  const wasOpen = order && !CLOSED.includes(order.status);
  order = next;
  render();
  if (CLOSED.includes(order.status)) {
    // The stream closes here, so the pickup stamp is fetched rather than awaited as an event.
    if (wasOpen && order.status === 'picked') loadLoyalty();
    events?.close();
    events = null;
    stopPolling();
    setOnline(true);
    releaseAwake();
  }
}

function setOnline(online) {
  clearTimeout(bannerTimer);
  if (online) {
    $('banner').hidden = true;
    stopPolling();
    return;
  }
  // Short blips (phone waking up) should not flash the banner.
  bannerTimer = setTimeout(() => {
    $('banner').hidden = false;
  }, 1500);
  if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function refresh() {
  try {
    apply(await api(`${branchApi}/orders/${encodeURIComponent(order.id)}`));
  } catch {
    /* keep polling */
  }
}

function connect() {
  if (!order || CLOSED.includes(order.status)) return;
  events?.close();
  events = new EventSource(`${branchApi}/orders/${encodeURIComponent(order.id)}/events`);
  events.addEventListener('open', () => setOnline(true));
  events.addEventListener('error', () => {
    setOnline(false);
    if (events?.readyState === EventSource.CLOSED) setTimeout(connect, 4000);
  });
  events.addEventListener('order', (e) => apply(JSON.parse(e.data)));
  events.addEventListener('queue', (e) => {
    if (!order) return;
    order.queue = JSON.parse(e.data);
    renderQueue();
  });
  events.addEventListener('loyalty', (e) => {
    loyalty = JSON.parse(e.data);
    renderLoyalty();
  });
  events.addEventListener('renotify', (e) => {
    const next = JSON.parse(e.data);
    apply(next);
    startRinging();
  });
}

// ---------- enable alerts ----------

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isAndroid = () => /Android/i.test(navigator.userAgent);
let pushOn = false;

/** 'ready' (can ask), 'granted', 'denied', or 'unsupported' (in-app browsers, old phones). */
function pushSupport() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  return Notification.permission === 'default' ? 'ready' : Notification.permission;
}

// Opens this same page in Chrome (from WhatsApp, Facebook or a camera app's own browser).
const chromeIntent = () => `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end`;

/**
 * Android only rings when the page is closed or the screen is off if notifications are on, so
 * the page says so plainly, and says what to do when they can't be (browser, blocked).
 */
function renderPushHint() {
  const el = $('push-hint');
  const closed = !order || CLOSED.includes(order.status) || order.status === 'ready';
  const support = pushSupport();
  if (closed || pushOn || !isAndroid() || support === 'granted') {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (support === 'unsupported') {
    el.innerHTML = `<strong>المتصفح ده مش هيرن عليك لو قفلت الصفحة</strong>
      <span>افتح الصفحة في Chrome عشان التليفون يرن لما طلبك يجهز، حتى والشاشة مقفولة.</span>
      <a class="btn btn-primary btn-block" href="${esc(chromeIntent())}">افتح في Chrome</a>`;
  } else if (support === 'denied') {
    el.innerHTML = `<strong>التنبيهات مقفولة للموقع ده</strong>
      <span>من فوق دوس على ⋮ ← معلومات الموقع (أو القفل جنب اللينك) ← الإشعارات ← سماح. وبعدين دوس «فعّل التنبيه».</span>`;
  } else {
    el.innerHTML = `<strong>دوس «فعّل التنبيه» ووافق</strong>
      <span>عشان التليفون يرن لما طلبك يجهز حتى لو قفلت الشاشة أو فتحت أبلكيشن تاني.</span>`;
  }
}

async function subscribePush(permission) {
  if (permission !== 'granted' || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { key } = await api('/api/vapid-key');
  if (!order) return false;
  const options = { userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) };
  let subscription;
  try {
    subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe(options));
  } catch {
    // Stale subscription from an old VAPID key.
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    subscription = await registration.pushManager.subscribe(options);
  }
  await api(`${branchApi}/subscribe`, {
    method: 'POST',
    body: { orderId: order.id, kind: 'webpush', payload: subscription.toJSON() },
  });
  return true;
}

function onEnable() {
  const button = $('enable');
  // Everything gesture-bound happens synchronously, before the first await.
  const permission = 'Notification' in window && Notification.permission === 'default'
    ? Notification.requestPermission()
    : Promise.resolve(window.Notification?.permission ?? 'denied');
  chime.unlock();
  chime.play('soft');
  keepAwake();
  button.disabled = true;
  button.textContent = t('enable_working');

  permission
    .then(subscribePush)
    .catch(() => false)
    .then((pushed) => {
      pushOn = pushed;
      button.classList.add('is-on');
      button.textContent = pushed ? t('enable_on') : t('enable_page');
      renderPushHint();
    });
}

/** Notifications were allowed before (an earlier order): this order gets them with no tap. */
async function autoSubscribe() {
  if (pushOn || pushSupport() !== 'granted' || !order || CLOSED.includes(order.status)) return;
  try {
    pushOn = await subscribePush('granted');
  } catch {
    pushOn = false;
  }
  if (pushOn) {
    $('enable').classList.add('is-on');
    $('enable').textContent = t('enable_on');
  }
  renderPushHint();
}

// ---------- boot ----------

async function resolveOrder() {
  // An order's own QR (customer screen, receipt): every phone that scans it follows that order.
  if (params.get('o') && params.get('j')) {
    return api(`${branchApi}/orders/${encodeURIComponent(params.get('o'))}/join`, {
      method: 'POST', body: {}, headers: { ...deviceHeaders(), 'x-client-id': clientId() },
    });
  }
  const savedId = params.get('o') ?? store.get(storageKey);
  let current = null;
  if (savedId) {
    try {
      current = await api(`${branchApi}/orders/${encodeURIComponent(savedId)}`);
      if (current.shopId !== shopId) current = null;
    } catch {
      current = null;
    }
  }
  const n = params.get('n');
  const k = params.get('k');
  if (!n && !k) return current;
  // A receipt's own QR: that receipt's order, never the "new order?" question.
  if (params.get('r')) return claimOrder();
  // Scanned again while an order is still open: a second order, or just checking the first?
  if (current && !CLOSED.includes(current.status)) return { again: current };
  return claimOrder();
}

function only(id) {
  for (const el of ['card', 'enable', 'pick', 'again', 'waiting']) $(el).hidden = el !== id;
}

// A POS-only branch has no number until the cashier's system sends the order: wait for it.
async function claimOrder(pick) {
  const n = params.get('n');
  const k = params.get('k');
  const receipt = params.get('r') ?? undefined; // the QR printed on the receipt
  const started = Date.now();
  for (;;) {
    try {
      const claimed = await api(`${branchApi}/claim`, {
        method: 'POST',
        body: { n: n ?? undefined, k: k ?? undefined, canPick: true, pick, receipt },
        headers: { ...deviceHeaders(), 'x-client-id': clientId() },
      });
      if (claimed.deviceToken) store.set(deviceKey, claimed.deviceToken);
      $('waiting').hidden = true;
      return claimed;
    } catch (err) {
      if (!err.data?.wait) throw err;
      if (Date.now() - started > POS_WAIT_MS) throw new Error('طلبك موصلش من الكاشير. اسأل الكاشير وامسح الكود تاني');
      await holdSplash(); // the wait has to be on screen, not behind the splash
      only('waiting');
      await sleep(3000);
      if (pick === 'new') pick = undefined; // "mine isn't here": the next try offers what arrived
    }
  }
}

function askAgain(previous) {
  only('again');
  $('again-number').textContent = label(previous);
  return new Promise((resolve, reject) => {
    $('again').onclick = async (e) => {
      const choice = e.target.closest('[data-again]')?.dataset.again;
      if (!choice) return;
      if (choice === 'back') return resolve(previous);
      e.target.disabled = true;
      try {
        resolve(await claimOrder());
      } catch (err) {
        e.target.disabled = false;
        reject(err);
      }
      return undefined;
    };
  });
}

// ---------- other open orders of this phone ----------

const others = new Map(); // id -> { order, events }

function saveOthers() {
  store.set(othersKey, JSON.stringify([...others.keys()]));
}

function renderOthers() {
  const list = [...others.values()].map((e) => e.order);
  $('others').hidden = !list.length;
  $('others').innerHTML = list.length
    ? `<span>${esc(t('other_orders'))}</span>${list.map((o) => `<button class="other-chip" type="button" data-other="${esc(o.id)}">
        <span class="num">${esc(label(o))}</span> ${o.status === 'ready' ? 'جاهز' : 'بيتحضّر'}</button>`).join('')}`
    : '';
}

function dropOther(id) {
  others.get(id)?.events?.close();
  others.delete(id);
  saveOthers();
  renderOthers();
}

// Watches an order in the background; the moment it is ready it takes the screen and rings.
function addOther(o) {
  if (!o || CLOSED.includes(o.status) || others.has(o.id) || o.id === order?.id) return;
  if (others.size >= MAX_OTHERS) dropOther(others.keys().next().value);
  const entry = { order: o, events: new EventSource(`${branchApi}/orders/${encodeURIComponent(o.id)}/events`) };
  others.set(o.id, entry);
  entry.events.addEventListener('order', (e) => {
    entry.order = JSON.parse(e.data);
    if (CLOSED.includes(entry.order.status)) dropOther(o.id);
    else if (entry.order.status === 'ready') switchTo(o.id);
    else renderOthers();
  });
  entry.events.addEventListener('renotify', (e) => {
    entry.order = JSON.parse(e.data);
    switchTo(o.id);
  });
  saveOthers();
  renderOthers();
}

function switchTo(id) {
  const entry = others.get(id);
  if (!entry) return;
  dropOther(id);
  const previous = order;
  stopRinging(false);
  order = entry.order;
  store.set(storageKey, order.id);
  history.replaceState(null, '', `${location.pathname}?o=${encodeURIComponent(order.id)}`);
  Object.assign(note, { text: '', sent: false, shown: null });
  addOther(previous);
  pushOn = false;
  render();
  connect();
  autoSubscribe();
}

async function restoreOthers() {
  let ids = [];
  try {
    ids = JSON.parse(store.get(othersKey) ?? '[]');
  } catch {
    ids = [];
  }
  for (const id of ids.slice(0, MAX_OTHERS)) {
    try {
      addOther(await api(`${branchApi}/orders/${encodeURIComponent(id)}`));
    } catch {
      /* gone */
    }
  }
  saveOthers();
}

// Several numbers from the POS are waiting: the customer picks the one on their receipt.
function pickNumber(numbers, note = '') {
  $('card').hidden = true;
  $('enable').hidden = true;
  $('pick').hidden = false;
  $('pick-note').textContent = note;
  $('pick-note').hidden = !note;
  $('pick-numbers').innerHTML = numbers
    .map((n) => `<button class="btn pick-number num" type="button" data-pick="${esc(n)}">${esc(n)}</button>`)
    .join('');
  return new Promise((resolve, reject) => {
    $('pick').onclick = async (e) => {
      const button = e.target.closest('[data-pick]');
      if (!button) return;
      try {
        const claimed = await claimOrder(button.dataset.pick);
        $('pick').hidden = true;
        resolve(claimed.choose ? pickNumber(claimed.choose) : claimed);
      } catch (err) {
        if (err.data?.choose) resolve(pickNumber(err.data.choose, err.message));
        else reject(err);
      }
    };
  });
}

async function boot() {
  try {
    shop = await api(branchApi);
  } catch (err) {
    await holdSplash();
    fatal(err.status === 404 ? 'المحل ده مش موجود. اتأكد من الكود' : err.message);
    return;
  }
  applyTheme(document.documentElement, shop.theme);
  setTexts(shop.texts);
  applyTexts(document);
  paintLogo($('splash-logo'), 136);
  $('splash-name').textContent = shop.name;
  paintLogo($('card-logo'), 56);

  let resolved = null;
  let failure = null;
  try {
    resolved = await resolveOrder();
  } catch (err) {
    failure = err.message;
  }
  await holdSplash();

  let previous = null;
  if (resolved?.again) {
    previous = resolved.again;
    try {
      resolved = await askAgain(previous);
    } catch (err) {
      resolved = null;
      failure = err.message;
    }
  }
  if (resolved?.choose) {
    try {
      resolved = await pickNumber(resolved.choose);
    } catch (err) {
      resolved = null;
      failure = err.message;
    }
  }
  if (!resolved) {
    fatal(failure ?? t('scan_prompt'));
    return;
  }
  store.set(storageKey, resolved.id);
  history.replaceState(null, '', `${location.pathname}?o=${encodeURIComponent(resolved.id)}`);
  order = resolved;
  only('card');
  render();
  connect();
  loadLoyalty();
  if (previous && previous.id !== order.id) addOther(previous);
  restoreOthers();
  $('others').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-other]');
    if (chip) switchTo(chip.dataset.other);
  });

  $('enable').addEventListener('click', onEnable);
  autoSubscribe();
  setInterval(() => {
    if (!order) return;
    $('card-when').textContent = elapsedLabel(order.createdAt);
    renderQueue();
  }, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && order && !CLOSED.includes(order.status)) refresh();
  });
}

boot();

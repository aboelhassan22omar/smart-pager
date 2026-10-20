import { Chime } from './chime.js';
import { applyAccent } from './color.js';
import { icons } from './icons.js';
import { aheadText, etaText } from './queue-text.js';
import { reviewHtml } from './review.js';
import { api, base64UrlToBytes, elapsedLabel, esc, isIOS, shopIdFromPath, sleep, SPLASH_MIN_MS } from './util.js';
import { keepAwake, releaseAwake } from './wakelock.js';

const CLOSED = ['picked', 'expired', 'cancelled'];
const STATUS_ICON = { preparing: 'clock', ready: 'check', picked: 'check', expired: 'cross', cancelled: 'cross' };
const RING_EVERY_MS = 2600;
const POLL_MS = 10_000;

const $ = (id) => document.getElementById(id);
const shopId = shopIdFromPath(location.pathname);
const params = new URLSearchParams(location.search);
const storageKey = `sp:order:${shopId}`;
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

async function holdSplash() {
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
  $('card').hidden = true;
  $('enable').hidden = true;
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

function render() {
  const card = $('card');
  card.dataset.status = order.status;
  $('card-shop').textContent = order.shopName;
  $('card-number').textContent = String(order.number);
  $('card-message').textContent = order.message;
  $('card-icon').innerHTML = icons[STATUS_ICON[order.status] ?? 'clock'](20);
  $('card-when').textContent = elapsedLabel(order.createdAt);
  document.title = `طلب ${order.number} — ${order.shopName}`;

  const closed = CLOSED.includes(order.status);
  $('enable').hidden = closed || order.status === 'ready';
  $('ios-hint').hidden = closed || order.status === 'ready' || !isIOS(navigator) || isStandalone();
  renderReview();
  renderQueue();

  if (order.status === 'ready') showReady();
  else hideReady();
}

// After pickup, every customer is asked (Google forbids asking only happy ones).
// Stars + comment + the Google button, all at once (no review gating; see review.js).
const review = { rating: 0, comment: '', sent: false, bound: false };

function renderReview() {
  const box = $('review');
  const show = order.status === 'picked' && Boolean(shop?.feedback || shop?.googleReviewUrl);
  box.hidden = !show;
  if (!show) return;
  if (order.feedback) {
    review.sent = true;
    review.rating = order.feedback.rating;
  }
  box.innerHTML = reviewHtml({
    googleUrl: shop.googleReviewUrl, feedback: shop.feedback, rating: review.rating, sent: review.sent, comment: review.comment,
  });
  if (review.bound) return;
  review.bound = true;
  box.addEventListener('click', async (e) => {
    const star = e.target.closest('[data-rating]');
    if (star && !review.sent) {
      review.rating = Number(star.dataset.rating);
      renderReview();
      $('review-comment')?.focus();
      return;
    }
    if (e.target.closest('#review-link')) {
      navigator.sendBeacon?.(`${branchApi}/orders/${encodeURIComponent(order.id)}/review-click`, '');
      return;
    }
    const send = e.target.closest('#review-send');
    if (send) {
      send.disabled = true;
      try {
        await api(`${branchApi}/orders/${encodeURIComponent(order.id)}/feedback`, {
          method: 'POST', body: { rating: review.rating, comment: review.comment },
        });
        review.sent = true;
      } catch (err) {
        if (err.status === 409) review.sent = true;
        else send.disabled = false;
      }
      renderReview();
    }
  });
  box.addEventListener('input', (e) => {
    if (e.target.id === 'review-comment') review.comment = e.target.value;
  });
}

function showReady() {
  $('ready-mark').innerHTML = icons.check(72);
  $('ready-number').textContent = String(order.number);
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
  order = next;
  render();
  if (CLOSED.includes(order.status)) {
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
  events.addEventListener('renotify', (e) => {
    const next = JSON.parse(e.data);
    apply(next);
    startRinging();
  });
}

// ---------- enable alerts ----------

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

async function subscribePush(permission) {
  if (permission !== 'granted' || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { key } = await api('/api/vapid-key');
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
  button.textContent = 'بنفعّل التنبيه…';

  permission
    .then(subscribePush)
    .catch(() => false)
    .then((pushed) => {
      button.classList.add('is-on');
      button.textContent = pushed ? 'التنبيه شغّال، هنرن عليك أول ما يجهز' : 'التنبيه شغّال طول ما الصفحة مفتوحة';
    });
}

// ---------- boot ----------

async function resolveOrder() {
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
  if ((!current || CLOSED.includes(current.status)) && (n || k)) {
    current = await api(`${branchApi}/claim`, { method: 'POST', body: { n: n ?? undefined, k: k ?? undefined } });
  }
  return current;
}

async function boot() {
  try {
    shop = await api(branchApi);
  } catch (err) {
    await holdSplash();
    fatal(err.status === 404 ? 'المحل ده مش موجود. اتأكد من الكود' : err.message);
    return;
  }
  applyAccent(document.documentElement, shop.accent);
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

  if (!resolved) {
    fatal(failure ?? 'امسح الكود اللي عند الكاشير عشان تاخد رقم طلبك');
    return;
  }
  store.set(storageKey, resolved.id);
  history.replaceState(null, '', `${location.pathname}?o=${encodeURIComponent(resolved.id)}`);
  order = resolved;
  render();
  connect();

  $('enable').addEventListener('click', onEnable);
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

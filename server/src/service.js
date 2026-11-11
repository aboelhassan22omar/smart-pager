import { channels } from './bus.js';
import { HttpError } from './errors.js';
import { loyaltyEnabled, loyaltyView } from './loyalty.js';
import { etaStats, queueFor } from './queue.js';
import { rollupBranch } from './rollups.js';
import { OPEN_STATUSES } from './store.js';
import { branchTz } from './util.js';
import { barShop, publicOrder, qrInfo } from './views.js';

const NEXT_STATUS = { preparing: 'ready', ready: 'picked' };

// Order lifecycle + fan-out to SSE (bus) and push (notifier). Every function takes the
// branch context it was resolved for; events only ever go to that branch's channels.
export function createService({ control, tenants, bus, notifier, screens, config, log }) {
  let jobCursor = 0;
  const etaCache = new Map(); // branchId -> {key, at, stats}
  const lastQueue = new Map(); // branchId -> Map(orderId -> sent key)
  const repeats = new Map(); // orderId -> timers ringing a ready order again

  // A ready order rings again until it is picked up: the phone in a pocket, the screen off, a
  // notification swiped away. Android plays a web notification's sound once, so this is what
  // makes it a pager. Each repeat re-reads the order and stops once it is no longer ready.
  function scheduleRepeats(branchId, orderId) {
    clearRepeats(orderId);
    const timers = config.readyRepeatSeconds.map((s) => setTimeout(() => {
      try {
        const ctx = tenants.get(branchId);
        const order = ctx?.store.getOrder(orderId);
        if (!order || order.status !== 'ready') {
          clearRepeats(orderId);
          return;
        }
        const shop = ctx.store.getShop();
        bus.emit(channels(branchId).order(orderId), 'renotify', customerView(ctx, order, shop));
        notifier.orderChanged(ctx, order, shop, { renotify: true });
      } catch (err) {
        log.error({ err, orderId }, 'ready repeat failed');
      }
    }, s * 1000));
    for (const t of timers) t.unref?.();
    repeats.set(orderId, timers);
  }

  function clearRepeats(orderId) {
    for (const t of repeats.get(orderId) ?? []) clearTimeout(t);
    repeats.delete(orderId);
  }

  /** What the customer sees: the public order plus its queue position / ETA. */
  function customerView(ctx, order, shop) {
    const stats = order.status === 'preparing' ? etaStats(ctx, { tz: branchTz(ctx.branch, config), cache: etaCache }) : null;
    const fb = order.status === 'picked' ? ctx.store.getFeedback(order.id) : null;
    return { ...publicOrder(order, shop), queue: queueFor(ctx, order, stats), feedback: fb ? { rating: fb.rating } : null };
  }

  // After any change in a branch, push a `queue` event only to the orders whose
  // position (or ETA basis) actually changed.
  function publishQueue(ctx) {
    const ch = channels(ctx.branch.id);
    const sent = lastQueue.get(ctx.branch.id) ?? new Map();
    lastQueue.set(ctx.branch.id, sent);
    const stats = etaStats(ctx, { tz: branchTz(ctx.branch, config), cache: etaCache });
    const live = new Set();
    for (const order of ctx.store.openOrders()) {
      if (order.status !== 'preparing') continue;
      live.add(order.id);
      const queue = queueFor(ctx, order, stats);
      const key = `${queue.ahead}|${queue.eta?.lowAt ?? ''}|${queue.eta?.highAt ?? ''}`;
      if (sent.get(order.id) === key) continue;
      sent.set(order.id, key);
      bus.emit(ch.order(order.id), 'queue', queue);
    }
    for (const id of sent.keys()) if (!live.has(id)) sent.delete(id);
  }

  function publishOrder(ctx, order, shop, { action = 'updated', renotify = false } = {}) {
    const view = customerView(ctx, order, shop);
    const ch = channels(ctx.branch.id);
    bus.emit(ch.order(order.id), 'order', view);
    if (renotify) bus.emit(ch.order(order.id), 'renotify', view);
    bus.emit(ch.bar, 'order', { action, order: publicOrder(order, shop), counter: ctx.store.counter() });
    notifier.orderChanged(ctx, order, shop, { renotify });
    publishQueue(ctx);
  }

  const publishNonce = (ctx, shop) => bus.emit(channels(ctx.branch.id).bar, 'nonce', qrInfo(shop, config));
  const publishShop = (ctx, shop) => bus.emit(channels(ctx.branch.id).bar, 'shop', barShop(shop));

  function claim(ctx, codes, { deviceHash = null, canPick = false } = {}) {
    const result = ctx.store.claim(codes, { deviceHash, canPick });
    if (result.choose) return result;
    const { order, shop, rotated } = result;
    if (rotated) publishNonce(ctx, shop);
    publishOrder(ctx, order, shop, { action: 'created' });
    control.touch(ctx.branch.id);
    return { order, shop };
  }

  const recentRequests = new Map(); // `${branch}|${request id}` -> at
  function adjustCounter(ctx, delta, requestId = null) {
    const key = requestId ? `${ctx.branch.id}|${requestId}` : null;
    if (key && recentRequests.has(key)) return ctx.store.counter();
    if (key) {
      const now = Date.now();
      for (const [k, at] of recentRequests) if (now - at > 600_000) recentRequests.delete(k);
      recentRequests.set(key, now);
    }
    const counter = ctx.store.adjustCounter(delta);
    bus.emit(channels(ctx.branch.id).bar, 'counter', counter);
    return counter;
  }

  const publishCounter = (ctx) => bus.emit(channels(ctx.branch.id).bar, 'counter', ctx.store.counter());
  const posEvent = (ctx, event) => ctx.store.updateShop({ pos_last_event: JSON.stringify({ at: Date.now(), ...event }) });

  /**
   * Order QR mode: the cashier (or the POS) rings an order up, it exists right away, and the
   * customer screen shows its QR.
   */
  function createOrder(ctx, { number = null, ref = null } = {}) {
    const { order, shop } = ctx.store.createOrder({ number, ref });
    orderRungUp(ctx, order, shop);
    return { order, shop };
  }

  function orderRungUp(ctx, order, shop) {
    publishOrder(ctx, order, shop, { action: 'created' });
    bus.emit(channels(ctx.branch.id).bar, 'order-qr', { id: order.id, number: order.number, ref: order.ref ?? null });
    control.touch(ctx.branch.id);
  }

  /**
   * Takeaway numbers typed by the cashier: receipt 27 gets the next takeaway number. It waits
   * for its customer's scan; in order QR mode it is an order now, its QR on the customer screen.
   */
  function manualReceipt(ctx, receipt) {
    const { number, repeated, order } = ctx.store.manualReceipt(receipt, { create: Boolean(ctx.store.getShop().order_qr) });
    const shop = ctx.store.getShop();
    if (order) orderRungUp(ctx, order, shop);
    else publishCounter(ctx);
    return { receipt, number, repeated, order: order ? publicOrder(order, shop) : null, counter: ctx.store.counter() };
  }

  /** A typed receipt cancelled: it stops waiting, or its order is cancelled (the customer sees it). */
  function cancelManualReceipt(ctx, receipt) {
    const found = ctx.store.cancelManualReceipt(receipt);
    if (!found) throw new HttpError(404, `فاتورة ${receipt} مش متسجلة النهارده، أو اتقفلت خلاص`);
    const shop = ctx.store.getShop();
    const order = found.order ? setStatus(ctx, shop, found.order, 'cancelled') : null;
    publishCounter(ctx);
    return { receipt, number: order ? order.ref ?? order.number : found.number, order: order ? publicOrder(order, shop) : null, counter: ctx.store.counter() };
  }

  /** Orders read from the branch's POS link. */
  function posOrders(ctx, orders) {
    const qrMode = Boolean(ctx.store.getShop()?.order_qr);
    const results = orders.map((order) => {
      const result = ctx.store.posOrder(order);
      // A takeaway / counter order: in order QR mode it becomes an order now, shown on the screen.
      if (qrMode && result === 'waiting') createOrder(ctx, { number: order.number, ref: order.ref ?? null });
      // Cancelled at the POS after the customer scanned: the order is cancelled here too, and
      // the customer's page says so.
      if (result === 'cancelled') {
        const open = ctx.store.openOrderByReceipt(order.ref ?? String(order.number));
        if (open) setStatus(ctx, ctx.store.getShop(), open, 'cancelled');
      }
      return { ...order, result };
    });
    const last = results.at(-1);
    posEvent(ctx, { number: last.ref ?? last.number, delivery: last.delivery, cancelled: last.cancelled });
    publishCounter(ctx);
    return results;
  }

  /** The POS called but no order number was found: the field names go on the settings page. */
  function posUnread(ctx, keys) {
    posEvent(ctx, { unread: true, keys });
  }

  function setStatus(ctx, shop, order, status) {
    if (!OPEN_STATUSES.includes(order.status)) throw new HttpError(409, 'الطلب ده اتقفل خلاص');
    if (order.status === status) return order;
    const updated = ctx.store.setStatus(order, status);
    publishOrder(ctx, updated, shop);
    if (status === 'ready') scheduleRepeats(ctx.branch.id, order.id);
    else clearRepeats(order.id);
    // Loyalty: a stamp only when staff hand the order over (never on claim, expiry or review).
    if (status === 'picked' && loyaltyEnabled(shop) && updated.device_hash) {
      ctx.store.stamp(updated, shop.loyalty_every);
      const card = loyaltyView(shop, ctx.store.loyaltyCard(updated.device_hash));
      bus.emit(channels(ctx.branch.id).order(order.id), 'loyalty', card);
    }
    return updated;
  }

  function redeem(ctx, shop, order) {
    if (!OPEN_STATUSES.includes(order.status)) throw new HttpError(409, 'الطلب ده اتقفل خلاص');
    if (!loyaltyEnabled(shop) || !ctx.store.redeem(order)) throw new HttpError(409, 'مفيش مكافأة على الطلب ده');
    const updated = ctx.store.getOrder(order.id);
    publishOrder(ctx, updated, shop);
    return updated;
  }

  function advance(ctx, shop, order) {
    const next = NEXT_STATUS[order.status];
    if (!next) throw new HttpError(409, 'الطلب ده اتقفل خلاص');
    return setStatus(ctx, shop, order, next);
  }

  function renotify(ctx, shop, order) {
    if (order.status !== 'ready') throw new HttpError(409, 'لازم الطلب يكون جاهز الأول');
    const updated = ctx.store.bumpNotify(order);
    publishOrder(ctx, updated, shop, { renotify: true });
    return updated;
  }

  // Only branches with an open bar/QR screen rotate; idle ones are covered by the
  // nonce age check at claim time (see BranchStore.claim).
  function rotateDue() {
    for (const branchId of screens.branches()) {
      const ctx = tenants.get(branchId);
      if (ctx?.store.nonceDue()) publishNonce(ctx, ctx.store.rotateNonce());
    }
  }

  // Expiry + purge, round-robin over at most `jobBatch` branches per run.
  function runJobs() {
    const ids = control.branchIds();
    const count = Math.min(ids.length, config.jobBatch);
    for (let i = 0; i < count; i++) {
      const id = ids[(jobCursor + i) % ids.length];
      try {
        const ctx = tenants.get(id);
        const shop = ctx?.store.getShop();
        if (!shop) continue;
        for (const order of ctx.store.dueForExpiry()) publishOrder(ctx, ctx.store.setStatus(order, 'expired'), shop);
        const purged = ctx.store.purgeClosed();
        if (purged.orders || purged.subscriptions) log.info({ branch: id, ...purged }, 'purged old orders / subscriptions');
      } catch (err) {
        log.error({ branch: id, err }, 'branch job failed');
      }
    }
    jobCursor = ids.length ? (jobCursor + count) % ids.length : 0;
  }

  // Hourly rollups (every 5 min), same round-robin batching.
  let rollupCursor = 0;
  function runRollups(now = Date.now()) {
    const ids = control.branchIds();
    const count = Math.min(ids.length, config.jobBatch);
    for (let i = 0; i < count; i++) {
      const id = ids[(rollupCursor + i) % ids.length];
      try {
        const ctx = tenants.get(id);
        if (ctx?.store.getShop()) rollupBranch(ctx.store, { tz: branchTz(ctx.branch, config), now });
      } catch (err) {
        log.error({ branch: id, err }, 'rollup failed');
      }
    }
    rollupCursor = ids.length ? (rollupCursor + count) % ids.length : 0;
  }

  return {
    claim, createOrder, manualReceipt, cancelManualReceipt, adjustCounter, posOrders, posUnread, setStatus, advance, renotify, redeem, publishNonce, publishShop, rotateDue, runJobs, runRollups, customerView,
    close: () => {
      for (const id of [...repeats.keys()]) clearRepeats(id);
    },
  };
}

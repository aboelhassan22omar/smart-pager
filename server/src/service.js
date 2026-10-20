import { channels } from './bus.js';
import { HttpError } from './errors.js';
import { etaStats, queueFor } from './queue.js';
import { rollupBranch } from './rollups.js';
import { OPEN_STATUSES } from './store.js';
import { barShop, publicOrder, qrInfo } from './views.js';

const NEXT_STATUS = { preparing: 'ready', ready: 'picked' };

// Order lifecycle + fan-out to SSE (bus) and push (notifier). Every function takes the
// branch context it was resolved for; events only ever go to that branch's channels.
export function createService({ control, tenants, bus, notifier, screens, config, log }) {
  let jobCursor = 0;
  const etaCache = new Map(); // branchId -> {key, at, stats}
  const lastQueue = new Map(); // branchId -> Map(orderId -> sent key)

  /** What the customer sees: the public order plus its queue position / ETA. */
  function customerView(ctx, order, shop) {
    const stats = order.status === 'preparing' ? etaStats(ctx, { tz: config.tz, cache: etaCache }) : null;
    const fb = order.status === 'picked' ? ctx.store.getFeedback(order.id) : null;
    return { ...publicOrder(order, shop), queue: queueFor(ctx, order, stats), feedback: fb ? { rating: fb.rating } : null };
  }

  // After any change in a branch, push a `queue` event only to the orders whose
  // position (or ETA basis) actually changed.
  function publishQueue(ctx) {
    const ch = channels(ctx.branch.id);
    const sent = lastQueue.get(ctx.branch.id) ?? new Map();
    lastQueue.set(ctx.branch.id, sent);
    const stats = etaStats(ctx, { tz: config.tz, cache: etaCache });
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
    bus.emit(ch.bar, 'order', { action, order: publicOrder(order, shop) });
    notifier.orderChanged(ctx, order, shop, { renotify });
    publishQueue(ctx);
  }

  const publishNonce = (ctx, shop) => bus.emit(channels(ctx.branch.id).bar, 'nonce', qrInfo(shop, config));
  const publishShop = (ctx, shop) => bus.emit(channels(ctx.branch.id).bar, 'shop', barShop(shop));

  function claim(ctx, codes) {
    const { order, shop, rotated } = ctx.store.claim(codes);
    if (rotated) publishNonce(ctx, shop);
    publishOrder(ctx, order, shop, { action: 'created' });
    control.touch(ctx.branch.id);
    return { order, shop };
  }

  function setStatus(ctx, shop, order, status) {
    if (!OPEN_STATUSES.includes(order.status)) throw new HttpError(409, 'الطلب ده اتقفل خلاص');
    if (order.status === status) return order;
    const updated = ctx.store.setStatus(order, status);
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
        if (ctx?.store.getShop()) rollupBranch(ctx.store, { tz: config.tz, now });
      } catch (err) {
        log.error({ branch: id, err }, 'rollup failed');
      }
    }
    rollupCursor = ids.length ? (rollupCursor + count) % ids.length : 0;
  }

  return {
    claim, setStatus, advance, renotify, publishNonce, publishShop, rotateDue, runJobs, runRollups, customerView,
  };
}

import { HttpError } from './errors.js';
import { OPEN_STATUSES } from './store.js';
import { barShop, publicOrder, qrInfo } from './views.js';

const NEXT_STATUS = { preparing: 'ready', ready: 'picked' };

// Order lifecycle + fan-out to SSE (bus) and push (notifier).
export function createService({ store, bus, notifier, config, log }) {
  function publishOrder(order, shop, { action = 'updated', renotify = false } = {}) {
    const view = publicOrder(order, shop);
    bus.emit(`order:${order.id}`, 'order', view);
    if (renotify) bus.emit(`order:${order.id}`, 'renotify', view);
    bus.emit(`shop:${shop.id}`, 'order', { action, order: view });
    notifier.orderChanged(order, shop, { renotify });
  }

  const publishNonce = (shop) => bus.emit(`shop:${shop.id}`, 'nonce', qrInfo(shop, config));
  const publishShop = (shop) => bus.emit(`shop:${shop.id}`, 'shop', barShop(shop));

  function claim(shopId, codes) {
    const { order, shop, rotated } = store.claim(shopId, codes);
    if (rotated) publishNonce(shop);
    publishOrder(order, shop, { action: 'created' });
    return { order, shop };
  }

  function setStatus(shop, order, status) {
    if (!OPEN_STATUSES.includes(order.status)) throw new HttpError(409, 'الطلب ده اتقفل خلاص');
    if (order.status === status) return order;
    const updated = store.setStatus(order, status);
    publishOrder(updated, shop);
    return updated;
  }

  function advance(shop, order) {
    const next = NEXT_STATUS[order.status];
    if (!next) throw new HttpError(409, 'الطلب ده اتقفل خلاص');
    return setStatus(shop, order, next);
  }

  function renotify(shop, order) {
    if (order.status !== 'ready') throw new HttpError(409, 'لازم الطلب يكون جاهز الأول');
    const updated = store.bumpNotify(order);
    publishOrder(updated, shop, { renotify: true });
    return updated;
  }

  function rotateDue() {
    for (const id of store.shopsDueForRotation()) publishNonce(store.rotateNonce(id));
  }

  function runJobs() {
    for (const order of store.dueForExpiry()) {
      const shop = store.getShop(order.shop_id);
      if (shop) publishOrder(store.setStatus(order, 'expired'), shop);
    }
    const purged = store.purgeClosed();
    if (purged) log.info({ purged }, 'purged closed orders');
  }

  return { claim, setStatus, advance, renotify, publishNonce, publishShop, rotateDue, runJobs };
}

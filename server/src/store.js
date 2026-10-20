import { tx } from './db.js';
import { HttpError } from './errors.js';
import { dayIn, randomId, safeEqual } from './util.js';

export const OPEN_STATUSES = ['preparing', 'ready'];
export const CLOSED_STATUSES = ['picked', 'expired', 'cancelled'];
export const QR_MODES = ['dynamic', 'static', 'both'];
export const SHOP_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const ORDER_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const SHOP_COLUMNS = new Set([
  'name', 'logo', 'pin_hash', 'qr_mode', 'static_key', 'max_number', 'expire_hours',
  'preparing_message', 'ready_message', 'accent_color', 'google_review_url',
]);
const PURGE_AFTER_MS = 24 * 3600 * 1000;

export const newNonce = () => randomId(12);
export const newStaticKey = () => randomId(18);

export class Store {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    const p = (sql) => db.prepare(sql);
    this.sql = {
      shop: p('SELECT * FROM shops WHERE id = ?'),
      shops: p('SELECT * FROM shops ORDER BY created_at'),
      insertShop: p(`INSERT INTO shops (id, name, pin_hash, qr_mode, qr_nonce, qr_rotated_at, static_key, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      rotate: p('UPDATE shops SET qr_prev_nonce = qr_nonce, qr_nonce = ?, qr_rotated_at = ? WHERE id = ?'),
      dueRotation: p(`SELECT id FROM shops WHERE qr_mode != 'static' AND qr_rotated_at <= ?`),
      openNumbers: p(`SELECT number FROM orders WHERE shop_id = ? AND status IN ('preparing', 'ready')`),
      setCounter: p('UPDATE shops SET next_number = ?, number_day = ? WHERE id = ?'),
      insertOrder: p(`INSERT INTO orders (id, shop_id, number, status, created_at) VALUES (?, ?, ?, 'preparing', ?)`),
      order: p('SELECT * FROM orders WHERE id = ?'),
      openOrders: p(`SELECT * FROM orders WHERE shop_id = ? AND status IN ('preparing', 'ready') ORDER BY created_at`),
      setStatus: p('UPDATE orders SET status = ?, ready_at = ?, closed_at = ? WHERE id = ?'),
      bumpNotify: p('UPDATE orders SET notify_count = notify_count + 1 WHERE id = ?'),
      markReviewClick: p('UPDATE orders SET review_clicked_at = ? WHERE id = ? AND review_clicked_at IS NULL'),
      bumpReviewClicks: p('UPDATE shops SET review_clicks = review_clicks + 1 WHERE id = ?'),
      subs: p('SELECT * FROM subscriptions WHERE order_id = ?'),
      countSubs: p('SELECT COUNT(*) AS c FROM subscriptions WHERE order_id = ?'),
      insertSub: p('INSERT OR IGNORE INTO subscriptions (order_id, kind, payload, created_at) VALUES (?, ?, ?, ?)'),
      deleteSub: p('DELETE FROM subscriptions WHERE id = ?'),
      dueExpire: p(`SELECT o.* FROM orders o JOIN shops s ON s.id = o.shop_id
                    WHERE o.status IN ('preparing', 'ready') AND o.created_at <= ? - s.expire_hours * 3600000`),
      purge: p('DELETE FROM orders WHERE closed_at IS NOT NULL AND closed_at <= ?'),
    };
  }

  ping() {
    return this.db.prepare('SELECT 1 AS ok').get().ok === 1;
  }

  // ---- shops ----

  getShop(id) {
    return typeof id === 'string' && SHOP_ID_RE.test(id) ? this.sql.shop.get(id) : undefined;
  }

  listShops() {
    return this.sql.shops.all();
  }

  createShop({ id, name, pinHash, qrMode = 'dynamic' }) {
    const now = Date.now();
    this.sql.insertShop.run(id, name, pinHash, qrMode, newNonce(), now, newStaticKey(), now);
    return this.getShop(id);
  }

  updateShop(id, fields) {
    const keys = Object.keys(fields).filter((k) => SHOP_COLUMNS.has(k));
    if (keys.length) {
      const set = keys.map((k) => `${k} = ?`).join(', ');
      this.db.prepare(`UPDATE shops SET ${set} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    }
    return this.getShop(id);
  }

  rotateNonce(id) {
    this.sql.rotate.run(newNonce(), Date.now(), id);
    return this.getShop(id);
  }

  shopsDueForRotation(now = Date.now()) {
    return this.sql.dueRotation.all(now - this.config.nonceRotateSeconds * 1000).map((r) => r.id);
  }

  // ---- orders ----

  claim(shopId, { n, k }) {
    return tx(this.db, () => {
      const shop = this.sql.shop.get(shopId);
      if (!shop) throw new HttpError(404, 'المحل ده مش موجود');

      const dynamicOk = shop.qr_mode !== 'static'
        && (safeEqual(n, shop.qr_nonce) || safeEqual(n, shop.qr_prev_nonce));
      const staticOk = shop.qr_mode !== 'dynamic' && safeEqual(k, shop.static_key);
      if (!dynamicOk && !staticOk) {
        throw new HttpError(403, 'الكود ده انتهى. امسح الكود اللي عند الكاشير تاني');
      }

      const number = this.#allocateNumber(shop);
      const id = randomId(16);
      this.sql.insertOrder.run(id, shop.id, number, Date.now());
      if (dynamicOk) this.sql.rotate.run(newNonce(), Date.now(), shop.id);
      return { order: this.sql.order.get(id), shop: this.sql.shop.get(shop.id), rotated: dynamicOk };
    });
  }

  // Daily reset, wrap after max_number, skip numbers that are still open.
  #allocateNumber(shop) {
    const today = dayIn(this.config.tz);
    const max = shop.max_number;
    let n = shop.number_day === today ? shop.next_number : 1;
    if (n < 1 || n > max) n = 1;
    const open = new Set(this.sql.openNumbers.all(shop.id).map((r) => r.number));
    for (let i = 0; i < max; i++) {
      if (!open.has(n)) {
        this.sql.setCounter.run(n >= max ? 1 : n + 1, today, shop.id);
        return n;
      }
      n = n >= max ? 1 : n + 1;
    }
    throw new HttpError(503, 'كل الأرقام مشغولة دلوقتي. كلّم الكاشير');
  }

  getOrder(id) {
    return typeof id === 'string' && ORDER_ID_RE.test(id) ? this.sql.order.get(id) : undefined;
  }

  openOrders(shopId) {
    return this.sql.openOrders.all(shopId);
  }

  setStatus(order, status) {
    const now = Date.now();
    let readyAt = order.ready_at;
    if (status === 'ready' && order.status !== 'ready') readyAt = now;
    if (status === 'preparing') readyAt = null;
    const closedAt = CLOSED_STATUSES.includes(status) ? now : null;
    this.sql.setStatus.run(status, readyAt, closedAt, order.id);
    if (status === 'ready' && order.status !== 'ready') this.sql.bumpNotify.run(order.id);
    return this.sql.order.get(order.id);
  }

  bumpNotify(order) {
    this.sql.bumpNotify.run(order.id);
    return this.sql.order.get(order.id);
  }

  // Counts a "rate us on Google" tap once per order.
  recordReviewClick(order) {
    return tx(this.db, () => {
      const first = Number(this.sql.markReviewClick.run(Date.now(), order.id).changes) === 1;
      if (first) this.sql.bumpReviewClicks.run(order.shop_id);
      return first;
    });
  }

  dueForExpiry(now = Date.now()) {
    return this.sql.dueExpire.all(now);
  }

  purgeClosed(now = Date.now()) {
    return Number(this.sql.purge.run(now - PURGE_AFTER_MS).changes);
  }

  // ---- subscriptions ----

  subscriptions(orderId) {
    return this.sql.subs.all(orderId).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  countSubscriptions(orderId) {
    return Number(this.sql.countSubs.get(orderId).c);
  }

  addSubscription(orderId, kind, payload) {
    const res = this.sql.insertSub.run(orderId, kind, JSON.stringify(payload), Date.now());
    if (!Number(res.changes)) return null;
    return { id: Number(res.lastInsertRowid), order_id: orderId, kind, payload };
  }

  deleteSubscription(id) {
    this.sql.deleteSub.run(id);
  }
}

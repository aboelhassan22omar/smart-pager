import { tx } from './db.js';
import { HttpError } from './errors.js';
import { MAX_POS_NUMBER } from './pos.js';
import { branchTz, businessDay, randomId, safeEqual } from './util.js';

export const OPEN_STATUSES = ['preparing', 'ready'];
export const CLOSED_STATUSES = ['picked', 'expired', 'cancelled'];
export const QR_MODES = ['dynamic', 'static', 'both'];
export const SHOP_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const ORDER_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

// Branch settings columns staff may change. The display name lives in the control DB.
const SETTING_COLUMNS = new Set([
  'logo', 'pin_hash', 'pin_sealed', 'qr_mode', 'static_key', 'max_number', 'expire_hours',
  'preparing_message', 'ready_message', 'accent_color', 'google_review_url', 'late_after_minutes',
  'google_place_id', 'loyalty_every', 'loyalty_reward_text',
  'promo_text', 'promo_image', 'promo_starts_at', 'promo_ends_at',
  'pos_token', 'pos_last_event', 'theme_version', 'pos_only', 'order_qr', 'order_share',
]);
export const FEEDBACK_WINDOW_MS = 48 * 3600 * 1000;
// Closed orders hold no personal data and feed analytics for 90 days; push subscriptions
// (device endpoints / tokens) still go 24h after their order closed.
const ORDER_RETENTION_MS = 90 * 24 * 3600 * 1000;
const SUBSCRIPTION_RETENTION_MS = 24 * 3600 * 1000;
// A number from the POS nobody scanned stops being offered to customers after this.
const POS_WAITING_MS = 20 * 60_000;
const POS_RETENTION_MS = 3 * 24 * 3600 * 1000;
// A POS number this far below our count means the POS restarted its numbering (not a late call).
const POS_RESTART_GAP = 50;

export const newNonce = () => randomId(12);
export const newStaticKey = () => randomId(18);

/**
 * Store for ONE branch, bound to that branch's own database file. It cannot reach
 * another branch: there is no branch id in its queries, the file is the boundary.
 * `getShop()` merges the branch settings with its control-DB registry row (id, name,
 * brand) so views keep the v1 "shop" shape.
 */
export class BranchStore {
  constructor(db, { branchId, control, config }) {
    this.db = db;
    this.branchId = branchId;
    this.control = control;
    this.config = config;
    const p = (sql) => db.prepare(sql);
    this.sql = {
      settings: p('SELECT * FROM branch_settings WHERE id = 1'),
      insertSettings: p(`INSERT INTO branch_settings (id, pin_hash, pin_sealed, qr_mode, qr_nonce, qr_rotated_at, static_key, created_at)
                         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`),
      rotate: p('UPDATE branch_settings SET qr_prev_nonce = qr_nonce, qr_nonce = ?, qr_rotated_at = ? WHERE id = 1'),
      openNumbers: p(`SELECT number, ref FROM orders WHERE status IN ('preparing', 'ready')`),
      setCounter: p('UPDATE branch_settings SET next_number = ?, number_day = ? WHERE id = 1'),
      insertOrder: p(`INSERT INTO orders (id, number, ref, status, created_at) VALUES (?, ?, ?, 'preparing', ?)`),
      // Order reads carry the attached reward's state (loyalty) for the bar and customer views.
      order: p(`SELECT o.*, r.redeemed_at AS reward_redeemed_at FROM orders o
                LEFT JOIN loyalty_rewards r ON r.id = o.reward_id WHERE o.id = ?`),
      openOrders: p(`SELECT o.*, r.redeemed_at AS reward_redeemed_at FROM orders o
                     LEFT JOIN loyalty_rewards r ON r.id = o.reward_id
                     WHERE o.status IN ('preparing', 'ready') ORDER BY o.created_at`),
      detachReward: p('UPDATE loyalty_rewards SET attached_order_id = NULL WHERE attached_order_id = ? AND redeemed_at IS NULL'),
      clearOrderReward: p('UPDATE orders SET reward_id = NULL WHERE id = ? AND reward_id IN (SELECT id FROM loyalty_rewards WHERE redeemed_at IS NULL)'),
      setStatus: p('UPDATE orders SET status = ?, ready_at = ?, closed_at = ? WHERE id = ?'),
      bumpNotify: p('UPDATE orders SET notify_count = notify_count + 1 WHERE id = ?'),
      markReviewClick: p('UPDATE orders SET review_clicked_at = ? WHERE id = ? AND review_clicked_at IS NULL'),
      bumpReviewClicks: p('UPDATE branch_settings SET review_clicks = review_clicks + 1 WHERE id = 1'),
      subs: p('SELECT * FROM subscriptions WHERE order_id = ?'),
      countSubs: p('SELECT COUNT(*) AS c FROM subscriptions WHERE order_id = ?'),
      insertSub: p('INSERT OR IGNORE INTO subscriptions (order_id, kind, payload, created_at) VALUES (?, ?, ?, ?)'),
      deleteSub: p('DELETE FROM subscriptions WHERE id = ?'),
      dueExpire: p(`SELECT * FROM orders WHERE status IN ('preparing', 'ready') AND created_at <= ?`),
      purge: p('DELETE FROM orders WHERE closed_at IS NOT NULL AND closed_at <= ?'),
      purgeSubs: p(`DELETE FROM subscriptions WHERE order_id IN
                    (SELECT id FROM orders WHERE closed_at IS NOT NULL AND closed_at <= ?)`),
    };
  }

  ping() {
    return this.db.prepare('SELECT 1 AS ok').get().ok === 1;
  }

  // ---- settings ----

  getShop() {
    const settings = this.sql.settings.get();
    const branch = this.control.getBranch(this.branchId);
    if (!settings || !branch) return undefined;
    return {
      ...settings,
      id: branch.id,
      name: branch.name,
      brand_id: branch.brand_id,
      area: branch.area,
      // Feature flags live on the control row (owner toggles, super can force off).
      ff_review: branch.ff_review,
      ff_loyalty: branch.ff_loyalty,
      ff_promo: branch.ff_promo,
      forced_off: branch.forced_off,
      tz: branch.tz,
      day_start_hour: branch.day_start_hour,
    };
  }

  initSettings({ pinHash, pinSealed = null, qrMode = 'dynamic', createdAt = Date.now() }) {
    this.sql.insertSettings.run(pinHash, pinSealed, qrMode, newNonce(), Date.now(), newStaticKey(), createdAt);
    return this.getShop();
  }

  updateShop(fields) {
    if (typeof fields.name === 'string') this.control.renameBranch(this.branchId, fields.name);
    const keys = Object.keys(fields).filter((k) => SETTING_COLUMNS.has(k));
    if (keys.length) {
      const set = keys.map((k) => `${k} = ?`).join(', ');
      this.db.prepare(`UPDATE branch_settings SET ${set} WHERE id = 1`).run(...keys.map((k) => fields[k]));
    }
    return this.getShop();
  }

  rotateNonce() {
    this.sql.rotate.run(newNonce(), Date.now());
    return this.getShop();
  }

  nonceDue(now = Date.now()) {
    const s = this.sql.settings.get();
    return Boolean(s) && s.qr_mode !== 'static' && now - s.qr_rotated_at >= this.config.nonceRotateSeconds * 1000;
  }

  // ---- business day ----

  /** The branch's own day (YYYY-MM-DD): its timezone, starting at its "day starts at" hour. */
  today(now = Date.now()) {
    const branch = this.control.getBranch(this.branchId);
    return businessDay(branchTz(branch, this.config), branch?.day_start_hour ?? 0, now);
  }

  /** New timezone and/or start hour, without restarting the count of the day in progress. */
  setDay({ tz, dayStartHour }) {
    return tx(this.db, () => {
      const before = this.today();
      if (tz !== undefined) this.control.setBranchTz(this.branchId, tz);
      if (dayStartHour !== undefined) this.control.setDayStart(this.branchId, dayStartHour);
      const after = this.today();
      if (after !== before) {
        this.db.prepare('UPDATE branch_settings SET number_day = ? WHERE id = 1 AND number_day = ?').run(after, before);
        this.db.prepare('UPDATE OR IGNORE pos_numbers SET day = ? WHERE day = ?').run(after, before);
      }
      return this.getShop();
    });
  }

  // ---- orders ----

  /** `deviceHash` (loyalty on): the order is tied to the device and takes its oldest free reward. */
  claim({ n, k, pick, receipt = null }, { deviceHash = null, canPick = false } = {}) {
    return tx(this.db, () => {
      const shop = this.getShop();
      if (!shop) throw new HttpError(404, 'المحل ده مش موجود');

      // The current nonce is valid for 2 rotation periods, the previous one for 1, measured
      // from the last rotation. Branches without an open QR screen are not rotated, so this
      // age check is what keeps an old photo of the QR from working.
      const period = this.config.nonceRotateSeconds * 1000;
      const age = Date.now() - shop.qr_rotated_at;
      const dynamic = shop.qr_mode !== 'static';
      const dynamicOk = dynamic && ((age < 2 * period && safeEqual(n, shop.qr_nonce))
        || (age < period && safeEqual(n, shop.qr_prev_nonce)));
      // A receipt's QR carries the static key whatever the screen's QR mode is.
      const staticOk = (shop.qr_mode !== 'dynamic' || Boolean(receipt)) && safeEqual(k, shop.static_key);
      if (!dynamicOk && !staticOk) {
        throw new HttpError(403, 'الكود ده انتهى. امسح الكود اللي عند الكاشير تاني');
      }

      const fromPos = receipt ? this.#fromReceipt(shop, receipt) : this.#fromPos(shop, pick, canPick);
      if (fromPos?.choose) return fromPos;
      const number = fromPos?.number ?? this.#allocateNumber(shop);
      const ref = fromPos?.ref ?? null;
      if (shop.pos_token) this.#markPos(ref ?? String(number), number);
      const id = randomId(16);
      this.sql.insertOrder.run(id, number, ref, Date.now());
      if (deviceHash) this.#attachDevice(id, deviceHash);
      if (dynamicOk) this.sql.rotate.run(newNonce(), Date.now());
      return { order: this.sql.order.get(id), shop: this.getShop(), rotated: dynamicOk };
    });
  }

  /**
   * An order rung up at the counter (order QR mode): no code to check, the customer joins it
   * by scanning its own QR. `number`/`ref` come from the POS; without them, the next number.
   */
  createOrder({ number = null, ref = null } = {}) {
    return tx(this.db, () => {
      const shop = this.getShop();
      const n = number ?? this.#allocateNumber(shop);
      if (shop.pos_token) this.#markPos(ref ?? String(n), n);
      const id = randomId(16);
      this.sql.insertOrder.run(id, n, ref, Date.now());
      return { order: this.sql.order.get(id), shop: this.getShop() };
    });
  }

  /**
   * A phone opens an order from its QR. The first one is remembered; with sharing off another
   * phone is turned away. Returns false when it is.
   */
  joinOrder(order, clientId, { share }) {
    if (!order.viewer) {
      if (clientId) this.db.prepare('UPDATE orders SET viewer = ? WHERE id = ? AND viewer IS NULL').run(clientId, order.id);
      return true;
    }
    return share || !clientId || order.viewer === clientId;
  }

  /** Loyalty on a joined order: the first phone with a device token takes it. */
  attachDeviceIfFree(orderId, deviceHash) {
    const order = this.sql.order.get(orderId);
    if (order && !order.device_hash) this.#attachDevice(orderId, deviceHash);
  }

  // The number the next customer gets: daily reset, wrap after max_number, skip open numbers.
  #nextFree(shop, today, open) {
    const max = shop.max_number;
    let n = shop.number_day === today ? shop.next_number : 1;
    if (n < 1 || n > max) n = 1;
    for (let i = 0; i < max; i++) {
      if (!open.has(n)) return n;
      n = n >= max ? 1 : n + 1;
    }
    return null;
  }

  /**
   * With a POS linked, the customer gets the number on their receipt: the only one waiting,
   * or the one they pick when there are several (someone before them didn't scan). Apps that
   * can't show a choice get the newest. In POS-only mode there is no number without the POS:
   * the customer waits for it. Returns { number, ref }, { choose }, or null for the count.
   */
  #fromPos(shop, pick, canPick) {
    const waiting = shop.pos_token ? this.#posWaiting() : [];
    const posOnly = Boolean(shop.pos_token && shop.pos_only);
    const wait = () => new HttpError(409, 'طلبك لسه موصلش من الكاشير. ثواني وهيظهر', { wait: true });
    if (!waiting.length || pick === 'new') {
      if (posOnly) throw wait();
      return null;
    }
    const labels = waiting.map((w) => w.key);
    if (pick != null) {
      const hit = waiting.find((w) => w.key === String(pick));
      if (hit) return hit;
      throw new HttpError(409, 'الرقم ده حد تاني أخده. اختار رقم طلبك تاني', { choose: labels });
    }
    if (waiting.length === 1) return waiting[0];
    return canPick ? { choose: labels } : waiting.at(-1);
  }

  /**
   * The QR printed on a receipt carries its number. With a POS that sends its orders, it is the
   * waiting POS number (or a short wait for it to arrive); without one, the receipt number is
   * the order number. Returns { number, ref }.
   */
  #fromReceipt(shop, receipt) {
    const linked = Boolean(shop.pos_token && shop.pos_last_event);
    const hit = linked ? this.#posWaiting().find((w) => w.key === receipt) : null;
    if (hit) return hit;
    if (linked) throw new HttpError(409, 'طلبك لسه موصلش من الكاشير. ثواني وهيظهر', { wait: true });
    const number = Number(receipt.match(/(\d+)$/)[1]);
    return { number, ref: receipt === String(number) ? null : receipt };
  }

  /** The open order a receipt number belongs to (several phones scan one receipt), or null. */
  openOrderByReceipt(receipt) {
    const row = this.db.prepare(`SELECT id FROM orders WHERE status IN ('preparing', 'ready')
      AND (ref = ? OR (ref IS NULL AND CAST(number AS TEXT) = ?)) ORDER BY created_at DESC LIMIT 1`).get(receipt, receipt);
    return row ? this.getOrder(row.id) : null;
  }

  /** Waiting POS numbers, oldest first: [{ key, number, ref }] (ref only with a terminal prefix). */
  #posWaiting(now = Date.now()) {
    const open = this.#openKeys();
    return this.db.prepare(`SELECT ref, number FROM pos_numbers WHERE day = ? AND state = 'waiting' AND created_at >= ?
                            ORDER BY created_at, number`)
      .all(this.today(now), now - POS_WAITING_MS)
      .filter((r) => !open.has(r.ref))
      .map((r) => ({ key: r.ref, number: r.number, ref: r.ref === String(r.number) ? null : r.ref }));
  }

  #markPos(key, number) {
    this.db.prepare(`INSERT INTO pos_numbers (day, ref, number, state, created_at) VALUES (?, ?, ?, 'done', ?)
                     ON CONFLICT (day, ref) DO UPDATE SET state = 'done'`).run(this.today(), key, number, Date.now());
  }

  /**
   * One order from the POS. Every number moves the count past it; a delivery ends there, and any
   * other order waits for its customer's scan. Systems call again when an order changes, so a
   * number already seen today does nothing. `ref` ("2-1008") tells terminals apart.
   * Returns what happened to it.
   */
  posOrder({ number, ref = null, delivery = false, cancelled = false }) {
    return tx(this.db, () => {
      const today = this.today();
      const now = Date.now();
      const key = ref ?? String(number);
      const seen = this.db.prepare('SELECT state FROM pos_numbers WHERE day = ? AND ref = ?').get(today, key);
      if (cancelled) {
        // The POS doesn't reuse a cancelled number, so the count stays where it is.
        if (seen) this.#markPos(key, number);
        return 'cancelled';
      }
      if (seen) return 'repeated';

      const shop = this.sql.settings.get();
      const updates = number > shop.max_number ? { max_number: MAX_POS_NUMBER } : null;
      if (updates) this.updateShop(updates);
      const max = updates ? MAX_POS_NUMBER : shop.max_number;
      const count = shop.number_day === today ? shop.next_number : 1;
      if (number >= count || count - number > POS_RESTART_GAP) this.sql.setCounter.run(number >= max ? 1 : number + 1, today);

      const taken = this.#openKeys().has(key);
      const state = delivery || taken ? 'done' : 'waiting';
      this.db.prepare('INSERT INTO pos_numbers (day, ref, number, state, created_at) VALUES (?, ?, ?, ?, ?)').run(today, key, number, state, now);
      if (delivery) return 'delivery';
      return taken ? 'matched' : 'waiting';
    });
  }

  #openNumbers() {
    return new Set(this.sql.openNumbers.all().map((r) => r.number));
  }

  /** Open orders by what the receipt says ("2-1008", or the plain number). */
  #openKeys() {
    return new Set(this.sql.openNumbers.all().map((r) => r.ref ?? String(r.number)));
  }

  #allocateNumber(shop) {
    const today = this.today();
    const n = this.#nextFree(shop, today, this.#openNumbers());
    if (n == null) throw new HttpError(503, 'كل الأرقام مشغولة دلوقتي. كلّم الكاشير');
    this.sql.setCounter.run(n >= shop.max_number ? 1 : n + 1, today);
    return n;
  }

  /**
   * Wipes what the branch did (orders, analytics, ratings, stamp cards, POS numbers) and starts
   * the count at 1 again, as after a test run. Settings, PIN, logo, texts and links stay.
   */
  resetActivity() {
    return tx(this.db, () => {
      for (const table of ['subscriptions', 'feedback', 'loyalty_rewards', 'loyalty_devices', 'orders', 'hourly_stats', 'pos_numbers']) {
        this.db.exec(`DELETE FROM ${table}`);
      }
      this.db.exec("DELETE FROM meta WHERE key = 'rollup_at'");
      this.db.exec('UPDATE branch_settings SET next_number = 1, number_day = NULL, review_clicks = 0, pos_last_event = NULL');
    });
  }

  /** What the cashier sees: the next number and the one before it (null at the start of the count). */
  counter() {
    const shop = this.sql.settings.get();
    const next = this.#nextFree(shop, this.today(), this.#openNumbers());
    const counter = { next, last: next > 1 ? next - 1 : null };
    const waiting = shop.pos_token ? this.#posWaiting().length : 0;
    return waiting ? { ...counter, waiting } : counter;
  }

  /**
   * +1: skips a number that went to an order outside the pager (delivery, a takeaway that
   * won't scan), so the count stays the same as the POS. -1: takes one back after a mistake.
   */
  adjustCounter(delta) {
    return tx(this.db, () => {
      const shop = this.sql.settings.get();
      const today = this.today();
      const open = this.#openNumbers();
      const next = this.#nextFree(shop, today, open);
      if (next == null) throw new HttpError(503, 'كل الأرقام مشغولة دلوقتي. كلّم الكاشير');
      if (delta > 0) {
        this.sql.setCounter.run(next >= shop.max_number ? 1 : next + 1, today);
      } else {
        const back = next - 1;
        if (back < 1) throw new HttpError(409, 'العد لسه في أوله، مفيش رقم نرجع له');
        if (open.has(back)) throw new HttpError(409, `رقم ${back} عليه طلب مفتوح. لو طلع بالغلط، ألغيه من شاشة الطلبات`);
        this.sql.setCounter.run(back, today);
        // A number taken back isn't offered to customers any more.
        this.db.prepare('DELETE FROM pos_numbers WHERE day = ? AND ref = ?').run(today, String(back));
      }
      return this.counter();
    });
  }

  #attachDevice(orderId, deviceHash) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO loyalty_devices (token_hash, created_at, last_seen_at) VALUES (?, ?, ?)
                     ON CONFLICT (token_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(deviceHash, now, now);
    const reward = this.db.prepare(`SELECT id FROM loyalty_rewards
      WHERE token_hash = ? AND redeemed_at IS NULL AND attached_order_id IS NULL ORDER BY earned_at, id LIMIT 1`).get(deviceHash);
    if (reward) this.db.prepare('UPDATE loyalty_rewards SET attached_order_id = ? WHERE id = ?').run(orderId, reward.id);
    this.db.prepare('UPDATE orders SET device_hash = ?, reward_id = ? WHERE id = ?').run(deviceHash, reward?.id ?? null, orderId);
  }

  getOrder(id) {
    return typeof id === 'string' && ORDER_ID_RE.test(id) ? this.sql.order.get(id) : undefined;
  }

  openOrders() {
    return this.sql.openOrders.all();
  }

  setStatus(order, status) {
    const now = Date.now();
    let readyAt = order.ready_at;
    if (status === 'ready' && order.status !== 'ready') readyAt = now;
    if (status === 'preparing') readyAt = null;
    const closedAt = CLOSED_STATUSES.includes(status) ? now : null;
    tx(this.db, () => {
      this.sql.setStatus.run(status, readyAt, closedAt, order.id);
      this.db.prepare('UPDATE orders SET rev = rev + 1 WHERE id = ?').run(order.id);
      if (status === 'ready' && order.status !== 'ready') this.sql.bumpNotify.run(order.id);
      // Closed without redeeming: the reward goes back to the device for its next order.
      if (closedAt && order.reward_id) {
        this.sql.detachReward.run(order.id);
        this.sql.clearOrderReward.run(order.id);
      }
    });
    return this.sql.order.get(order.id);
  }

  bumpNotify(order) {
    this.sql.bumpNotify.run(order.id);
    this.db.prepare('UPDATE orders SET rev = rev + 1 WHERE id = ?').run(order.id);
    return this.sql.order.get(order.id);
  }

  // Counts a "rate us on Google" tap once per order.
  recordReviewClick(order) {
    return tx(this.db, () => {
      const first = Number(this.sql.markReviewClick.run(Date.now(), order.id).changes) === 1;
      if (first) this.sql.bumpReviewClicks.run();
      return first;
    });
  }

  dueForExpiry(now = Date.now()) {
    const shop = this.sql.settings.get();
    return shop ? this.sql.dueExpire.all(now - shop.expire_hours * 3600_000) : [];
  }

  /** Returns { orders, subscriptions } removed. */
  purgeClosed(now = Date.now()) {
    const subscriptions = Number(this.sql.purgeSubs.run(now - SUBSCRIPTION_RETENTION_MS).changes);
    const orders = Number(this.sql.purge.run(now - ORDER_RETENTION_MS).changes);
    this.db.prepare('DELETE FROM pos_numbers WHERE created_at < ?').run(now - POS_RETENTION_MS);
    return { orders, subscriptions };
  }

  // ---- loyalty ----

  /** {stamps, rewards (unredeemed)} for one device; zeros for an unknown one. */
  loyaltyCard(deviceHash) {
    const device = deviceHash ? this.db.prepare('SELECT stamps FROM loyalty_devices WHERE token_hash = ?').get(deviceHash) : null;
    const rewards = device
      ? Number(this.db.prepare('SELECT COUNT(*) AS n FROM loyalty_rewards WHERE token_hash = ? AND redeemed_at IS NULL').get(deviceHash).n)
      : 0;
    return { stamps: device?.stamps ?? 0, rewards };
  }

  /**
   * One stamp for a picked-up order (staff action), at most once per order. Reaching
   * `every` creates a reward and resets the stamps. Returns true when a reward was earned.
   */
  stamp(order, every) {
    if (!order.device_hash || order.stamped) return false;
    return tx(this.db, () => {
      if (Number(this.db.prepare('UPDATE orders SET stamped = 1 WHERE id = ? AND stamped = 0').run(order.id).changes) !== 1) return false;
      const { stamps } = this.db.prepare('UPDATE loyalty_devices SET stamps = stamps + 1 WHERE token_hash = ? RETURNING stamps')
        .get(order.device_hash);
      if (stamps < every) return false;
      this.db.prepare('UPDATE loyalty_devices SET stamps = 0 WHERE token_hash = ?').run(order.device_hash);
      this.db.prepare('INSERT INTO loyalty_rewards (token_hash, earned_at) VALUES (?, ?)').run(order.device_hash, Date.now());
      return true;
    });
  }

  /** Staff confirm the reward attached to an open order. False when there is none to redeem. */
  redeem(order) {
    if (!order.reward_id || order.reward_redeemed_at) return false;
    const res = this.db.prepare('UPDATE loyalty_rewards SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL AND attached_order_id = ?')
      .run(Date.now(), order.reward_id, order.id);
    return Number(res.changes) === 1;
  }

  // ---- feedback ----

  getFeedback(orderId) {
    return this.db.prepare('SELECT * FROM feedback WHERE order_id = ?').get(orderId);
  }

  /** One per order; returns false if it already exists. */
  addFeedback(orderId, { rating, comment }) {
    const res = this.db.prepare('INSERT OR IGNORE INTO feedback (order_id, rating, comment, created_at) VALUES (?, ?, ?, ?)')
      .run(orderId, rating, comment, Date.now());
    return Number(res.changes) === 1;
  }

  feedbackSince(since, until = Date.now()) {
    return this.db.prepare('SELECT * FROM feedback WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC')
      .all(since, until);
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

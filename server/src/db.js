import { DatabaseSync } from 'node:sqlite';
import { PRAGMAS, runMigrations } from './migrations.js';

export { tx } from './migrations.js';

// Branch database: everything operational for ONE branch. No shop_id columns — the
// file itself is the tenant boundary. Append new steps; never edit a shipped one.
export const BRANCH_MIGRATIONS = [
  `
  CREATE TABLE branch_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pin_hash TEXT NOT NULL,
    logo TEXT,
    qr_mode TEXT NOT NULL DEFAULT 'dynamic' CHECK (qr_mode IN ('dynamic', 'static', 'both')),
    qr_nonce TEXT NOT NULL,
    qr_prev_nonce TEXT,
    qr_rotated_at INTEGER NOT NULL,
    static_key TEXT NOT NULL,
    next_number INTEGER NOT NULL DEFAULT 1,
    number_day TEXT,
    max_number INTEGER NOT NULL DEFAULT 999,
    expire_hours INTEGER NOT NULL DEFAULT 3,
    preparing_message TEXT NOT NULL DEFAULT 'طلبك قيد التحضير',
    ready_message TEXT NOT NULL DEFAULT 'توجّه إلى الكاونتر لاستلام طلبك',
    accent_color TEXT,
    google_review_url TEXT,
    review_clicks INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    number INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'picked', 'expired', 'cancelled')),
    created_at INTEGER NOT NULL,
    ready_at INTEGER,
    closed_at INTEGER,
    notify_count INTEGER NOT NULL DEFAULT 0,
    review_clicked_at INTEGER
  );
  CREATE INDEX orders_status ON orders (status);
  CREATE INDEX orders_closed_at ON orders (closed_at);
  CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('webpush', 'live_activity')),
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (order_id, kind, payload)
  );
  `,
  // 2: late threshold, hourly rollups (kept forever; closed orders now kept 90 days).
  `
  ALTER TABLE branch_settings ADD COLUMN late_after_minutes INTEGER NOT NULL DEFAULT 10;
  CREATE INDEX orders_created_at ON orders (created_at);
  CREATE TABLE hourly_stats (
    hour_start INTEGER PRIMARY KEY,
    orders INTEGER NOT NULL DEFAULT 0,
    picked INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0,
    expired INTEGER NOT NULL DEFAULT 0,
    late INTEGER NOT NULL DEFAULT 0,
    prep_count INTEGER NOT NULL DEFAULT 0,
    prep_sum_s INTEGER NOT NULL DEFAULT 0,
    prep_median_s INTEGER,
    wait_count INTEGER NOT NULL DEFAULT 0,
    wait_sum_s INTEGER NOT NULL DEFAULT 0,
    wait_median_s INTEGER
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 3: Google place id + internal post-pickup feedback (phase 5).
  `
  ALTER TABLE branch_settings ADD COLUMN google_place_id TEXT;
  CREATE TABLE feedback (
    order_id TEXT PRIMARY KEY REFERENCES orders (id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX feedback_created_at ON feedback (created_at);
  `,
  // 4: loyalty stamp card (phase 6). Devices are only known by an HMAC of their token.
  `
  ALTER TABLE branch_settings ADD COLUMN loyalty_every INTEGER NOT NULL DEFAULT 5;
  ALTER TABLE branch_settings ADD COLUMN loyalty_reward_text TEXT;
  ALTER TABLE orders ADD COLUMN device_hash TEXT;
  ALTER TABLE orders ADD COLUMN stamped INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN reward_id INTEGER;
  CREATE TABLE loyalty_devices (
    token_hash TEXT PRIMARY KEY,
    stamps INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE loyalty_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL REFERENCES loyalty_devices (token_hash),
    earned_at INTEGER NOT NULL,
    attached_order_id TEXT,
    redeemed_at INTEGER
  );
  CREATE INDEX loyalty_rewards_open ON loyalty_rewards (token_hash, redeemed_at);
  `,
  // 5: promo space shown while an order is preparing (phase 7). Dates are local YYYY-MM-DD.
  `
  ALTER TABLE branch_settings ADD COLUMN promo_text TEXT;
  ALTER TABLE branch_settings ADD COLUMN promo_image TEXT;
  ALTER TABLE branch_settings ADD COLUMN promo_starts_at TEXT;
  ALTER TABLE branch_settings ADD COLUMN promo_ends_at TEXT;
  `,
  // 6: the PIN sealed with the vault key (vault.js), so the super can read it back.
  //    NULL for PINs set before this; they show as unknown until the next change.
  `
  ALTER TABLE branch_settings ADD COLUMN pin_sealed TEXT;
  `,
  // 7: the POS link. pos_numbers holds the numbers the POS gave out today: 'waiting' for the
  //    customer's scan, or 'done' (delivery, already claimed). Also: theme_version marks a
  //    branch whose color was already set or read from its logo, so it isn't guessed again.
  `
  ALTER TABLE branch_settings ADD COLUMN pos_token TEXT;
  ALTER TABLE branch_settings ADD COLUMN pos_last_event TEXT;
  ALTER TABLE branch_settings ADD COLUMN theme_version INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE pos_numbers (
    day TEXT NOT NULL,
    number INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting', 'done')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (day, number)
  );
  `,
  // 8: several POS terminals in one branch number on their own ("1-1001", "2-1001"), so a
  //    POS number is keyed by its full reference. orders.ref is what the customer's receipt
  //    says when it differs from the plain number. pos_only: numbers come from the POS only.
  `
  ALTER TABLE orders ADD COLUMN ref TEXT;
  ALTER TABLE branch_settings ADD COLUMN pos_only INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE pos_refs (
    day TEXT NOT NULL,
    ref TEXT NOT NULL,
    number INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting', 'done')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (day, ref)
  );
  INSERT INTO pos_refs (day, ref, number, state, created_at) SELECT day, CAST(number AS TEXT), number, state, created_at FROM pos_numbers;
  DROP TABLE pos_numbers;
  ALTER TABLE pos_refs RENAME TO pos_numbers;
  `,
  // 9: a QR per order (the customer screen shows it the moment the order is rung up; anyone
  //    who scans it follows that order). order_share: more than one phone on one order.
  //    orders.viewer: the first phone's client id, for when sharing is off.
  `
  ALTER TABLE branch_settings ADD COLUMN order_qr INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE branch_settings ADD COLUMN order_share INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE orders ADD COLUMN viewer TEXT;
  `,
  // 10: a revision per order, bumped on every change. Two cashier screens on one branch: a
  //     screen never shows an older state over a newer one, and a tap made on what is already
  //     stale is refused instead of moving the order twice.
  `
  ALTER TABLE orders ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
  `,
  // 11: takeaway numbers typed by the cashier. The POS numbers every order (dine-in, delivery,
  //     takeaway) in one row; the cashier types a takeaway receipt's number (27) and it gets the
  //     next takeaway number (3). pos_numbers.manual: a typed receipt (ref = the receipt);
  //     orders.receipt: the receipt number of such an order.
  `
  ALTER TABLE branch_settings ADD COLUMN manual_numbers INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pos_numbers ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN receipt TEXT;
  `,
  // 12: the receipt printer agent (a QR for the order at the end of every printed receipt).
  //     print_agent: its settings (JSON, null = off); print_last: the last receipt it saw.
  `
  ALTER TABLE branch_settings ADD COLUMN print_agent TEXT;
  ALTER TABLE branch_settings ADD COLUMN print_last TEXT;
  `,
];

export function openBranchDb(file, { backupFile } = {}) {
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  runMigrations(db, BRANCH_MIGRATIONS, { backupFile });
  return db;
}

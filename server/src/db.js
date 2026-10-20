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
];

export function openBranchDb(file, { backupFile } = {}) {
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  runMigrations(db, BRANCH_MIGRATIONS, { backupFile });
  return db;
}

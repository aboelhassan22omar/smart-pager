import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo TEXT,
  pin_hash TEXT NOT NULL,
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
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'picked', 'expired', 'cancelled')),
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  closed_at INTEGER,
  notify_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS orders_shop_status ON orders (shop_id, status);
CREATE INDEX IF NOT EXISTS orders_closed_at ON orders (closed_at);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('webpush', 'live_activity')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (order_id, kind, payload)
);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openControl } from './control.js';
import { openBranchDb } from './db.js';
import { vacuumInto } from './migrations.js';

const SETTINGS_COLUMNS = [
  'pin_hash', 'logo', 'qr_mode', 'qr_nonce', 'qr_prev_nonce', 'qr_rotated_at', 'static_key', 'next_number',
  'number_day', 'max_number', 'expire_hours', 'preparing_message', 'ready_message', 'accent_color',
  'google_review_url', 'review_clicks', 'created_at',
];
const ORDER_COLUMNS = ['id', 'number', 'status', 'created_at', 'ready_at', 'closed_at', 'notify_count', 'review_clicked_at'];

const columnsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * One-time move from the v1 single database (/data/pager.db, table `shops`) to v2:
 * control.db + one database per branch. Runs only when pager.db exists and control.db
 * does not. Everything is built in a staging folder and verified (row counts per shop)
 * before anything is moved; on any problem the staging folder is removed, pager.db is
 * left untouched and the error is thrown (the server then refuses to start).
 */
export function migrateFromV1({ dataDir, log }) {
  const oldFile = path.join(dataDir, 'pager.db');
  const controlFile = path.join(dataDir, 'control.db');
  if (!fs.existsSync(oldFile) || fs.existsSync(controlFile)) return { migrated: false };

  const staging = path.join(dataDir, '.v2-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  const src = new DatabaseSync(oldFile);
  const opened = [];
  let control;
  let movedTenants = false;
  let movedControl = false;
  try {
    src.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const backup = path.join(dataDir, 'backups', `pre-v2-${stamp()}`, 'pager.db');
    vacuumInto(src, backup);
    log.info({ backup }, 'v1 database backed up before migration');

    fs.mkdirSync(staging, { recursive: true });
    control = openControl(path.join(staging, 'control.db'));
    const shopCols = columnsOf(src, 'shops');
    const orderCols = columnsOf(src, 'orders');
    const shops = src.prepare('SELECT * FROM shops ORDER BY created_at').all();
    const report = [];

    for (const shop of shops) {
      control.createBrand({ id: shop.id, name: shop.name, createdAt: shop.created_at });
      control.createBranch({ id: shop.id, brandId: shop.id, name: shop.name, createdAt: shop.created_at });
      const dir = path.join(staging, 'tenants', shop.id, shop.id);
      const mediaDir = path.join(dir, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const db = openBranchDb(path.join(dir, 'pager.db'));
      opened.push(db);

      // Logo: /data/logos/<shop>-<ts>.<ext> -> media/logo-<ts>.<ext>
      let logo = null;
      if (shop.logo) {
        const from = path.join(dataDir, 'logos', shop.logo);
        if (fs.existsSync(from)) {
          logo = `logo-${shop.logo.slice(shop.id.length + 1)}`;
          fs.copyFileSync(from, path.join(mediaDir, logo));
        } else {
          log.warn({ shop: shop.id, file: shop.logo }, 'v1 logo file missing; branch starts without a logo');
        }
      }

      const cols = SETTINGS_COLUMNS.filter((c) => shopCols.has(c));
      const values = cols.map((c) => (c === 'logo' ? logo : shop[c]));
      db.prepare(`INSERT INTO branch_settings (id, ${cols.join(', ')}) VALUES (1, ${cols.map(() => '?').join(', ')})`)
        .run(...values);

      const oCols = ORDER_COLUMNS.filter((c) => orderCols.has(c));
      const insertOrder = db.prepare(`INSERT INTO orders (${oCols.join(', ')}) VALUES (${oCols.map(() => '?').join(', ')})`);
      const insertSub = db.prepare('INSERT INTO subscriptions (id, order_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)');
      const orders = src.prepare('SELECT * FROM orders WHERE shop_id = ?').all(shop.id);
      const subs = src.prepare(
        'SELECT s.* FROM subscriptions s JOIN orders o ON o.id = s.order_id WHERE o.shop_id = ?',
      ).all(shop.id);
      db.exec('BEGIN');
      for (const o of orders) insertOrder.run(...oCols.map((c) => o[c]));
      for (const s of subs) insertSub.run(s.id, s.order_id, s.kind, s.payload, s.created_at);
      db.exec('COMMIT');

      const got = {
        orders: Number(db.prepare('SELECT COUNT(*) AS c FROM orders').get().c),
        subscriptions: Number(db.prepare('SELECT COUNT(*) AS c FROM subscriptions').get().c),
      };
      if (got.orders !== orders.length || got.subscriptions !== subs.length) {
        throw new Error(`row count mismatch for ${shop.id}: orders ${got.orders}/${orders.length}, subscriptions ${got.subscriptions}/${subs.length}`);
      }
      report.push({ shop: shop.id, ...got });
    }

    for (const db of opened) db.close();
    opened.length = 0;
    control.close();
    control = null;
    src.close();

    // Verified: move into place, then retire the v1 file.
    if (fs.existsSync(path.join(dataDir, 'tenants'))) throw new Error('tenants/ already exists; refusing to overwrite');
    fs.renameSync(path.join(staging, 'tenants'), path.join(dataDir, 'tenants'));
    movedTenants = true;
    fs.renameSync(path.join(staging, 'control.db'), controlFile);
    movedControl = true;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(oldFile + suffix)) fs.renameSync(oldFile + suffix, `${path.join(dataDir, 'pager.db.migrated')}${suffix}`);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    log.info({ shops: report }, 'migrated v1 database to per-branch databases');
    return { migrated: true, report };
  } catch (err) {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    try {
      control?.close();
    } catch {
      /* already closed */
    }
    try {
      src.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(staging, { recursive: true, force: true });
    if (movedControl) {
      // Only renaming pager.db failed: v2 is complete, keep it (pager.db is still there too).
      log.error({ err: err.message }, 'v1 migration finished but pager.db could not be renamed');
      throw err;
    }
    // Undo only what this run moved; never touch anything that existed before.
    if (movedTenants) fs.rmSync(path.join(dataDir, 'tenants'), { recursive: true, force: true, maxRetries: 3 });
    log.error({ err: err.message }, 'v1 migration aborted; pager.db left untouched');
    throw err;
  }
}

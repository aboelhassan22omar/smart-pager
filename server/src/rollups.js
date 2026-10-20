// Hourly rollups per branch (DESIGN §18.1). Rows in hourly_stats are kept forever; the
// orders they summarise are kept 90 days. Hours are local hours in the shop timezone.

import { hourStartIn } from './util.js';

const HOUR = 3_600_000;

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Durations used everywhere (seconds):
 *   prep = created -> ready        wait = ready -> picked
 *   late = longer than late_after_minutes until ready (or until it closed / now, if never ready)
 */
export function orderTimes(order, lateMs, now) {
  const prep = order.ready_at != null ? Math.round((order.ready_at - order.created_at) / 1000) : null;
  const wait = order.status === 'picked' && order.ready_at != null && order.closed_at != null
    ? Math.round((order.closed_at - order.ready_at) / 1000)
    : null;
  const end = order.ready_at ?? order.closed_at ?? now;
  return { prep, wait, late: end - order.created_at > lateMs };
}

export function summarize(orders, lateMs, now) {
  const prep = [];
  const wait = [];
  const out = { orders: orders.length, picked: 0, cancelled: 0, expired: 0, late: 0 };
  for (const o of orders) {
    if (o.status === 'picked') out.picked++;
    if (o.status === 'cancelled') out.cancelled++;
    if (o.status === 'expired') out.expired++;
    const t = orderTimes(o, lateMs, now);
    if (t.late && o.status !== 'cancelled') out.late++;
    if (t.prep != null) prep.push(t.prep);
    if (t.wait != null) wait.push(t.wait);
  }
  return {
    ...out,
    prep_count: prep.length,
    prep_sum_s: prep.reduce((a, b) => a + b, 0),
    prep_median_s: median(prep),
    wait_count: wait.length,
    wait_sum_s: wait.reduce((a, b) => a + b, 0),
    wait_median_s: median(wait),
    prep,
    wait,
  };
}

const COLUMNS = ['orders', 'picked', 'cancelled', 'expired', 'late', 'prep_count', 'prep_sum_s', 'prep_median_s',
  'wait_count', 'wait_sum_s', 'wait_median_s'];

/**
 * Recomputes the current and previous hour plus every hour that had an order created,
 * readied or closed since the last run. Exact values straight from `orders`.
 */
export function rollupBranch(store, { tz, now = Date.now() } = {}) {
  const { db } = store;
  const settings = db.prepare('SELECT late_after_minutes FROM branch_settings WHERE id = 1').get();
  if (!settings) return 0;
  const lateMs = settings.late_after_minutes * 60_000;
  const cursor = Number(db.prepare("SELECT value FROM meta WHERE key = 'rollup_at'").get()?.value ?? 0);

  const hours = new Set([hourStartIn(tz, now), hourStartIn(tz, now - HOUR)]);
  const touched = db.prepare(`SELECT created_at FROM orders
                              WHERE created_at > ? OR ready_at > ? OR closed_at > ?`).all(cursor, cursor, cursor);
  for (const row of touched) hours.add(hourStartIn(tz, row.created_at));

  const inHour = db.prepare('SELECT * FROM orders WHERE created_at >= ? AND created_at < ?');
  const upsert = db.prepare(`INSERT OR REPLACE INTO hourly_stats (hour_start, ${COLUMNS.join(', ')})
                             VALUES (?, ${COLUMNS.map(() => '?').join(', ')})`);
  const drop = db.prepare('DELETE FROM hourly_stats WHERE hour_start = ?');
  db.exec('BEGIN');
  try {
    for (const h of hours) {
      const orders = inHour.all(h, h + HOUR);
      if (!orders.length) {
        drop.run(h);
        continue;
      }
      const s = summarize(orders, lateMs, now);
      upsert.run(h, ...COLUMNS.map((c) => s[c]));
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('rollup_at', ?)").run(String(now));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return hours.size;
}

// Queue position + ETA for a preparing order (DESIGN §18.2).
//   position: preparing orders of the same branch created before this one
//   ETA:      25th-75th percentile of prep times, same weekday + hour over the last 14 days;
//             falls back to all of the last 14 days; < 20 samples -> position only.

import { localSlot } from './util.js';

const WINDOW_MS = 14 * 86_400_000;
const MIN_SAMPLES = 20;
const CACHE_MS = 5 * 60_000;

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

/** {p25, p75, n} in ms, or null when there is not enough history. Cached per branch for 5 min. */
export function etaStats(ctx, { tz, now = Date.now(), cache }) {
  const hit = cache?.get(ctx.branch.id);
  const slot = localSlot(tz, now);
  const key = `${slot.weekday}:${slot.hour}`;
  if (hit && hit.key === key && now - hit.at < CACHE_MS) return hit.stats;

  const rows = ctx.store.db.prepare(
    'SELECT created_at, ready_at FROM orders WHERE created_at >= ? AND ready_at IS NOT NULL',
  ).all(now - WINDOW_MS);
  const all = [];
  const same = [];
  for (const r of rows) {
    const ms = r.ready_at - r.created_at;
    if (ms <= 0) continue;
    all.push(ms);
    const s = localSlot(tz, r.created_at);
    if (s.weekday === slot.weekday && s.hour === slot.hour) same.push(ms);
  }
  const pick = same.length >= MIN_SAMPLES ? same : all.length >= MIN_SAMPLES ? all : null;
  let stats = null;
  if (pick) {
    pick.sort((a, b) => a - b);
    stats = { p25: percentile(pick, 0.25), p75: percentile(pick, 0.75), n: pick.length };
  }
  cache?.set(ctx.branch.id, { key, at: now, stats });
  return stats;
}

/**
 * Queue info for one order, or null when it is not preparing. The ETA is sent as absolute
 * times so the page can count down on its own (no polling); it only changes with the position.
 */
export function queueFor(ctx, order, stats) {
  if (order.status !== 'preparing') return null;
  const ahead = Number(ctx.store.db.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'preparing' AND created_at < ?",
  ).get(order.created_at).n);
  return {
    ahead,
    eta: stats ? { lowAt: order.created_at + stats.p25, highAt: order.created_at + stats.p75 } : null,
  };
}

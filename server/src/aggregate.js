// The ONLY module that reads across branches. Used by the brand-owner dashboard (its own
// brand's branches only — the caller passes a brand id) and by the super dashboard.

import { featureFlags, planView } from './plans.js';
import { median, rollupBranch, summarize } from './rollups.js';
import { dayIn, dayStartIn, localSlot, startOfDayIn } from './util.js';
import { logoUrl } from './views.js';

function branchStats(ctx, shop, { since, now }) {
  const db = ctx.store.db;
  const late = (shop.late_after_minutes ?? 10) * 60_000;
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('preparing', 'ready') THEN 1 ELSE 0 END) AS open_now,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN created_at >= ? AND COALESCE(ready_at, closed_at, ?) - created_at > ? THEN 1 ELSE 0 END) AS late_today,
      MAX(created_at) AS last_order_at
    FROM orders`).get(since, since, now, late);
  return {
    openNow: Number(row.open_now ?? 0),
    ordersToday: Number(row.today ?? 0),
    lateToday: Number(row.late_today ?? 0),
    lastOrderAt: row.last_order_at ?? null,
  };
}

function branchSummary({ tenants, screens, config }, branch, now) {
  const ctx = tenants.get(branch.id);
  const shop = ctx?.store.getShop();
  const stats = shop ? branchStats(ctx, shop, { since: startOfDayIn(config.tz, now), now }) : null;
  return {
    id: branch.id,
    brandId: branch.brand_id,
    name: branch.name,
    area: branch.area,
    logoUrl: shop ? logoUrl(shop) : null,
    plan: planView(branch, now),
    paidUntil: branch.paid_until ?? null,
    trialEndsAt: branch.trial_ends_at ?? null,
    features: featureFlags(branch),
    forcedOff: JSON.parse(branch.forced_off || '[]'),
    screens: screens.count(branch.id),
    lastActivityAt: branch.last_activity_at ?? stats?.lastOrderAt ?? null,
    avgRating7d: null, // phase 5 (internal feedback)
    ...(stats ?? { openNow: 0, ordersToday: 0, lateToday: 0 }),
  };
}

/** Branches of one brand (brand-owner dashboard). */
export function brandOverview(deps, brandId, now = Date.now()) {
  const brand = deps.control.getBrand(brandId);
  if (!brand) return null;
  return {
    brand: { id: brand.id, name: brand.name },
    branches: deps.control.branchesOfBrand(brandId).map((b) => branchSummary(deps, b, now)),
  };
}

/** Every brand with its branches (super dashboard). */
export function superOverview(deps, now = Date.now()) {
  const byBrand = new Map(deps.control.listBrands().map((b) => [b.id, { id: b.id, name: b.name, owners: [], branches: [] }]));
  for (const branch of deps.control.listBranches()) byBrand.get(branch.brand_id)?.branches.push(branchSummary(deps, branch, now));
  for (const brand of byBrand.values()) {
    brand.owners = deps.control.ownersOfBrand(brand.id).map((o) => ({ id: o.id, username: o.username, email: o.email }));
  }
  return { brands: [...byBrand.values()], serverNow: now };
}

// ---------------------------------------------------------------------------
// Analytics (brand dashboard): orders per day, peak hours, medians, late %.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RETENTION_MS = 90 * DAY;

/** Count-weighted median of per-hour medians (only used beyond order retention). */
function weightedMedian(pairs) {
  const items = pairs.filter(([m, w]) => m != null && w > 0).sort((a, b) => a[0] - b[0]);
  const total = items.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [m, w] of items) {
    acc += w;
    if (acc >= total / 2) return m;
  }
  return null;
}

function emptyTotals() {
  return { orders: 0, picked: 0, cancelled: 0, expired: 0, late: 0, prep_sum_s: 0, prep_count: 0, wait_sum_s: 0, wait_count: 0 };
}

const SUM_KEYS = Object.keys(emptyTotals());

function addInto(t, row) {
  for (const k of SUM_KEYS) t[k] += Number(row[k] ?? 0);
}

function finish(t, { prep, wait, approxPrep, approxWait }) {
  return {
    orders: t.orders,
    picked: t.picked,
    cancelled: t.cancelled,
    expired: t.expired,
    late: t.late,
    latePct: t.orders ? Math.round((t.late / t.orders) * 1000) / 10 : 0,
    prepMedianS: prep ? median(prep) : approxPrep,
    waitMedianS: wait ? median(wait) : approxWait,
    prepAvgS: t.prep_count ? Math.round(t.prep_sum_s / t.prep_count) : null,
    waitAvgS: t.wait_count ? Math.round(t.wait_sum_s / t.wait_count) : null,
  };
}

/**
 * @param from,to  YYYY-MM-DD (inclusive, local days)
 * @param branchId optional: one branch of the brand
 */
export function brandAnalytics(deps, brandId, { from, to, branchId = null, now = Date.now() }) {
  const { control, tenants, config } = deps;
  const tz = config.tz;
  const start = dayStartIn(tz, from);
  const end = dayStartIn(tz, to) + DAY + 3_600_000; // next local midnight (+1h slack for DST), trimmed below
  const endExact = startOfDayIn(tz, end - 3_600_000);
  const exact = start >= now - RETENTION_MS;
  const branches = control.branchesOfBrand(brandId).filter((b) => !branchId || b.id === branchId);

  const days = [];
  for (let t = start; t < endExact; t = startOfDayIn(tz, t + DAY + 3_600_000)) days.push(dayIn(tz, new Date(t)));

  const totalAll = emptyTotals();
  const pooled = { prep: [], wait: [], prepPairs: [], waitPairs: [] };
  const dailyAll = new Map(days.map((d) => [d, { day: d, orders: 0, late: 0, picked: 0 }]));
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  const perBranch = [];

  for (const branch of branches) {
    const ctx = tenants.get(branch.id);
    const shop = ctx?.store.getShop();
    if (!shop) continue;
    rollupBranch(ctx.store, { tz, now }); // fresh numbers for the current hour
    const rows = ctx.store.db.prepare('SELECT * FROM hourly_stats WHERE hour_start >= ? AND hour_start < ? ORDER BY hour_start')
      .all(start, endExact);

    const totals = emptyTotals();
    const daily = new Map(days.map((d) => [d, { day: d, ...emptyTotals() }]));
    const prepPairs = [];
    const waitPairs = [];
    for (const row of rows) {
      addInto(totals, row);
      const day = dayIn(tz, new Date(row.hour_start));
      if (daily.has(day)) addInto(daily.get(day), row);
      const slot = localSlot(tz, row.hour_start);
      heatmap[slot.weekday][slot.hour] += row.orders;
      prepPairs.push([row.prep_median_s, row.prep_count]);
      waitPairs.push([row.wait_median_s, row.wait_count]);
    }

    let prep = null;
    let wait = null;
    if (exact) {
      const lateMs = (shop.late_after_minutes ?? 10) * 60_000;
      const orders = ctx.store.db.prepare('SELECT * FROM orders WHERE created_at >= ? AND created_at < ?').all(start, endExact);
      const s = summarize(orders, lateMs, now);
      prep = s.prep;
      wait = s.wait;
      pooled.prep.push(...prep);
      pooled.wait.push(...wait);
    }
    pooled.prepPairs.push(...prepPairs);
    pooled.waitPairs.push(...waitPairs);
    addInto(totalAll, totals);
    for (const d of daily.values()) {
      const all = dailyAll.get(d.day);
      all.orders += d.orders;
      all.late += d.late;
      all.picked += d.picked;
    }
    perBranch.push({
      id: branch.id,
      name: branch.name,
      area: branch.area,
      totals: finish(totals, { prep, wait, approxPrep: weightedMedian(prepPairs), approxWait: weightedMedian(waitPairs) }),
      daily: [...daily.values()].map((d) => ({
        day: d.day, orders: d.orders, picked: d.picked, cancelled: d.cancelled, expired: d.expired, late: d.late,
        prepAvgS: d.prep_count ? Math.round(d.prep_sum_s / d.prep_count) : null,
        waitAvgS: d.wait_count ? Math.round(d.wait_sum_s / d.wait_count) : null,
      })),
    });
  }

  return {
    range: { from, to },
    exact,
    total: finish(totalAll, {
      prep: exact ? pooled.prep : null,
      wait: exact ? pooled.wait : null,
      approxPrep: weightedMedian(pooled.prepPairs),
      approxWait: weightedMedian(pooled.waitPairs),
    }),
    daily: [...dailyAll.values()],
    heatmap, // [weekday 0=Sunday][hour 0-23] -> orders
    branches: perBranch,
  };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  // Quote when needed; neutralise spreadsheet formulas (CSV injection).
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** One row per branch per day. Averages (not medians) so rows can be summed in a sheet. */
export function analyticsCsv(report) {
  const header = ['date', 'branch_id', 'branch_name', 'orders', 'picked', 'cancelled', 'expired', 'late', 'late_pct',
    'avg_prep_min', 'avg_pickup_wait_min'];
  const lines = [header.join(',')];
  const min = (s) => (s == null ? '' : (s / 60).toFixed(1));
  for (const b of report.branches) {
    for (const d of b.daily) {
      const latePct = d.orders ? ((d.late / d.orders) * 100).toFixed(1) : '0.0';
      lines.push([d.day, b.id, b.name, d.orders, d.picked, d.cancelled, d.expired, d.late, latePct, min(d.prepAvgS), min(d.waitAvgS)]
        .map(csvCell).join(','));
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`; // BOM so Excel opens Arabic names correctly
}

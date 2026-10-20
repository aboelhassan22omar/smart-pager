// The ONLY module that reads across branches. Used by the brand-owner dashboard (its own
// brand's branches only — the caller passes a brand id) and by the super dashboard.

import { featureFlags, planView } from './plans.js';
import { startOfDayIn } from './util.js';
import { logoUrl } from './views.js';

// Phase 3 makes this a branch setting (late_after_minutes); until then the default.
const DEFAULT_LATE_MINUTES = 10;

function branchStats(ctx, { since, now }) {
  const db = ctx.store.db;
  const late = DEFAULT_LATE_MINUTES * 60_000;
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
  const stats = shop ? branchStats(ctx, { since: startOfDayIn(config.tz, now), now }) : null;
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

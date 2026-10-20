// One-time data upgrades that span the control DB and branch DBs (run on boot, idempotent).

const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

/** Place id from a pasted value: the id itself or any Google URL carrying placeid=. */
export function parsePlaceId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  if (PLACE_ID_RE.test(raw)) return raw;
  try {
    const id = new URL(raw).searchParams.get('placeid');
    return id && PLACE_ID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Q3/Q4: branches that had a v1 Google review link keep working — the review feature is
 * switched on for them, and a place id is extracted from the link when it carries one.
 */
export function upgradeLegacyReview({ control, tenants }) {
  for (const branch of control.listBranches()) {
    const ctx = tenants.get(branch.id);
    const shop = ctx?.store.getShop();
    if (!shop) continue;
    const done = ctx.store.db.prepare("SELECT value FROM meta WHERE key = 'legacy_review'").get();
    if (done) continue;
    if (shop.google_review_url) {
      const id = parsePlaceId(shop.google_review_url);
      if (id && !shop.google_place_id) ctx.store.updateShop({ google_place_id: id });
      if (!branch.ff_review) control.setFeature(branch.id, 'review', true);
    }
    ctx.store.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_review', '1')").run();
  }
}

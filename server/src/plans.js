// Branch plans (DESIGN §17). The stored plan_status is only a cache for dashboards;
// requests always use effectivePlan().

export const DAY_MS = 24 * 3600 * 1000;
export const GRACE_DAYS = 3;
export const PLAN_STATUSES = ['trial', 'active', 'past_due', 'suspended'];
export const FEATURES = ['review', 'loyalty', 'promo'];

/**
 * deleted_at set    -> suspended (in the trash)
 * suspended_manual  -> suspended
 * paid_until set    -> active until paid_until, past_due for 3 more days, then suspended
 * trial_ends_at set -> trial until then, then suspended
 * neither           -> active (branches migrated from v1: no expiry until a first payment)
 */
export function effectivePlan(branch, now = Date.now()) {
  if (branch.deleted_at) return { status: 'suspended', reason: 'deleted', until: null };
  if (branch.suspended_manual) return { status: 'suspended', reason: 'manual', until: null };
  if (branch.paid_until != null) {
    if (now <= branch.paid_until) return { status: 'active', until: branch.paid_until };
    const graceEnd = branch.paid_until + GRACE_DAYS * DAY_MS;
    if (now <= graceEnd) return { status: 'past_due', until: graceEnd };
    return { status: 'suspended', reason: 'unpaid', until: null };
  }
  if (branch.trial_ends_at != null) {
    if (now < branch.trial_ends_at) return { status: 'trial', until: branch.trial_ends_at };
    return { status: 'suspended', reason: 'trial_ended', until: null };
  }
  return { status: 'active', until: null };
}

export function planView(branch, now = Date.now()) {
  const plan = effectivePlan(branch, now);
  return {
    status: plan.status,
    reason: plan.reason ?? null,
    until: plan.until,
    daysLeft: plan.until == null ? null : Math.max(0, Math.ceil((plan.until - now) / DAY_MS)),
  };
}

export const canClaim = (branch, now = Date.now()) => effectivePlan(branch, now).status !== 'suspended';

/** Effective feature flags: the owner's toggle, unless super forced it off. */
export function featureFlags(branch) {
  const forced = new Set(JSON.parse(branch.forced_off || '[]'));
  return Object.fromEntries(FEATURES.map((f) => [f, Boolean(branch[`ff_${f}`]) && !forced.has(f)]));
}

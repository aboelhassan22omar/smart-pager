import { DEMO_ID } from './demo.js';
import { sendMail, smtpConfig } from './mail.js';
import { effectivePlan } from './plans.js';
import { branchTz, businessDay, localSlot } from './util.js';

// "The cashier screen of a branch is closed at an hour it is normally busy": shown on the super
// and owner dashboards, and emailed to ALERT_EMAIL when SMTP is set up.

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const WEEKS = 4;
const BUSY_WEEKS = 3; // orders in this weekday-hour in at least 3 of the last 4 weeks
export const CLOSED_AFTER_MS = 20 * 60_000;

const busyCache = new Map(); // branchId -> { hour, busy }

/** True when this branch had orders at this weekday and hour in most of the last weeks. */
export function usuallyBusy(ctx, tz, now = Date.now()) {
  const hour = Math.floor(now / HOUR);
  const cached = busyCache.get(ctx.branch.id);
  if (cached?.hour === hour) return cached.busy;
  const slot = localSlot(tz, now);
  const rows = ctx.store.db.prepare('SELECT hour_start FROM hourly_stats WHERE orders > 0 AND hour_start >= ? AND hour_start < ?')
    .all(now - WEEKS * WEEK - HOUR, now - HOUR);
  const weeks = new Set();
  for (const { hour_start: at } of rows) {
    const s = localSlot(tz, at);
    if (s.weekday === slot.weekday && s.hour === slot.hour) weeks.add(Math.floor((now - at) / WEEK));
  }
  const busy = weeks.size >= BUSY_WEEKS;
  busyCache.set(ctx.branch.id, { hour, busy });
  return busy;
}

/** { closedMinutes } when the branch's cashier screen is closed in its usual hours, else null. */
export function screenAlert({ screens, config, tenants }, branch, now = Date.now()) {
  if (branch.id === DEMO_ID || branch.deleted_at || effectivePlan(branch, now).status === 'suspended') return null;
  const since = screens.barClosedSince(branch.id);
  if (since == null || now - since < CLOSED_AFTER_MS) return null;
  const ctx = tenants.get(branch.id);
  if (!ctx?.store.getShop() || !usuallyBusy(ctx, branchTz(branch, config), now)) return null;
  return { closedMinutes: Math.round((now - since) / 60_000) };
}

const mailed = new Set(); // branchId|business day: one email per branch per day

/** Emails new screen alerts to ALERT_EMAIL (needs SMTP). Returns how many were sent. */
export async function mailScreenAlerts(deps, { now = Date.now(), send = sendMail } = {}) {
  const { config, control, log } = deps;
  const smtp = smtpConfig(config);
  if (!smtp || !config.alertEmail) return 0;
  let sent = 0;
  for (const branch of control.listBranches()) {
    const alert = screenAlert(deps, branch, now);
    if (!alert) continue;
    const key = `${branch.id}|${businessDay(branchTz(branch, config), branch.day_start_hour ?? 0, now)}`;
    if (mailed.has(key)) continue;
    mailed.add(key);
    try {
      await send(smtp, {
        to: config.alertEmail,
        subject: `شاشة الكاشير مقفولة: ${branch.name}`,
        text: `شاشة الكاشير في فرع ${branch.name} (${branch.id}) مقفولة من ${alert.closedMinutes} دقيقة، والوقت ده عادةً بيبقى فيه طلبات.\n`
          + `العملاء ممكن يمسحوا الكود ومحدش يشوف طلباتهم.\n\n${config.publicUrl}/super`,
      });
      sent++;
    } catch (err) {
      mailed.delete(key);
      log?.warn({ err, branch: branch.id }, 'screen alert email failed');
    }
  }
  return sent;
}

// Optional weekly summary email to brand owners (Mondays 09:00 in TZ). Off without SMTP.

import { brandAnalytics } from './aggregate.js';
import { sendMail, smtpConfig } from './mail.js';
import { dayIn, localSlot } from './util.js';

const DAY = 86_400_000;
const minutes = (s) => (s == null ? '—' : `${Math.max(1, Math.round(s / 60))} دقيقة`);

/** ISO-like week key of the Monday that starts the week containing `now` (local). */
export function weekKey(tz, now) {
  const { weekday } = localSlot(tz, now);
  return dayIn(tz, new Date(now - ((weekday + 6) % 7) * DAY));
}

export function summaryText(report, brand, config) {
  const lines = [
    `ملخص الأسبوع: ${brand.name}`,
    `من ${report.range.from} لحد ${report.range.to}`,
    '',
    `كل الفروع: ${report.total.orders} طلب، متأخر ${report.total.latePct}%، وقت التحضير ${minutes(report.total.prepMedianS)}`,
    '',
  ];
  for (const b of report.branches) {
    lines.push(`${b.name}: ${b.totals.orders} طلب، متأخر ${b.totals.latePct}%، وقت التحضير ${minutes(b.totals.prepMedianS)}، الاستلام ${minutes(b.totals.waitMedianS)}`);
  }
  lines.push('', `التفاصيل: ${config.publicUrl}/brand/${brand.id}`, '', 'Smart Pager by AUREXIS');
  return lines.join('\n');
}

/**
 * Sends at most one summary per brand per week, on/after Monday 09:00 local time.
 * Returns the number of emails sent.
 */
export async function runWeeklySummaries(deps, { now = Date.now(), send = sendMail } = {}) {
  const { config, control, log } = deps;
  const smtp = smtpConfig(config);
  if (!smtp) return 0;
  const slot = localSlot(config.tz, now);
  if (slot.weekday !== 1 || slot.hour < 9) return 0;
  const week = weekKey(config.tz, now);
  let sent = 0;
  for (const brand of control.listBrands()) {
    if (brand.last_summary_week === week || brand.deleted_at) continue;
    const to = control.ownersOfBrand(brand.id).map((o) => o.email).filter(Boolean);
    if (to.length) {
      const report = brandAnalytics(deps, brand.id, {
        from: dayIn(config.tz, new Date(now - 7 * DAY)),
        to: dayIn(config.tz, new Date(now - DAY)),
        now,
      });
      try {
        await send(smtp, { to, subject: `Smart Pager: ملخص الأسبوع لـ ${brand.name}`, text: summaryText(report, brand, config) });
        sent++;
      } catch (err) {
        log?.warn({ brand: brand.id, err: err.message }, 'weekly summary email failed');
        continue; // retried on the next hourly run
      }
    }
    control.markSummarySent(brand.id, week);
  }
  return sent;
}

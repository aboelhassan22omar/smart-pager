// Inside the cashier app only: page errors and long connection drops go to the server, where the
// super sees them per device ("سجل الأخطاء"). Never blocks or throws; at most 20 an hour, each
// distinct message once an hour (the bar page stays open for days).

import { isCashierApp } from './util.js';

const MAX_PER_HOUR = 20;
const OFFLINE_REPORT_MS = 30_000;
let sent = 0;
let windowStart = Date.now();
const seen = new Set();

export function report(kind, message, detail = '') {
  if (typeof document === 'undefined' || !isCashierApp(document)) return;
  if (Date.now() - windowStart > 3_600_000) {
    windowStart = Date.now();
    sent = 0;
    seen.clear();
  }
  if (sent >= MAX_PER_HOUR) return;
  const text = String(message ?? '').slice(0, 300) || 'خطأ من غير رسالة';
  const key = `${kind}|${text}`;
  if (seen.has(key)) return;
  seen.add(key);
  sent++;
  fetch('/api/app/report', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, message: text, detail: String(detail ?? '').slice(0, 2000), page: location.pathname }),
  }).catch(() => {});
}

/** Call with the connection state; a drop longer than 30 s is reported once it is back. */
export function connectionWatch() {
  let downSince = null;
  return (online) => {
    if (!online) {
      downSince ??= Date.now();
      return;
    }
    if (downSince && Date.now() - downSince >= OFFLINE_REPORT_MS) {
      const s = Math.round((Date.now() - downSince) / 1000);
      report('offline', `الاتصال بالسيرفر انقطع ${s >= 120 ? `${Math.round(s / 60)} دقيقة` : `${s} ثانية`}`);
    }
    downSince = null;
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && isCashierApp(document)) {
  window.addEventListener('error', (e) => {
    report('error', e.message, `${e.filename ?? ''}:${e.lineno ?? ''}:${e.colno ?? ''}\n${e.error?.stack ?? ''}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    report('error', e.reason?.message ?? String(e.reason), e.reason?.stack ?? '');
  });
}

// Shared helpers. Must stay import-safe in Node (no DOM access at module top level).

export const SPLASH_MIN_MS = 1100;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body, raw, contentType, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (raw !== undefined) {
    init.body = raw;
    init.headers['content-type'] = contentType;
  } else if (body !== undefined || method !== 'GET') {
    init.body = JSON.stringify(body ?? {});
    init.headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'مفيش اتصال بالإنترنت. جرّب تاني');
  }
  noteBuild(res.headers.get('x-build'));
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'حصلت مشكلة. جرّب تاني', data);
  return data;
}

// ---------- a new version on the server: staff pages reload themselves ----------
// Every reply carries the server's build. A page that opted in reloads once the build changes,
// at a moment it loses nothing: no form or sheet open, nothing being typed, nothing unsent.

let autoReload = false;
let seenBuild = null;
let reloading = false;
const holds = [];

/** Staff pages (cashier, customer screen, owner, super) take new versions by themselves. */
export function reloadOnNewVersion() {
  autoReload = true;
}

/** The page says when a reload now would lose something (a tap not sent yet). */
export function holdReloadWhile(fn) {
  holds.push(fn);
}

/** Something on the page would be lost by a reload or an app update right now. */
export function pageBusy(doc = globalThis.document) {
  if (!doc) return false;
  const el = doc.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.value) return true;
  const shown = (m) => (m.checkVisibility ? m.checkVisibility() : m.offsetParent !== null);
  if ([...doc.querySelectorAll('[aria-modal="true"]')].some(shown)) return true;
  return holds.some((fn) => {
    try {
      return fn();
    } catch {
      return false;
    }
  });
}

export function noteBuild(build) {
  if (!build) return;
  if (seenBuild == null) {
    seenBuild = build;
    return;
  }
  if (build === seenBuild || !autoReload || reloading || typeof location === 'undefined') return;
  reloading = true;
  const attempt = () => {
    if (pageBusy()) setTimeout(attempt, 5000);
    else location.reload();
  };
  attempt();
}

export function shopIdFromPath(pathname) {
  return decodeURIComponent(pathname.split('/')[2] ?? '');
}

/** Running inside the brand's cashier app (cookie set by /app/<brand>/start). */
export function isCashierApp(doc = globalThis.document) {
  return Boolean(doc) && /(^|;\s*)sp_app=/.test(doc.cookie ?? '');
}

export function isIOS(nav) {
  return /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

export function minutesSince(ts, now = Date.now()) {
  return Math.max(0, Math.floor((now - ts) / 60000));
}

export function elapsedLabel(ts, now = Date.now()) {
  const m = minutesSince(ts, now);
  if (m < 1) return 'دلوقتي';
  if (m < 60) return `من ${m} د`;
  return `من ${Math.floor(m / 60)} س ${m % 60} د`;
}

export function base64UrlToBytes(value) {
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const bin = atob((value + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

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

export async function api(path, { method = 'GET', body, raw, contentType } = {}) {
  const init = { method, headers: {}, credentials: 'same-origin' };
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
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'حصلت مشكلة. جرّب تاني', data);
  return data;
}

export function shopIdFromPath(pathname) {
  return decodeURIComponent(pathname.split('/')[2] ?? '');
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

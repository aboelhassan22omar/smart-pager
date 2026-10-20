import path from 'node:path';

const str = (value, fallback) => (value === undefined || value === '' ? fallback : value);

function int(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Push services the server is allowed to POST to (prevents SSRF through /api/subscribe).
export const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  '*.googleapis.com',
  '*.push.services.mozilla.com',
  '*.push.apple.com',
  '*.notify.windows.com',
];

export function loadConfig(env = process.env) {
  const port = int(env.PORT, 3000, 0, 65535);
  const publicUrl = str(env.PUBLIC_URL, `http://localhost:${port}`).replace(/\/+$/, '');
  return {
    port,
    host: str(env.HOST, '0.0.0.0'),
    dataDir: path.resolve(str(env.DATA_DIR, './data')),
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    tz: str(env.TZ, 'Africa/Cairo'),
    trustProxy: str(env.TRUST_PROXY, 'loopback,linklocal,uniquelocal'),
    logLevel: str(env.LOG_LEVEL, 'info'),
    nonceRotateSeconds: int(env.NONCE_ROTATE_SECONDS, 60, 5, 3600),
    claimRatePerMin: int(env.CLAIM_RATE_PER_MIN, 6, 1, 100000),
    loginRatePerMin: int(env.LOGIN_RATE_PER_MIN, 5, 1, 100000),
    jobIntervalSeconds: int(env.JOB_INTERVAL_SECONDS, 60, 1, 3600),
    jobBatch: int(env.JOB_BATCH, 100, 1, 100000),
    tenantDbCache: int(env.TENANT_DB_CACHE, 200, 1, 100000),
    adminToken: str(env.ADMIN_TOKEN, ''),
    cookieSecret: str(env.COOKIE_SECRET, ''),
    pushHosts: str(env.PUSH_ENDPOINT_HOSTS, DEFAULT_PUSH_HOSTS.join(','))
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    vapid: {
      publicKey: str(env.VAPID_PUBLIC_KEY, ''),
      privateKey: str(env.VAPID_PRIVATE_KEY, ''),
      subject: str(env.VAPID_SUBJECT, 'mailto:hello@aurexis.cc'),
    },
    apple: {
      teamId: str(env.APPLE_TEAM_ID, ''),
      appId: str(env.APPLE_APP_ID, ''),
      appBundleId: str(env.APPLE_APP_BUNDLE_ID, 'cc.aurexis.pager'),
      clipBundleId: str(env.APPLE_CLIP_BUNDLE_ID, 'cc.aurexis.pager.Clip'),
      keyId: str(env.APNS_KEY_ID, ''),
      keyPath: str(env.APNS_KEY_PATH, ''),
      env: env.APNS_ENV === 'sandbox' ? 'sandbox' : 'production',
    },
  };
}

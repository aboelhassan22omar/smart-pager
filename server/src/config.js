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

// Off-site backups: on only when all five BACKUP_S3_* values are set.
function backupS3(env) {
  const s3 = {
    endpoint: str(env.BACKUP_S3_ENDPOINT, ''),
    bucket: str(env.BACKUP_S3_BUCKET, ''),
    region: str(env.BACKUP_S3_REGION, ''),
    accessKeyId: str(env.BACKUP_S3_ACCESS_KEY_ID, ''),
    secretAccessKey: str(env.BACKUP_S3_SECRET_ACCESS_KEY, ''),
  };
  if (Object.values(s3).some((v) => !v)) return null;
  const prefix = str(env.BACKUP_S3_PREFIX, 'smart-pager').replace(/^\/+|\/+$/g, '');
  return { ...s3, prefix: prefix ? `${prefix}/` : '' };
}

export function loadConfig(env = process.env) {
  const port = int(env.PORT, 3000, 0, 65535);
  const publicUrl = str(env.PUBLIC_URL, `http://localhost:${port}`).replace(/\/+$/, '');
  return {
    port,
    host: str(env.HOST, '0.0.0.0'),
    dataDir: path.resolve(str(env.DATA_DIR, './data')),
    // Cashier app templates (built by CI from apps/), see src/native/packages.js
    nativeDir: path.resolve(str(env.NATIVE_DIR, './native')),
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
    // scrypt hash (node src/cli.js hash-password) for /super; empty = super dashboard disabled
    superPasswordHash: str(env.SUPER_PASSWORD_HASH, ''),
    trialDays: int(env.TRIAL_DAYS, 3, 0, 365),
    // Optional weekly owner summary. Off unless SMTP_HOST is set.
    smtp: {
      host: str(env.SMTP_HOST, ''),
      port: int(env.SMTP_PORT, 587, 1, 65535),
      tls: ['implicit', 'starttls', 'none'].includes(env.SMTP_TLS) ? env.SMTP_TLS
        : int(env.SMTP_PORT, 587, 1, 65535) === 465 ? 'implicit' : 'starttls',
      user: str(env.SMTP_USER, ''),
      pass: str(env.SMTP_PASS, ''),
      from: str(env.SMTP_FROM, 'Smart Pager <no-reply@aurexis.cc>'),
    },
    backupS3: backupS3(env),
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
      // Old team after an App Store transfer: builds already installed still carry its prefix.
      previousTeamId: str(env.APPLE_PREVIOUS_TEAM_ID, ''),
      appId: str(env.APPLE_APP_ID, ''),
      appBundleId: str(env.APPLE_APP_BUNDLE_ID, 'cc.aurexis.pager'),
      clipBundleId: str(env.APPLE_CLIP_BUNDLE_ID, 'cc.aurexis.pager.Clip'),
      keyId: str(env.APNS_KEY_ID, ''),
      keyPath: str(env.APNS_KEY_PATH, ''),
      env: env.APNS_ENV === 'sandbox' ? 'sandbox' : 'production',
    },
  };
}

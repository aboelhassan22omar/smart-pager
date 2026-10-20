import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

// Fills VAPID keys and the cookie secret from env, or from $DATA_DIR/secrets.json
// (generated once on first boot).
export function ensureSecrets(config) {
  const file = path.join(config.dataDir, 'secrets.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    saved = {};
  }
  let changed = false;

  if (!config.vapid.publicKey || !config.vapid.privateKey) {
    if (!saved.vapidPublicKey || !saved.vapidPrivateKey) {
      const keys = webpush.generateVAPIDKeys();
      saved.vapidPublicKey = keys.publicKey;
      saved.vapidPrivateKey = keys.privateKey;
      changed = true;
    }
    config.vapid.publicKey = saved.vapidPublicKey;
    config.vapid.privateKey = saved.vapidPrivateKey;
  }

  if (!config.cookieSecret) {
    if (!saved.cookieSecret) {
      saved.cookieSecret = crypto.randomBytes(32).toString('base64url');
      changed = true;
    }
    config.cookieSecret = saved.cookieSecret;
  }

  if (changed) fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
}

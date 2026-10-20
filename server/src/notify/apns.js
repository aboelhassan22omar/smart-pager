import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';

const JWT_TTL_MS = 50 * 60 * 1000;
const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

// Minimal APNs client: ES256 provider token from a .p8 key, one shared HTTP/2 session.
export function createApns({ teamId, keyId, keyPath, env }, log) {
  if (!teamId || !keyId || !keyPath) return null;
  let key;
  try {
    key = crypto.createPrivateKey(fs.readFileSync(keyPath));
  } catch (err) {
    log.warn({ err: err.message, keyPath }, 'APNs key could not be loaded; Live Activity pushes disabled');
    return null;
  }

  const origin = HOSTS[env] ?? HOSTS.production;
  let jwt = null;
  let jwtAt = 0;
  let session = null;

  function token() {
    if (jwt && Date.now() - jwtAt < JWT_TTL_MS) return jwt;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
    jwt = `${header}.${claims}.${signature.toString('base64url')}`;
    jwtAt = Date.now();
    return jwt;
  }

  function connection() {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(origin);
    session.on('error', (err) => {
      log.warn({ err: err.message }, 'APNs session error');
      session = null;
    });
    session.on('goaway', () => {
      session = null;
    });
    session.unref();
    return session;
  }

  function send(deviceToken, { topic, payload, pushType = 'liveactivity', priority = 10 }) {
    return new Promise((resolve) => {
      let req;
      try {
        req = connection().request({
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${token()}`,
          'apns-topic': topic,
          'apns-push-type': pushType,
          'apns-priority': String(priority),
          'content-type': 'application/json',
        });
      } catch (err) {
        resolve({ status: 0, reason: err.message });
        return;
      }
      let status = 0;
      let body = '';
      req.setEncoding('utf8');
      req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on('response', (headers) => {
        status = headers[':status'];
      });
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let reason;
        try {
          reason = body ? JSON.parse(body).reason : undefined;
        } catch {
          reason = body;
        }
        resolve({ status, reason });
      });
      req.on('error', (err) => resolve({ status: 0, reason: err.message }));
      req.end(JSON.stringify(payload));
    });
  }

  return {
    send,
    close() {
      session?.close();
    },
  };
}

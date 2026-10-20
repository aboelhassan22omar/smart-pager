import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { createBus } from './bus.js';
import { openDb } from './db.js';
import { HttpError } from './errors.js';
import { createNotifier } from './notify/index.js';
import { PUBLIC_DIR } from './paths.js';
import { ensureSecrets } from './secrets.js';
import { createService } from './service.js';
import { Store } from './store.js';
import adminRoutes from './routes/admin.js';
import barRoutes from './routes/bar.js';
import customerRoutes from './routes/customer.js';
import pageRoutes from './routes/pages.js';

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https://aurexis.cc",
  "style-src 'self'",
  "font-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export async function buildApp(config) {
  fs.mkdirSync(path.join(config.dataDir, 'logos'), { recursive: true });
  ensureSecrets(config);

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 32 * 1024,
    forceCloseConnections: true,
  });

  const db = openDb(path.join(config.dataDir, 'pager.db'));
  const store = new Store(db, config);
  const bus = createBus();
  const notifier = createNotifier({ store, config, log: app.log });
  const service = createService({ store, bus, notifier, config, log: app.log });
  const ctx = { config, store, bus, notifier, service };

  app.addContentTypeParser(LOGO_TYPES, { parseAs: 'buffer', bodyLimit: LOGO_MAX_BYTES }, (_req, body, done) => {
    done(null, body);
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('content-security-policy', CSP);
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.message, ...err.extra });
    }
    const status = err.statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ error: 'الملف أكبر من المسموح (٢ ميجا)' });
    if (status === 415) return reply.code(415).send({ error: 'نوع الملف ده مش مدعوم' });
    if (status < 500) return reply.code(status).send({ error: 'الطلب ده مش مظبوط' });
    req.log.error(err);
    return reply.code(500).send({ error: 'حصلت مشكلة في السيرفر. جرّب تاني' });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'مش موجود' });
  });

  await app.register(fastifyCookie, { secret: config.cookieSecret });
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: false,
    cacheControl: false,
    allowedPath: (pathname) => !pathname.endsWith('.html'),
    // @fastify/static v10 passes the Fastify reply here.
    setHeaders(reply, filePath) {
      const isFont = filePath.endsWith('.woff2');
      reply.header('cache-control', isFont ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  await app.register(customerRoutes, ctx);
  await app.register(barRoutes, ctx);
  await app.register(adminRoutes, ctx);
  await app.register(pageRoutes, ctx);

  const rotation = setInterval(() => service.rotateDue(), 1000);
  const jobs = setInterval(() => service.runJobs(), config.jobIntervalSeconds * 1000);
  app.addHook('onReady', async () => service.runJobs());
  app.addHook('onClose', async () => {
    clearInterval(rotation);
    clearInterval(jobs);
    notifier.close();
    db.close();
  });

  return app;
}

import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { openStorage } from './bootstrap.js';
import { createBus, createScreens } from './bus.js';
import { HttpError } from './errors.js';
import { createNotifier } from './notify/index.js';
import { PUBLIC_DIR } from './paths.js';
import { ensureSecrets } from './secrets.js';
import { createService } from './service.js';
import { scheduleBackups } from './backup.js';
import { runWeeklySummaries } from './summary.js';
import { createPackages } from './native/packages.js';
import adminRoutes from './routes/admin.js';
import appRoutes from './routes/app.js';
import barRoutes from './routes/bar.js';
import brandRoutes from './routes/brand.js';
import customerRoutes from './routes/customer.js';
import pageRoutes from './routes/pages.js';
import superRoutes from './routes/super.js';

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
  fs.mkdirSync(config.dataDir, { recursive: true });
  ensureSecrets(config);

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 32 * 1024,
    forceCloseConnections: true,
  });

  const { control, tenants } = openStorage(config, app.log);
  const bus = createBus();
  const screens = createScreens();
  const notifier = createNotifier({ tenants, config, log: app.log });
  const service = createService({ control, tenants, bus, notifier, screens, config, log: app.log });
  const packages = createPackages({ config });
  const ctx = { config, control, tenants, bus, screens, notifier, service, packages };

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

  // Cookie values are signed in-house with per-branch keys (cookies.js); this only parses/sets.
  await app.register(fastifyCookie);
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
  await app.register(superRoutes, ctx);
  await app.register(brandRoutes, ctx);
  await app.register(appRoutes, ctx);
  await app.register(pageRoutes, ctx);

  const rotation = setInterval(() => service.rotateDue(), 1000);
  const jobs = setInterval(() => service.runJobs(), config.jobIntervalSeconds * 1000);
  // Stored plan_status is a dashboard cache; requests always recompute the plan.
  const plans = setInterval(() => control.refreshPlanStatuses(), 3600_000);
  const rollups = setInterval(() => service.runRollups(), 300_000);
  const summaries = setInterval(() => {
    runWeeklySummaries({ config, control, tenants, screens, log: app.log }).catch((err) => app.log.error({ err }, 'weekly summary job failed'));
  }, 3600_000);
  const stopBackups = scheduleBackups({ config, control, tenants, log: app.log });
  app.addHook('onReady', async () => {
    service.runJobs();
    control.refreshPlanStatuses();
  });
  app.addHook('onClose', async () => {
    clearInterval(rotation);
    clearInterval(jobs);
    clearInterval(plans);
    clearInterval(rollups);
    clearInterval(summaries);
    stopBackups();
    notifier.close();
    tenants.closeAll();
    control.close();
  });

  return app;
}

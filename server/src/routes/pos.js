import { HttpError } from '../errors.js';
import { parseBody, payloadKeys, readOrders } from '../pos.js';
import { createRateLimiter } from '../ratelimit.js';
import { safeEqual } from '../util.js';

const BODY_LIMIT = 1024 * 1024; // whole orders with their items, from some systems
// Settings of the link itself; everything else in the query is treated as the order.
const LINK_PARAMS = new Set(['delivery', 'test']);

// The branch's POS link: no cookies, the secret token in the URL is the login. A POS retries
// on errors, so anything we can't read is answered 200 and shown on the branch's settings.
export default async function posRoutes(app, { control, tenants, service }) {
  const limiter = createRateLimiter({ limit: 600 });
  app.addHook('onClose', async () => limiter.close());

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body));

  function branchOf(req) {
    const ctx = tenants.get(req.params.branch);
    const token = ctx?.store.getShop()?.pos_token;
    if (!token || !safeEqual(req.params.token, token) || control.getBranch(ctx.branch.id).deleted_at) {
      throw new HttpError(404, 'اللينك ده مش شغال');
    }
    if (!limiter.take(ctx.branch.id).ok) throw new HttpError(429, 'too many requests');
    return ctx;
  }

  async function handle(req) {
    const ctx = branchOf(req);
    const query = Object.fromEntries(Object.entries(req.query ?? {}).filter(([key]) => !LINK_PARAMS.has(key)));
    const payload = parseBody(req.body) ?? (Object.keys(query).length ? query : null);
    // Opening the link in a browser, or a system checking that the URL answers.
    if (!payload) return { ok: true };

    const orders = readOrders(payload, { deliveryCode: req.query?.delivery ?? null });
    if (payload.test === true || req.query?.test) return { ok: orders.length > 0, test: true, orders };
    if (!orders.length) {
      service.posUnread(ctx, payloadKeys(payload));
      return { ok: false, reason: 'no order number found' };
    }
    return { ok: true, orders: service.posOrders(ctx, orders) };
  }

  const opts = { logLevel: 'warn', bodyLimit: BODY_LIMIT }; // keeps the token out of the access log
  app.post('/api/pos/:branch/:token', opts, handle);
  app.get('/api/pos/:branch/:token', opts, handle);
}

import { HttpError } from '../errors.js';
import { qrBlock } from '../escpos.js';
import { canClaim } from '../plans.js';
import { MAX_POS_NUMBER, parseBody, payloadKeys, readOrders } from '../pos.js';
import { agentScript, findNumber, installScript, isCancel, isSkipped, printerConfig, removeScript } from '../printer.js';
import { createRateLimiter } from '../ratelimit.js';
import { safeEqual } from '../util.js';
import { orderUrl } from '../views.js';

// A receipt printed again (a reprint, a second copy) within this long keeps its first order.
const REPRINT_MS = 10 * 60_000;
// Receipts we can't read (printed as a picture): another one this soon after is a copy of it
// (kitchen copy, customer copy), not a new customer.
const COPY_MS = 8_000;

const BODY_LIMIT = 1024 * 1024; // whole orders with their items, from some systems
// Settings of the link itself; everything else in the query is treated as the order.
const LINK_PARAMS = new Set(['delivery', 'test']);

// The branch's POS link: no cookies, the secret token in the URL is the login. A POS retries
// on errors, so anything we can't read is answered 200 and shown on the branch's settings.
export default async function posRoutes(app, { config, control, tenants, service }) {
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

  // ---- the receipt printer agent (src/printer.js, native/printer/) ----

  const ps1 = (reply, text) => reply.type('text/plain; charset=utf-8').header('cache-control', 'no-store').send(text);
  const linkOf = (ctx) => ({ server: config.publicUrl, branch: ctx.branch.id, token: ctx.store.getShop().pos_token });

  app.get('/api/pos/:branch/:token/printer.ps1', opts, async (req, reply) => {
    const ctx = branchOf(req);
    return ps1(reply, installScript({ ...linkOf(ctx), printer: printerConfig(ctx.store.getShop())?.printer ?? '' }));
  });
  app.get('/api/pos/:branch/:token/printer-remove.ps1', opts, async (req, reply) => ps1(reply, removeScript(linkOf(branchOf(req)))));
  app.get('/api/pos/:branch/:token/printer/agent.ps1', opts, async (req, reply) => {
    branchOf(req);
    return ps1(reply, agentScript());
  });

  const recent = new Map(); // `${branch}|${job hash}` -> { at, reply }
  const lastUnread = new Map(); // branch -> { at, reply } of the last receipt without a number
  // One printed receipt: the bytes to add before its paper cut (base64 ESC/POS), or null to
  // print it as it is (agent off for the branch, a report, a stopped branch).
  app.post('/api/pos/:branch/:token/printer/job', opts, async (req) => {
    const ctx = branchOf(req);
    const shop = ctx.store.getShop();
    const settings = printerConfig(shop);
    if (!settings) return { append: null, reason: 'off' };
    const body = parseBody(req.body) ?? {};
    const text = typeof body.text === 'string' ? body.text.slice(0, 40_000) : '';
    const now = Date.now();
    for (const [k, v] of recent) if (now - v.at > REPRINT_MS) recent.delete(k);
    const key = /^[0-9a-f]{64}$/.test(body.hash ?? '') ? `${ctx.branch.id}|${body.hash}` : null;
    if (key && recent.has(key)) return recent.get(key).reply;

    const note = (fields) => ctx.store.updateShop({
      print_last: JSON.stringify({ at: now, size: Number(body.size) || null, sample: text.replace(/\s+/g, ' ').trim().slice(0, 500), ...fields }),
    });
    if (isSkipped(text, settings)) {
      note({ skipped: true });
      return { append: null, reason: 'skipped' };
    }
    if (!canClaim(control.getBranch(ctx.branch.id))) {
      note({ stopped: true });
      return { append: null, reason: 'stopped' };
    }
    const receipt = findNumber(text, settings);
    // A void / cancel / refund slip: the order of that receipt is cancelled (its customer sees
    // it), and the slip prints without a QR.
    if (isCancel(text, settings)) {
      const open = receipt ? ctx.store.openOrderByReceipt(receipt) : null;
      if (open) service.setStatus(ctx, shop, open, 'cancelled');
      note({ cancelled: true, receipt, number: open ? open.ref ?? String(open.number) : null });
      return { append: null, reason: 'cancelled' };
    }
    // An unreadable receipt right after another one: a copy, same order and QR.
    const copy = !receipt && lastUnread.get(ctx.branch.id);
    if (copy && now - copy.at < COPY_MS) return copy.reply;
    // The receipt's number when it can be read: that order (another copy of the same receipt
    // joins it). Else the next number, printed big above the QR.
    let order = receipt ? ctx.store.openOrderByReceipt(receipt) : null;
    if (!order) {
      const n = receipt ? Number(receipt) : null;
      const long = n != null && n > MAX_POS_NUMBER;
      ({ order } = service.createOrder(ctx, n == null ? {} : { number: long ? n % 10_000 || 1 : n, ref: long ? receipt : null }));
    }
    const number = order.ref ?? String(order.number);
    const block = qrBlock(orderUrl(config, shop.id, order.id), { title: receipt ? null : `No. ${number}` });
    const reply = { append: block.toString('base64'), number, receipt };
    if (key) recent.set(key, { at: now, reply });
    if (!receipt) lastUnread.set(ctx.branch.id, { at: now, reply });
    note({ receipt, number });
    return reply;
  });
}

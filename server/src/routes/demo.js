import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { DEMO_ID, ensureDemo } from '../demo.js';
import { PUBLIC_DIR } from '../paths.js';
import { setOwnerSession, setStaffSession } from '../sessions.js';
import { openSse } from '../sse.js';
import { dayIn } from '../util.js';

const VISITOR_COOKIE = 'sp_demo';
const VISITOR_MAX_AGE = 365 * 24 * 3600;

// /demo: the one link sent to people from the ad. It signs the visitor in as the demo café's
// cashier and owner, and the page shows the customer, cashier and owner screens side by side.
export default async function demoRoutes(app, deps) {
  const { config, control, screens } = deps;
  const page = fs.readFileSync(path.join(PUBLIC_DIR, 'demo.html'), 'utf8');

  const customerPath = (shop) => `/s/${DEMO_ID}?k=${encodeURIComponent(shop.static_key)}`;

  app.get('/demo', async (req, reply) => {
    const { ctx, owner } = await ensureDemo(deps);
    const shop = ctx.store.getShop();
    setStaffSession(reply, config, shop);
    setOwnerSession(reply, config, owner);
    const newVisitor = !req.cookies[VISITOR_COOKIE];
    if (newVisitor) {
      reply.setCookie(VISITOR_COOKIE, '1', {
        httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: VISITOR_MAX_AGE,
      });
    }
    control.recordDemoVisit(dayIn(config.tz), { newVisitor });
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page);
  });

  app.get('/api/demo', async () => {
    const { ctx } = await ensureDemo(deps);
    const shop = ctx.store.getShop();
    return { shopId: shop.id, brandId: shop.brand_id, name: shop.name, customerPath: customerPath(shop) };
  });

  // The customer link as a QR: visitors scan it with their own phone and get a real number.
  app.get('/api/demo/qr.svg', async (_req, reply) => {
    const { ctx } = await ensureDemo(deps);
    const svg = await QRCode.toString(`${config.publicUrl}${customerPath(ctx.store.getShop())}`, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#17191d', light: '#ffffff' },
    });
    return reply.type('image/svg+xml; charset=utf-8').header('cache-control', 'no-store').send(svg);
  });

  // Open while the demo page is: "the demo is open on N screens now" on the super dashboard.
  app.get('/api/demo/live', async (req, reply) => {
    const sse = openSse(req, reply);
    screens.openDemo();
    sse.onClose(() => screens.closeDemo());
  });
}

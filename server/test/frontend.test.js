import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { BG, contrast, extractAccent, hexToRgb, readableAccent, rgbToHsl } from '../public/js/color.js';
import { mountPoweredBy, AUREXIS_LOGO, AUREXIS_URL } from '../public/js/powered.js';
import { esc, SPLASH_MIN_MS } from '../public/js/util.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const PAGES = [
  'public/s.html', 'public/bar.html', 'public/qr.html', 'public/settings.html', 'public/index.html',
  'public/super.html', 'public/brand.html',
];

// Tiny DOM stand-in, enough for powered.js.
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const el = {
      tag,
      children: [],
      attrs: {},
      listeners: {},
      hidden: false,
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      append(...kids) {
        for (const k of kids) {
          this.children.push(k);
          if (k.id) byId.set(k.id, k);
        }
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
    };
    return el;
  };
  return { body: make('body'), createElement: make, getElementById: (id) => byId.get(id) ?? null };
}

describe('pages', () => {
  for (const page of PAGES) {
    test(`${page} is Arabic RTL`, () => {
      assert.match(read(page), /<html lang="ar" dir="rtl">/);
    });

    test(`${page} mounts Powered by AUREXIS`, () => {
      assert.match(read(page), /<script type="module" src="\/js\/powered\.js"><\/script>/);
    });

    test(`${page} has no inline scripts (CSP script-src 'self')`, () => {
      assert.doesNotMatch(read(page), /<script(?![^>]*\bsrc=)[^>]*>/);
    });
  }

  test('customer page keeps the Apple meta placeholder for the server', () => {
    assert.ok(read('public/s.html').includes('<!--APPLE_META-->'));
  });
});

describe('Powered by AUREXIS', () => {
  test('mounts a fixed footer linking to aurexis.cc, once', () => {
    const doc = fakeDocument();
    const footer = mountPoweredBy(doc);
    assert.equal(footer.id, 'powered-by');
    assert.equal(footer.className, 'powered-by');
    const link = footer.children[0];
    assert.equal(link.href, AUREXIS_URL);
    assert.equal(AUREXIS_URL, 'https://aurexis.cc/');
    const [label, logo, brand] = link.children;
    assert.equal(label.textContent, 'Powered by');
    assert.equal(brand.textContent, 'AUREXIS');
    assert.equal(logo.src, AUREXIS_LOGO);
    assert.equal(AUREXIS_LOGO, 'https://aurexis.cc/brand/aurexis-mark.svg');
    assert.equal(mountPoweredBy(doc), footer, 'idempotent');
    assert.equal(doc.body.children.length, 1);
  });

  test('hides the logo when it fails to load', () => {
    const doc = fakeDocument();
    const logo = mountPoweredBy(doc).children[0].children[1];
    assert.equal(logo.hidden, false);
    logo.listeners.error();
    assert.equal(logo.hidden, true);
  });

  test('footer is fixed above everything, including the splash and ready screen', () => {
    const css = read('public/css/base.css');
    const block = css.slice(css.indexOf('.powered-by {'), css.indexOf('}', css.indexOf('.powered-by {')));
    assert.match(block, /position: fixed/);
    assert.match(block, /bottom: 0/);
    const z = Number(block.match(/z-index: (\d+)/)[1]);
    const customer = read('public/css/customer.css');
    for (const m of customer.matchAll(/z-index: (\d+)/g)) assert.ok(z > Number(m[1]));
  });
});

describe('splash', () => {
  test('is held for at least 1000ms', () => {
    assert.ok(SPLASH_MIN_MS >= 1000, `SPLASH_MIN_MS = ${SPLASH_MIN_MS}`);
  });

  test('customer page waits for SPLASH_MIN_MS before showing the card', () => {
    const js = read('public/js/customer.js');
    assert.match(js, /import \{[^}]*SPLASH_MIN_MS[^}]*\} from '\.\/util\.js'/);
    assert.match(js, /SPLASH_MIN_MS - \(performance\.now\(\) - startedAt\)/);
  });

  test('iOS splash matches the web (>= 1.0s)', () => {
    const swift = fs.readFileSync(path.join(root, '..', 'ios', 'Shared', 'AppSupport', 'OrderModel.swift'), 'utf8');
    const seconds = Number(swift.match(/splashMinimum: TimeInterval = ([\d.]+)/)[1]);
    assert.ok(seconds >= 1.0, `splashMinimum = ${seconds}`);
  });
});

describe('shop accent from the logo', () => {
  const pixels = (...groups) => {
    const out = [];
    for (const [hex, count, alpha = 255] of groups) {
      const [r, g, b] = hexToRgb(hex);
      for (let i = 0; i < count; i++) out.push(r, g, b, alpha);
    }
    return Uint8ClampedArray.from(out);
  };
  const hueOf = (hex) => rgbToHsl(...hexToRgb(hex))[0];

  test('picks the dominant saturated color', () => {
    const color = extractAccent(pixels(['#1a73e8', 300], ['#ffffff', 600], ['#000000', 200]));
    assert.ok(Math.abs(hueOf(color) - hueOf('#1a73e8')) < 8, color);
  });

  test('monochrome or transparent logos give no accent', () => {
    assert.equal(extractAccent(pixels(['#000000', 300], ['#ffffff', 300], ['#808080', 300])), null);
    assert.equal(extractAccent(pixels(['#1a73e8', 300, 0])), null);
  });

  test('skips green and red, which mean "ready" and "cancel"', () => {
    const color = extractAccent(pixels(['#2e9e44', 500], ['#d93025', 400], ['#7b3fe4', 150]));
    assert.ok(Math.abs(hueOf(color) - hueOf('#7b3fe4')) < 8, color);
    assert.equal(extractAccent(pixels(['#2e9e44', 500])), null);
  });

  test('readableAccent lifts dark colors and picks a legible ink', () => {
    const dark = readableAccent('#0b1f4b');
    assert.ok(contrast(dark.color, BG) >= 3, `${dark.color} vs graphite`);
    const light = readableAccent('#ffd54f');
    assert.equal(light.ink, '#1e1f21');
    assert.ok(contrast(light.color, light.ink) >= 4.5);
  });

  test('customer page and QR screen apply the shop accent', () => {
    assert.match(read('public/js/customer.js'), /applyAccent\(document\.documentElement, shop\.accent\)/);
    assert.match(read('public/js/qr.js'), /applyAccent\(document\.documentElement, state\.shop\.accent\)/);
  });
});

describe('Google review prompt', () => {
  test('shows after pickup only, for every customer, and counts the tap', () => {
    const js = read('public/js/customer.js');
    assert.match(js, /order\.status === 'picked' && Boolean\(shop\?\.googleReviewUrl\)/);
    assert.match(js, /sendBeacon\?\.\(`\$\{branchApi\}\/orders\/\$\{encodeURIComponent\(order\.id\)\}\/review-click`/);
    const html = read('public/s.html');
    assert.match(html, /id="review-link"[^>]*target="_blank"[^>]*rel="noopener"/);
  });
});

describe('esc()', () => {
  test('escapes HTML special characters', () => {
    assert.equal(esc('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    assert.equal(esc("Tom & Jerry's"), 'Tom &amp; Jerry&#39;s');
  });

  test('handles non-strings', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(42), '42');
  });
});

describe('service worker', () => {
  function loadWorker() {
    const handlers = {};
    const shown = [];
    const closed = [];
    const open = new Map();
    const self = {
      addEventListener: (type, fn) => {
        handlers[type] = fn;
      },
      skipWaiting() {},
      clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
      location: { origin: 'https://pager.test' },
      registration: {
        async showNotification(title, options) {
          shown.push({ title, options });
          open.set(options.tag, { close: () => closed.push(options.tag) });
        },
        async getNotifications({ tag }) {
          return open.has(tag) ? [open.get(tag)] : [];
        },
      },
    };
    vm.runInNewContext(read('public/sw.js'), { self, URL, console });
    const push = async (data) => {
      let pending;
      handlers.push({ data: { json: () => data }, waitUntil: (p) => (pending = p) });
      await pending;
    };
    return { push, shown, closed };
  }

  const order = { orderId: 'abc123', shopId: 'cafe', shopName: 'Café', number: 7, message: 'm' };

  test('preparing: one silent, sticky notification tagged per order', async () => {
    const sw = loadWorker();
    await sw.push({ ...order, status: 'preparing' });
    const { options } = sw.shown[0];
    assert.equal(options.tag, 'order-abc123');
    assert.equal(options.requireInteraction, true);
    assert.equal(options.silent, true);
    assert.equal(options.renotify, false);
    assert.equal(options.vibrate, undefined);
  });

  test('ready: same tag, renotify with sound and vibration', async () => {
    const sw = loadWorker();
    await sw.push({ ...order, status: 'preparing' });
    await sw.push({ ...order, status: 'ready' });
    const { title, options } = sw.shown[1];
    assert.equal(options.tag, 'order-abc123');
    assert.equal(options.requireInteraction, true);
    assert.equal(options.renotify, true);
    assert.equal(options.silent, false);
    assert.ok(Array.isArray(options.vibrate) && options.vibrate.length > 0);
    assert.match(title, /7/);
  });

  test('picked / expired: the notification is closed', async () => {
    for (const status of ['picked', 'expired', 'cancelled']) {
      const sw = loadWorker();
      await sw.push({ ...order, status: 'ready' });
      await sw.push({ ...order, status });
      assert.equal(sw.shown.length, 1);
      assert.deepEqual(sw.closed, ['order-abc123']);
    }
  });
});

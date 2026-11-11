import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  BG, brandTheme, contrast, extractAccent, hexToRgb, hslToRgb, MONO_COLOR, readableAccent, rgbToHex, rgbToHsl,
} from '../public/js/color.js';
import { reviewHtml } from '../public/js/review.js';
import { mountPoweredBy, AUREXIS_LOGO, AUREXIS_URL } from '../public/js/powered.js';
import { esc, isCashierApp, SPLASH_MIN_MS } from '../public/js/util.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const PAGES = [
  'public/s.html', 'public/bar.html', 'public/qr.html', 'public/settings.html', 'public/index.html',
  'public/super.html', 'public/brand.html', 'public/privacy.html',
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
      assert.match(read(page), /<html lang="ar" dir="rtl"( data-bs-theme="dark")?>/);
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

describe('cashier app pages (private label)', () => {
  for (const page of ['public/app.html', 'public/setup.html']) {
    test(`${page}: Arabic RTL, no inline scripts, brand only (no Powered by, no Smart Pager)`, () => {
      const html = read(page);
      assert.match(html, /<html lang="ar" dir="rtl">/);
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
      assert.doesNotMatch(html, /powered\.js|Smart Pager|Aurexis|AUREXIS/i);
    });
  }

  test('the app cookie is how pages know they run inside the cashier app', () => {
    assert.equal(isCashierApp({ cookie: 'a=1; sp_app=android' }), true);
    assert.equal(isCashierApp({ cookie: 'sp_app=windows' }), true);
    assert.equal(isCashierApp({ cookie: 'xsp_app=1' }), false);
    assert.equal(isCashierApp({ cookie: '' }), false);
    assert.equal(isCashierApp(undefined), false);
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

  test('a black-and-white logo gets the grey look; only an invisible image gives nothing', () => {
    assert.equal(extractAccent(pixels(['#000000', 300], ['#ffffff', 300], ['#808080', 300])), MONO_COLOR);
    assert.equal(extractAccent(pixels(['#1a73e8', 300, 0])), null);
  });

  test('red and green logos keep their color', () => {
    const red = extractAccent(pixels(['#d93025', 400], ['#ffffff', 600]));
    assert.ok(Math.abs(hueOf(red) - hueOf('#d93025')) < 8, red);
    const green = extractAccent(pixels(['#2e9e44', 500], ['#d93025', 200], ['#7b3fe4', 150]));
    assert.ok(Math.abs(hueOf(green) - hueOf('#2e9e44')) < 8, green);
  });

  test('reads the logos the old rules gave up on', () => {
    const hue = (color, expected) => assert.ok(Math.abs(hueOf(color) - hueOf(expected)) < 8, `${color} vs ${expected}`);
    hue(extractAccent(pixels(['#0b1f4b', 300], ['#ffffff', 700])), '#0b1f4b'); // dark navy
    hue(extractAccent(pixels(['#c9a24b', 30], ['#000000', 970])), '#c9a24b'); // a thin gold line on black
    hue(extractAccent(pixels(['#b5121b', 900], ['#ffffff', 100])), '#b5121b'); // a full red square
    hue(extractAccent(pixels(['#6d4c41', 400], ['#f5f0e6', 600])), '#6d4c41'); // brown on cream paper
  });

  test('every logo color gives a dark, readable page that clearly carries its hue', () => {
    for (let h = 0; h < 360; h += 15) {
      for (const [s, l] of [[0.9, 0.5], [0.6, 0.2], [0.4, 0.75]]) {
        const color = rgbToHex(...hslToRgb(h, s, l));
        const t = brandTheme(color);
        for (const surface of ['--bg', '--surface', '--surface-2']) {
          assert.ok(contrast(t['--text'], t[surface]) >= 7, `text on ${surface} for ${color}`);
          assert.ok(contrast(t['--muted'], t[surface]) >= 4.5, `muted on ${surface} for ${color}`);
          assert.ok(contrast(t['--accent'], t[surface]) >= 3, `accent on ${surface} for ${color}`);
        }
        assert.ok(contrast(t['--accent'], t['--on-accent']) >= 4.5, `button text for ${color}`);
        assert.ok(contrast(t['--danger'], t['--surface-2']) >= 4.5, `cancel text for ${color}`);
        const [bgHue, bgSat] = rgbToHsl(...hexToRgb(t['--bg']));
        const gap = Math.min(Math.abs(bgHue - h), 360 - Math.abs(bgHue - h));
        assert.ok(gap < 12 && bgSat >= 0.25, `background of ${color} carries its hue: ${t['--bg']}`);
      }
    }
    const grey = brandTheme(MONO_COLOR);
    assert.equal(rgbToHsl(...hexToRgb(grey['--bg']))[1], 0, 'a black-and-white logo stays truly neutral');
  });

  test('readableAccent lifts dark colors and picks a legible ink', () => {
    const dark = readableAccent('#0b1f4b');
    assert.ok(contrast(dark.color, BG) >= 3, `${dark.color} vs graphite`);
    const light = readableAccent('#ffd54f');
    assert.equal(light.ink, '#17191d');
    assert.ok(contrast(light.color, light.ink) >= 4.5);
  });

  test('every page of a branch wears its color', () => {
    assert.match(read('public/js/customer.js'), /applyTheme\(document\.documentElement, shop\.theme\)/);
    assert.match(read('public/js/qr.js'), /applyTheme\(document\.documentElement, state\.shop\.theme\)/);
    assert.match(read('public/js/bar.js'), /applyTheme\(document\.documentElement, state\.shop\.theme\)/);
    assert.match(read('public/js/brand.js'), /applyTheme\(document\.documentElement, data\.brand\.theme\)/);
    assert.match(read('public/js/settings.js'), /applyTheme\(document\.documentElement/);
    assert.match(read('public/js/demo.js'), /applyTheme\(document\.documentElement, info\.theme\)/);
  });
});

describe('Google review prompt', () => {
  const GOOGLE = 'https://search.google.com/local/writereview?placeid=ChIJ123';
  const googleLinks = (html) => html.match(/<a [^>]*id="review-link"[^>]*>/g) ?? [];

  test('NO GATING: just the Google button, nothing asked first, opening in a new tab', () => {
    const links = googleLinks(reviewHtml({ googleUrl: GOOGLE }));
    assert.equal(links.length, 1);
    assert.match(links[0], /target="_blank"[^>]*rel="noopener"/);
    assert.ok(links[0].includes(`href="${esc(GOOGLE)}"`));
  });

  test('no stars any more, and nothing without a Google link', () => {
    assert.equal((reviewHtml({ googleUrl: GOOGLE }).match(/data-rating=/g) ?? []).length, 0);
    assert.equal(reviewHtml({}), '');
  });

  test('shows after pickup only and counts the tap', () => {
    const js = read('public/js/customer.js');
    assert.match(js, /order\.status === 'picked' && Boolean\(shop\?\.googleReviewUrl\)/);
    assert.match(js, /sendBeacon\?\.\(`\$\{branchApi\}\/orders\/\$\{encodeURIComponent\(order\.id\)\}\/review-click`/);
    // Rewards never depend on reviews: the review card does not touch loyalty.
    const code = read('public/js/review.js').replace(/^\s*(\/\/|\*).*$/gm, '');
    assert.doesNotMatch(code, /loyal|stamp|reward/i);
  });
});

describe('promo space', () => {
  test('only while preparing, plain text + image, never HTML or links', () => {
    const js = read('public/js/customer.js');
    const body = js.slice(js.indexOf('function renderPromo'), js.indexOf('function render()'));
    assert.match(body, /order\?\.status === 'preparing' \? shop\?\.promo : null/);
    assert.match(body, /p\.textContent = promo\.text/);
    assert.doesNotMatch(body, /innerHTML|createElement\('a'\)|href/);
    assert.match(read('public/s.html'), /id="card-number"[\s\S]*id="card-promo"/, 'below the number');
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

describe('dashboards on Bootstrap', () => {
  for (const page of ['public/brand.html', 'public/super.html']) {
    test(`${page}: Bootstrap RTL first, our bridge and tokens after it`, () => {
      const html = read(page);
      const order = ['/vendor/bootstrap/bootstrap.rtl.min.css', '/css/bs-bridge.css', '/css/base.css', '/css/admin.css'].map((href) => html.indexOf(`href="${href}"`));
      assert.ok(order.every((i) => i > 0), 'all four stylesheets are linked');
      assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
      assert.match(html, /data-bs-theme="dark"/);
      assert.match(html, /<body data-powered="inline">/, 'Powered by closes the page, never covers it');
    });
  }

  test('the vendored Bootstrap is the RTL build, with its license and no source map link', () => {
    const css = read('public/vendor/bootstrap/bootstrap.rtl.min.css');
    assert.match(css, /Bootstrap {2}v5\.3\.3/);
    assert.doesNotMatch(css, /sourceMappingURL/);
    assert.match(read('public/vendor/bootstrap/LICENSE'), /MIT License/);
  });

  test('owner page: one tab bar for phones, pills for wider screens, a pane per tab', () => {
    const html = read('public/brand.html');
    assert.equal((html.match(/data-tabs/g) ?? []).length, 2);
    for (const pane of ['branches', 'analytics', 'apps', 'account']) assert.match(html, new RegExp(`data-pane="${pane}"`));
  });

  test('inline Powered by: a class, not the fixed bar', () => {
    const doc = fakeDocument();
    doc.body.dataset = { powered: 'inline' };
    const footer = mountPoweredBy(doc);
    assert.equal(footer.className, 'powered-by is-inline');
  });
});

describe('renewal wording (owner cards, cashier settings)', async () => {
  const { renewalInfo } = await import('../public/js/dashboard.js');
  const until = Date.UTC(2026, 11, 1);

  test('trial and paid periods: days left, soon from 7 days', () => {
    assert.deepEqual(
      [renewalInfo({ status: 'trial', until, daysLeft: 4 }).title, renewalInfo({ status: 'trial', until, daysLeft: 4 }).soon],
      ['التجربة المجانية: فاضل 4 أيام', true],
    );
    const paid = renewalInfo({ status: 'active', until, daysLeft: 23 }, { amountEgp: 750 });
    assert.equal(paid.title, 'التجديد: فاضل 23 يوم');
    assert.match(paid.detail, /آخر دفعة 750 جنيه/);
    assert.equal(paid.soon, false);
    assert.equal(renewalInfo({ status: 'active', until, daysLeft: 1 }).title, 'التجديد: فاضل يوم واحد');
    assert.equal(renewalInfo({ status: 'active', until, daysLeft: 0 }).title, 'التجديد: آخر يوم النهارده');
  });

  test('no expiry: nothing to show; late or stopped: always flagged', () => {
    assert.equal(renewalInfo({ status: 'active', until: null, daysLeft: null }), null);
    assert.equal(renewalInfo({ status: 'past_due', until, daysLeft: 2 }).soon, true);
    assert.equal(renewalInfo({ status: 'suspended', reason: 'unpaid', until: null }).title, 'الفرع متوقف');
  });
});

describe('customer texts', async () => {
  const { cleanTexts, setTexts, t, tHtml, TEXT_DEFAULTS } = await import('../public/js/texts.js');
  const { aheadText } = await import('../public/js/queue-text.js');

  test('defaults, the brand wording, and the values filled in', () => {
    setTexts({});
    assert.equal(aheadText(3), 'قدامك 3 طلبات');
    setTexts({ ahead_many: 'فيه {n} قبلك' });
    assert.equal(aheadText(4), 'فيه 4 قبلك');
    assert.equal(t('order_label'), TEXT_DEFAULTS.order_label);
    setTexts({});
  });

  test('HTML: the sentence and the values are escaped, values in strong', () => {
    setTexts({ loyalty_won: '<b>yay</b> {reward}' });
    const esc = (s) => s.replace(/</g, '&lt;');
    assert.equal(tHtml('loyalty_won', { reward: '<x>' }, esc), '&lt;b>yay&lt;/b> <strong>&lt;x></strong>');
    setTexts({});
  });

  test('cleaning: known keys, trimmed, not empty, not the default', () => {
    assert.deepEqual(cleanTexts({ order_label: '  رقمك  ', ready_title: 'طلبك جاهز', x: 'y', note_hint: '' }).texts, { order_label: 'رقمك' });
    assert.equal(cleanTexts({ order_label: 'x'.repeat(161) }).field, 'order_label');
  });
});

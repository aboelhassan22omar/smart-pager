# Smart Pager (by Aurexis) — Design

A no-install pager replacement. The customer scans a QR code at the cashier, gets an order number in the browser, and the phone rings when the order is ready. Staff run everything from a "bar" page.

## 1. Architecture

```
phone (Safari/Chrome) ──HTTPS──► Caddy ──► Fastify (Node 22, single process)
   │  SSE /api/orders/:id/events            ├─ SQLite (node:sqlite, WAL) in $DATA_DIR
   │  Web Push (Android/desktop)  ◄─────────├─ in-process event bus → SSE fan-out
   └  App Clip + Live Activity    ◄─ APNs ──├─ web-push (VAPID), APNs over node:http2
                                            └─ timers: nonce rotation, expiry, purge
```

- **One process, one SQLite file.** SSE fan-out uses an in-memory `EventEmitter`. This deliberately rules out horizontal scaling; one small VPS can serve many shops.
- **Runtime dependencies:** `fastify`, `@fastify/static`, `@fastify/cookie` (which also does the HMAC cookie signing), `web-push`, `qrcode` (renders the QR SVG on the server; writing our own encoder isn't worth it). Rate limiting, the APNs JWT (ES256 via `node:crypto`), and the HTTP/2 client are written in-house. The dev tooling is `eslint`, `@eslint/js`, and `globals`.
- **UI:** neutral colors split 60/30/10: graphite `#1E1F21` (60%), stone surfaces `#2A2B2E`/`#34353A` with paper-white text `#ECEAE6` (30%), and a latte accent `#CDBB97` used only for primary actions, progress and focus (10%). Green (`#2F7A4F`) appears only for the ready state, and red only for cancel. The font is Readex Pro (variable, hosted locally, OFL). The order number is the one loud element.
- **`node:sqlite`** works without a flag on Node ≥ 22.13. We start with `--disable-warning=ExperimentalWarning`. The Dockerfile pins `node:22-slim`.
- **Secrets bootstrap:** if `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` or `COOKIE_SECRET` aren't set, they are generated once and saved to `$DATA_DIR/secrets.json` (mode 0600).

## 2. Data model

As specified. The non-obvious details:

| Topic | Decision |
|---|---|
| Order id | 16 random bytes, base64url. It acts as the customer's bearer token. |
| Daily reset | `number_day` is a `YYYY-MM-DD` in `TZ` (default `Africa/Cairo`). On the first claim of a new day, `next_number` goes back to 1. |
| Allocation | Done inside a transaction (`BEGIN IMMEDIATE`). Start at `next_number`, wrap from `max_number` to 1, and skip any number that has an open order (preparing/ready) in that shop. If every number is open, return `503 "كل الأرقام مشغولة"`. |
| Status machine | `preparing → ready → picked`. Bar `/status` can set any of `preparing/ready/picked/cancelled`. The job sets `expired`. `ready_at` is set on entering ready, and `closed_at` on picked/cancelled/expired. |
| Jobs (every 60s) | Expire open orders older than `expire_hours` (customers are notified through SSE, push, and Live Activity "end"). Purge closed orders older than 24h, together with their subscriptions. |
| Subscriptions | `payload` for `webpush` is the browser `PushSubscription` JSON. The endpoint must be `https:` and on the push-service allow-list (`PUSH_ENDPOINT_HOSTS`, which blocks SSRF), and the keys are checked for length (p256dh is 65 bytes, auth is 16). For `live_activity` it is `{token: hex(≥32 chars), app: "clip"|"app"}`, where `app` selects the APNs topic. At most 3 subscriptions per order. |

## 3. QR modes and claiming

- **QR URL:** `${PUBLIC_URL}/s/{shop}?n={nonce}` (dynamic) or `?k={static_key}` (static).
- **Dynamic:** the nonce rotates after each successful claim and every `NONCE_ROTATE_SECONDS` (default 60). When it rotates, `qr_prev_nonce` takes the old value, and both stay valid until the next rotation. As a result, one photo of the QR works for at most 2 claims and goes stale within about 2 minutes. Each rotation sends a `nonce` event to the bar SSE stream, which the `/qr` page listens to.
- **Static:** `static_key` (24 random bytes) is valid until it is rotated from settings. Anyone with a photo can claim, so the per-IP rate limit is the only brake. Settings will say this clearly.
- **both:** either parameter is accepted.
- **`/api/claim`:** rate limited per IP (default 6/min, token bucket, `trustProxy` on behind Caddy). A wrong or stale nonce returns `403 "الكود انتهى، امسح الكود من جديد"`.
- **Login:** rate limited per IP and shop (5/min).

## 4. Auth (bar)

- The PIN is 4–8 digits, hashed with `scrypt` (random salt, `timingSafeEqual`).
- The cookie `sp_bar_{shop}` holds `shop.issuedAt.pinFingerprint`, HMAC-signed. It is `httpOnly`, `Secure` (when `PUBLIC_URL` is https), `SameSite=Strict`, and lasts 30 days. Changing the PIN changes the fingerprint, which invalidates every existing session.
- CSRF: SameSite=Strict, plus every mutating route requires a JSON (or `image/*` for the logo) content type.
- The `/bar`, `/qr`, and `/settings` pages show a PIN login when no session exists. The `/qr` page needs auth because the live nonce is sensitive.

## 5. Real-time and notifications

| Channel | Behavior |
|---|---|
| Customer SSE | Sends an `order` event with the public order + shop messages on every change, and a `renotify` event when staff re-ring. Heartbeat comment every 25s. The client shows a reconnect banner and falls back to polling `/api/orders/:id` every 10s while disconnected. |
| Bar SSE | Sends `order` (with created/updated/removed), `nonce`, and `shop` events. |
| Web Push | The payload is `{orderId, number, status, shopName, message}`. The SW always uses `tag: order-<id>` and `requireInteraction: true`. On subscribe it shows a *silent* "preparing" notification. On ready it sets `renotify: true`, `silent: false`, and a vibrate pattern. On picked/expired/cancelled it closes notifications with that tag. A 404 or 410 from the push service deletes the subscription. |
| Live Activity | Every status change sends an APNs request with push-type `liveactivity`, topic `<bundle>.push-type.liveactivity`, priority 10, and `content-state {status, number, message, shopName}`. Ready adds `alert`. On close it sends `event: "end"` with `dismissal-date` = now + 15 min. A 410 or `BadDeviceToken` deletes the subscription. The JWT is cached for 50 minutes. |

**iOS reality check:** iOS Safari only gets Web Push for sites added to the Home Screen. On iOS, the web page therefore depends on staying open: the Wake Lock keeps the screen on, and WebAudio (unlocked by the "فعّل التنبيه" tap) plays the chime. The page shows a hint to keep it open. Once Apple credentials exist, the App Clip with a Live Activity is the real iOS answer. The `<!--APPLE_META-->` placeholder becomes `<meta name="apple-itunes-app" content="app-id=…, app-clip-bundle-id=…, app-clip-display=card">` when `APPLE_APP_ID` and `APPLE_CLIP_BUNDLE_ID` are set.

## 6. Frontend

- Pages are plain static HTML with ES modules under `server/public/`, with no build step. They share `css/base.css` (dark tokens, RTL, mobile-first), `js/util.js` (`esc`, `api`, `sse`), `js/powered.js` (mounts the fixed AUREXIS footer and hides the logo `onerror`), and `js/chime.js` (WebAudio tones, so no audio files are needed).
- The customer page runs: splash (`SPLASH_MIN_MS = 1100`, exported for tests) → resume from `?o=` or localStorage, otherwise claim with `n`/`k` → `history.replaceState(?o=)` → card. The ready screen goes full green, loops the chime every 2.5s, and vibrates until the first `pointerdown`.
- On the bar, a tap advances the order, a long press (500ms) opens a bottom sheet, a new order plays a chime, and a dot shows the connection state.
- Logo uploads are sent as the raw request body with `Content-Type: image/png|jpeg|webp` (no multipart). The server checks the magic bytes and enforces 2MB, stores the file as `$DATA_DIR/logos/{shop}.{ext}`, and serves it at `/media/logo/{shop}?v={mtime}`. SVG is rejected.

## 7. iOS

- XcodeGen `project.yml` defines 4 targets: `App` (`cc.aurexis.pager`), `Clip` (`cc.aurexis.pager.Clip`), and a widget extension for each (`….Widget`, `….Clip.Widget`). A `Shared/` folder holds the SwiftUI views, `OrderModel`, and `PagerAttributes`.
- The deployment target is iOS 17. `PAGER_DOMAIN` and `APPLE_TEAM_ID` are injected through XcodeGen `${ENV}` substitution, falling back to `example.com` and an empty team so CI builds without signing.
- Entitlements: associated domains `appclips:` + `applinks:`, and the Clip uses `com.apple.developer.on-demand-install-capable`. Ephemeral notifications come from `NSAppClip.NSAppClipRequestEphemeralUserNotification`.
- CI runs `xcodebuild -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO` for both schemes.

## 8. Ops

- Docker uses a multi-stage `node:22-slim` image. It runs as the non-root `node` user with `/data` as a volume. The `HEALTHCHECK` calls `node -e fetch('/health')`, since curl isn't in the slim image.
- Compose runs `app` and `caddy:2-alpine`, with `flush_interval -1` in the Caddyfile. The README documents Nginx (`proxy_buffering off; proxy_read_timeout 1h`).
- CD skips deploying (rather than failing) until `vars.DEPLOY_PATH` is set, so the first pipeline run can go green before a server exists.
- CD deploys over SSH (`deploy/remote-deploy.sh`, with the registry token passed over stdin) with this rollback: read the current `APP_IMAGE` from `.env`, set the new one, `pull` + `up -d`, then poll `/health` 20 times at 3s intervals. If it fails, restore the old value, run `up -d` again, and fail the job.
- The tests, CI/CD jobs, and README match the brief. Backend e2e tests spawn `node src/server.js` with a temp `DATA_DIR` and a random port. Frontend tests are static and import-level checks run with `node:test`, with no browser.

## 9. Repo layout

```
server/ src/{server,db,config,auth,qr,orders,notify/{webpush,apns},jobs,cli}.js
        public/{s,bar,qr,settings}.html  public/{css,js}/  public/sw.js
        test/{e2e,frontend}.test.js  eslint.config.js  Dockerfile  package.json
ios/    project.yml  Shared/  App/  Clip/  Widget/  ClipWidget/
docs/DESIGN.md  docker-compose.yml  Caddyfile  .env.example  README.md
.github/workflows/{ci,cd}.yml
```

## 10. Need from you

1. **GitHub repo URL**. This is only needed at the push step.
2. Are the **defaults OK?** `TZ=Africa/Cairo`, claim limit 6/min/IP, grace = "previous nonce valid until the next rotation" (no separate timer), iOS 17 minimum, and the `qrcode` dependency.

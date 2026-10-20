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

## 10. Status of v1

Shipped and running at `https://pager.aurexis.cc`. The repo is `aboelhassan22omar/smart-pager`, and the defaults above were accepted. Since the first release, v1 has also gained these:
- **CI/CD:** CI runs once per PR, and CD skips it for verified merges and deploys only what changed.
- **Shop identity:** a shop accent extracted from the logo, and a bigger logo.
- **Google review:** a Google review button after pickup (#9).

Production runs behind the host's existing Nginx with the Caddy profile off, because that server also hosts other sites.

---

# Part II — Multi-tenant platform (v2)

## 11. Goals

**Goals:**
- One deployment and one Node process.
- **Full data isolation** between brands and between branches.
- Four roles: customer, branch staff, brand owner, and super.
- Plans and trials.
- Six growth features: analytics, queue/ETA, late alerts, feedback + Google review, loyalty, and promo.
- Backups.

**Constraints:**
- Hosting, the Docker image, Compose, and the CD approval gate stay as they are.
- Everything external (SMTP, S3) is optional and off by default.

**Out of scope:** the "Now Serving" TV screen, WhatsApp, and external hosting.

**Scale target:** up to about 500 branches per process. SQLite handles this comfortably. The design avoids per-tick work over *all* branches where it can (§19).

## 12. Storage layout

```
/data/
  control.db                         registry only: brands, branches, owners, payments, audit_log
  tenants/<brand_id>/<branch_id>/
    pager.db                         everything operational for that branch
    media/                           logo-<ts>.<ext>, promo-<ts>.<ext>
  backups/<YYYY-MM-DD>/              control.db, tenants/<brand>/<branch>/pager.db, media/, secrets.json
  secrets.json                       unchanged (VAPID keys, COOKIE_SECRET)
```

- **Ids:** brand ids and branch ids both match the existing `SHOP_ID_RE`.
  - New branches are named `<brand>-<area>`, for example `cafex-korba`, and the API enforces that prefix.
  - Migrated shops keep their id, and their brand id is the same, for example `demo-cafe` / `demo-cafe`.
- **Paths:** paths are only ever built from regex-validated ids. `branches.db_path` is stored relative to `/data` for information only, and code always recomputes it.
- **`tenants.js` (handle manager):** opens branch DBs lazily, with the same pragmas as today (`busy_timeout`, WAL, `synchronous=NORMAL`, `foreign_keys`).
  - It runs pending branch migrations on first open.
  - It keeps an LRU of open handles (`TENANT_DB_CACHE`, default 200), closing a handle on eviction and on shutdown.
  - All DB access is synchronous inside a request, so a handle is never evicted mid-query.

## 13. Control DB (`control.db`)

Migrations are numbered and tracked by `PRAGMA user_version`, and each one runs in its own transaction.

| Table | Columns |
|---|---|
| `brands` | `id` PK, `name`, `created_at` |
| `branches` | `id` PK, `brand_id` FK, `name`, `area`, `plan_status` (`trial`/`active`/`past_due`/`suspended`), `trial_ends_at`, `paid_until`, `suspended_manual` 0/1, `ff_review`, `ff_loyalty`, `ff_promo` (owner toggles, 0/1), `forced_off` (JSON array of feature keys, set by super), `db_path`, `created_at`, `last_activity_at` |
| `owners` | `id` PK, `brand_id` FK, `username` unique, `email` (optional, for the weekly summary), `password_hash` (scrypt, same format as PINs), `pw_version`, `created_at`, `last_login_at` |
| `payments` | `id`, `branch_id`, `amount_egp` (integer pounds), `period_start`, `period_end`, `note`, `actor`, `created_at` |
| `audit_log` | `id`, `at`, `actor` (`super`, `owner:<id>`, `cli`, `admin-token`), `action`, `brand_id`, `branch_id`, `detail` (JSON), `ip` |

**Branch names** live in the control DB, because the dashboards list branches without opening every branch DB. Staff settings keep the messages, QR mode, numbers, PIN, logo, and accent. Renaming moves to owner and super (open question Q6).

## 14. Branch DB (`tenants/<brand>/<branch>/pager.db`)

These tables are migrated with `PRAGMA user_version`. The v1 `shops` row becomes a one-row `branch_settings` table.

| Table | Contents |
|---|---|
| `branch_settings` | The v1 shop columns minus `id`/`name`: `pin_hash`, `logo`, `qr_mode`, `qr_nonce`, `qr_prev_nonce`, `qr_rotated_at`, `static_key`, `next_number`, `number_day`, `max_number`, `expire_hours`, `preparing_message`, `ready_message`, `accent_color`, `review_clicks`, plus new columns: `late_after_minutes` (default 10), `google_place_id`, `google_review_url` (v1 legacy, Q3), `loyalty_every` (default 5), `loyalty_reward_text`, `promo_text`, `promo_image`, `promo_starts_at`, `promo_ends_at` |
| `orders` | v1 columns plus `device_hash` (loyalty), `stamped` 0/1, `reward_id` |
| `subscriptions` | Same as v1 |
| `hourly_stats` | `hour_start` PK (ms, local hour in `TZ`), `orders`, `picked`, `cancelled`, `expired`, `late`, `prep_count`, `prep_sum_s`, `prep_median_s`, `wait_count`, `wait_sum_s`, `wait_median_s` |
| `feedback` | `order_id` PK, `rating` 1–5, `comment` ≤ 500 chars, `created_at` |
| `loyalty_devices` | `token_hash` PK, `stamps`, `created_at`, `last_seen_at` |
| `loyalty_rewards` | `id`, `token_hash`, `earned_at`, `attached_order_id`, `redeemed_at` |

## 15. Isolation

**Branch context.** Every branch-scoped route resolves `ctx = {branch, db, store}` once, in an `onRequest` hook:
1. The `:branch` param is checked against the regex.
2. The control row is looked up, giving `404` if it's missing.
3. The tenant handle is opened.
4. A store is bound to that handle.

Store functions only receive `ctx`, and no module imports a global branch store. Cross-branch reads exist only in `src/aggregate.js`, which the brand dashboard uses for its own brand's branches and the super dashboard uses for everything.

**Customer API moves under the branch.** `/s/:branch` stays as is, because the App Clip experience depends on it.

| v1 | v2 |
|---|---|
| `GET /api/shops/:id` | `GET /api/b/:branch` |
| `POST /api/claim {shopId,n,k}` | `POST /api/b/:branch/claim {n,k}` |
| `GET /api/orders/:id` | `GET /api/b/:branch/orders/:id` |
| `GET /api/orders/:id/events` | `GET /api/b/:branch/orders/:id/events` |
| `POST /api/subscribe {orderId,…}` | `POST /api/b/:branch/subscribe` |
| `POST /api/orders/:id/review-click` | `POST /api/b/:branch/orders/:id/review-click` |
| (new) | `POST /api/b/:branch/orders/:id/feedback`, `GET /api/b/:branch/loyalty` |
| `/api/bar/:shop/*` | Unchanged shape (`/api/bar/:branch/*`), now resolved through `ctx` |
| `/media/logos/:file` | `/media/b/:branch/:file` |

- **Orders across branches:** order ids are only looked up in the branch's own DB, so branch A's order id `404`s under branch B automatically.
- **Media:** file names must match `^(logo|promo)-\d+\.(png|jpg|webp)$`. Paths are built with `path.join(mediaDir, file)` and re-checked with `startsWith(mediaDir + sep)`, so path traversal is impossible twice over.

**Realtime.**
- Bus channels are `b:<branch>:order:<id>` and `b:<branch>:bar`, built only from `ctx`. An SSE handler therefore can't subscribe outside its branch.
- An in-memory registry counts open bar and QR streams per branch, which the super dashboard shows as "connected screens".

**Rate limits.** All keys include the branch:
- Claims: `claim|<branch>|<ip>`.
- Staff login: `login|<branch>|<ip>`.
- Device claims: `dev|<branch>|<device>`.
- Owner and super logins are keyed by IP and username.

**Cookies (in-house HMAC; `@fastify/cookie` stays only for parsing and setting).** Each value is `base64url(JSON payload).base64url(HMAC-SHA256)`, with its own key:

| Cookie | Key (HKDF-SHA256 from `COOKIE_SECRET`, salt `smart-pager/v2`) | Payload | Life |
|---|---|---|---|
| `sp_staff_<branch>` | info `staff:<branch>` | `{b, iat, fp}` (PIN fingerprint, as today) `+ imp` when super impersonates | 30 days, or 1h for `imp` |
| `sp_owner` | info `owner:<brand>` | `{o, br, pv}` (`pv` = `pw_version`, bumped on password reset) | 14 days |
| `sp_super` | info `super` | `{iat, hv}` (`hv` = fingerprint of `SUPER_PASSWORD_HASH`) | 12h |

- **Key separation:** a staff cookie forged or copied for branch A fails verification for branch B, even with the same payload, because the keys differ.
- **CSRF:** unchanged. Cookies are SameSite=Strict, and every mutating request must have a JSON content type (or `image/*` for uploads).

**Tests (phase 1).** A table-driven cross-tenant suite runs every customer, staff, owner, and super route. It authenticates as branch A or brand X and asserts `401/403/404` against branch B or brand Y. It also checks that an order id from A `404`s under B, and that two SSE clients (A and B) don't leak events: after B's activity, A's stream receives nothing.

## 16. Roles and routes

| Role | Pages | Auth | API |
|---|---|---|---|
| Customer | `/s/:branch` | QR nonce or static key (as today) + loyalty device token | `/api/b/:branch/*` |
| Staff | `/bar/:branch`, `/qr/:branch`, `/settings/:branch` | Branch PIN | `/api/bar/:branch/*` (as today) |
| Brand owner | `/brand/:brand` | Username + password | `POST /api/brand/login`, `/api/brand/:brand/{overview,analytics,analytics.csv,feedback}`, `POST /api/brand/:brand/branches/:branch/settings` (features, place id, loyalty rule, promo text/dates), `POST/DELETE …/promo-image` |
| Super | `/super` | `SUPER_PASSWORD_HASH` (scrypt), 12h, login limited to 5/min/IP | See below |

**Super API** (every action is written to `audit_log`):
- `GET /api/super/overview` (polled every 10s)
- `POST /api/super/brands`
- `POST /api/super/brands/:brand/branches` (returns the bar, QR, and settings links)
- `POST /api/super/brands/:brand/owners` (create or reset)
- `POST /api/super/branches/:branch/{pin,trial,payments,suspend,resume,features,impersonate}`
- `GET /api/super/audit`

**Super overview card:**
- Branch name and area.
- Plan status and days left.
- Open orders now, connected screens, and orders today.
- Last activity.
- Late orders today.
- Average rating over 7 days.

**Scripting.** `ADMIN_TOKEN` keeps working:
- `POST /api/admin/shops` stays, and now creates a brand plus a branch with the same id.
- New `POST /api/admin/brands` and `/api/admin/branches`.
- New CLI commands: `brand create|list`, `branch create|list|pin|suspend|resume`, `owner create|reset`, `hash-password` (prints a value for `SUPER_PASSWORD_HASH`).

## 17. Plans

The effective plan is computed by `effectivePlan(branch, now)`:

1. `suspended_manual` → `suspended`
2. `now < trial_ends_at` and no `paid_until` → `trial`
3. `paid_until` set:
   - `now ≤ paid_until` → `active`
   - `≤ paid_until + 3 days` → `past_due`
   - otherwise → `suspended`
4. `paid_until` NULL and the trial is over → `suspended`. **Exception:** migrated shops are `active` with `paid_until` NULL, meaning no expiry until super records a first payment (Q5).

- **When plans apply:** new branches get a trial of `TRIAL_DAYS`, default 3 days. A job stores `plan_status` hourly for the dashboards, and requests always use the computed value.
- **What a suspended branch sees:**
  - `POST /api/b/:branch/claim` returns `402 "الخدمة متوقفة مؤقتًا، اسأل الكاشير"`.
  - The bar shows a banner, and open orders finish normally.
  - `past_due` keeps working, with a warning banner on the bar.
- **Payments:** these are manual super entries, with the amount in EGP and a period. Recording one sets `paid_until = max(paid_until, period_end)`.

## 18. Features

Feature flags live on the branch. The brand owner toggles them, and super can force any of them off. The effective state is `owner_on && !forced_off`. Turning a feature off hides it immediately and keeps its data.

### 18.1 Owner analytics (always on)

- **Retention:**
  - Closed orders are kept for **90 days**; they hold no personal data.
  - Subscriptions are deleted 24h after their order closes, as today.
  - `hourly_stats` rows are kept forever.
- **Rollup job:** runs every 5 minutes per branch.
  - It recomputes the current and previous hour, plus any hour that got a newly closed order since the last run, using exact values from `orders` (hour of `created_at` in `TZ`).
  - Prep time is `created→ready`, and pickup wait is `ready→picked`.
  - **Late** means `ready_at − created_at > late_after_minutes`, or an order that closed or expired without ever being ready and was older than the threshold.
- **Brand dashboard:**
  - Brand total plus each branch, for a chosen date range.
  - Orders per day.
  - A peak-hours heatmap (weekday × hour).
  - Median prep time and median pickup wait. These are exact from `orders` when the range is within retention, and otherwise a count-weighted median of the hourly medians, labelled as approximate.
  - Late %.
  - Average rating, and the latest comments, with ratings ≤ 2 highlighted.
  - A CSV export (one row per branch per day).
- **Weekly summary email:** only sent when `SMTP_HOST` and its related variables are set. It goes out Mondays at 09:00 `TZ`, to owners with an email address. It uses a small in-house SMTP client (implicit TLS or STARTTLS, `AUTH PLAIN`) with no dependency (Q8). It's off by default.

### 18.2 Queue position + ETA (always on)

- **Position:** the number of `preparing` orders in the same branch created before this one. It's shown as "قدامك N طلبات".
- **ETA samples:** the prep durations of orders created in the last 14 days, on the same weekday and in the same hour (`TZ`).
  - If there are fewer than 20, it uses all of the last 14 days.
  - If there are still fewer than 20, it shows the position only.
- **ETA range:** the 25th and 75th percentiles of the samples, minus the order's elapsed time, rounded to minutes, with a minimum of 1. It's shown as "حوالي 5–8 دقايق". If even the upper bound has passed, it shows "خلاص قرّب". Percentiles are cached per branch and hour for 5 minutes.
- **Delivery:** on any order change in the branch (claim, ready, cancel, expire), positions are recomputed for its preparing orders. A `queue` event goes only to orders whose position or ETA text changed, over the existing order SSE stream, with no new polling.

### 18.3 Late-order alert (always on)

- **Setting:** staff set `late_after_minutes` (1–120, default 10) in branch settings.
- **Bar:** preparing cards past the threshold turn red and show the elapsed time. This is computed client-side, with no server timer.
- **Chime:** an optional chime is toggled per bar screen and stored in `localStorage` (Q7).
- **Analytics:** late orders are counted in the rollups.

### 18.4 Post-pickup feedback + Google review (`ff_review`, default off until a place id is set)

- **When it shows:** as soon as an order is `picked`, the customer sees thanks, 5 internal stars, an optional comment (≤ 500 chars), **and** a "قيّمنا على جوجل" button, all at the same time. The button links to `https://search.google.com/local/writereview?placeid=<place_id>` and opens in a new tab.
- **Rule: no review gating.** This rule goes in this design doc and is enforced by a test.
  - The Google button is shown to every customer, at the same moment as the stars, whatever rating they give or don't give.
  - We never ask about satisfaction first and route only happy customers to Google.
  - Rewards, loyalty stamps, and discounts are never tied to leaving a review.

  A frontend test renders the picked state for every rating value (none, 1–5) and asserts the Google button is present each time.
- **Feedback:** one submission per order, accepted up to 48h after pickup, and stored in the branch DB. Ratings ≤ 2 are highlighted in the brand and super dashboards. The review-tap count from #9 stays.

### 18.5 Loyalty stamp card (`ff_loyalty`, default off)

- **Rule:** the brand owner sets it per branch: every `loyalty_every` (2–20, default 5) picked orders earns `loyalty_reward_text` (≤ 60 chars).
- **Device token:**
  - On the first claim while loyalty is on, the server creates 32 random bytes.
  - It's sent as the cookie `sp_dev_<branch>` (httpOnly, `Path=/api/b/<branch>`, SameSite=Lax, 400 days), and also returned in the JSON so the page can mirror it into `localStorage`.
  - If the cookie is missing, the page sends the mirror in an `x-device-token` header.
  - The DB stores only `HMAC(HKDF(COOKIE_SECRET, "device:<branch>"), token)`.
  - There's no phone number and no cross-branch data.
- **Stamps:**
  - A stamp is added only when **staff** mark the order `picked` (advance or status).
  - Each order gets at most one stamp (`orders.stamped`).
  - Claims per device are limited to 3 per 15 minutes.
  - On reaching N, a reward row is created and the stamps go back to 0. Unredeemed rewards stack.
- **Redeeming:**
  - The device's next claim attaches its oldest unredeemed reward.
  - The bar card shows a 🎁 badge, and one tap from staff (in the sheet) confirms redemption.
  - If the order closes without redemption, the reward detaches and stays available.
- **Customer view:** the page shows "3 من 5", or "عندك مكافأة: … قولها للكاشير".

### 18.6 Promo space (`ff_promo`, default off)

- **Content:** the owner sets an image and/or text (≤ 120 chars, rendered with `textContent`), with an optional start and end date.
  - The image is PNG, JPG, or WEBP, ≤ 500 KB, and its magic bytes are checked like the logo's.
  - It's stored in the branch's media folder.
- **Display:** it's shown under the order number only while `preparing`. It never covers the number, never appears on the ready screen, and never has links.

## 19. Timers

- **Nonce rotation:** this changes from v1. The 1s tick rotates only branches that have an open bar or QR stream, using the in-memory registry. Claims also reject a nonce older than `2 × NONCE_ROTATE_SECONDS` even if it was never rotated, so the security property ("a photo goes stale within about 2 minutes") holds without touching idle branches (Q13).
- **Expiry, purge, plan refresh, and rollups:** these run every 60s for expiry and every 5 min for rollups, over active branches from the control DB. They use the LRU handles and process at most `JOB_BATCH` branches per tick, round-robin.
- **Backups:** these run in their own daily interval (§20).

## 20. Backups

- **Nightly (03:30 `TZ`):** `VACUUM INTO` of `control.db` and every branch DB into `/data/backups/<YYYY-MM-DD>/…`. The media folders and `secrets.json` are copied too (Q10). Backups are kept for 7 days, and failures are logged and shown on the super dashboard.
- **Before migrations:** at startup, any DB with pending migrations is backed up first, into `/data/backups/pre-migrate-<timestamp>/`.
- **Off-site (optional):** if `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, and `BACKUP_S3_SECRET_ACCESS_KEY` are set, the day's folder is uploaded with in-house SigV4 `PUT`s (Q9). `secrets.json` is never uploaded off-site. This is off by default.
- **Restore runbook (README):**
  1. Stop the app.
  2. Copy a backup day's files over `/data`.
  3. Start the app.
- **Restore test:** a test backs up a populated server, restores the backup into a temp `DATA_DIR`, boots the app on it, and checks the data.

## 21. Migration from v1 (one time, on startup)

The migration runs when `/data/pager.db` exists and `/data/control.db` does not:

1. Checkpoint WAL, then back up `pager.db` with `VACUUM INTO` to `backups/pre-v2-<ts>/`.
2. Build everything in a staging folder, `/data/.v2-staging/`:
   - `control.db`.
   - For each shop: one brand (same id and name) and one branch (same id, `plan_status='active'`, `paid_until` NULL, `ff_review` = 1 if the shop has a review URL).
   - That shop's `branch_settings`, `orders`, and `subscriptions` copied into its branch DB.
   - Its logo copied into its media folder.
3. Verify the per-shop row counts (orders, subscriptions), and that each logo file is present.
4. Only then, move the staging contents into place, and rename `pager.db` (plus `-wal`/`-shm`) to `pager.db.migrated`.
5. **On any mismatch or error:** delete the staging folder, leave `pager.db` untouched, log the reason, and exit non-zero. The container then fails `/health`, and CD's existing rollback brings back the previous image, which still reads `pager.db`.

`secrets.json` and `.env` keep working unchanged. The new environment variables are documented in `.env.example`:
- `SUPER_PASSWORD_HASH`
- `TENANT_DB_CACHE`
- `TRIAL_DAYS`
- `SMTP_*`
- `BACKUP_S3_*`

## 22. iOS

- **Phase 1:** `PagerAPI.swift` moves to `/api/b/<branch>/…`, using the `shopId` it already parses from `/s/{shop}`. No backward-compatible routes are needed, because the App Clip isn't released yet.
- **Feedback, loyalty, and promo:** these stay web-only in this project (Q16).

## 23. Phases

Each phase is one branch and one PR, with CI green, tests, and README + DESIGN updates. Each PR description lists what changed, how to test it manually, any new environment variables, and the migrations it runs.

| # | Scope | Key tests |
|---|---|---|
| 1 | `control.db` + per-branch DBs, `tenants.js` LRU, user_version migrations, v1→v2 migration, `ctx`-scoped stores, `/api/b/:branch/*`, per-branch media, HKDF staff cookies, namespaced bus, branch-keyed rate limits, `PagerAPI.swift`, pre-migration backup | Cross-tenant suite (every route), SSE no-leak, v1 DB → v2 migration with count check + abort path, LRU eviction |
| 2 | Super login + `/super`, owners + `/brand/:brand` shell, plans/trial/payments/suspension + 402, audit log, impersonation, CLI | Plan state machine, 402, audit entries for every action, owner limited to own brand |
| 3 | 90-day retention, `hourly_stats` rollups, analytics dashboard + CSV, late alerts, optional SMTP weekly mail | Rollup math (medians, late), CSV, SMTP off by default |
| 4 | Queue position + ETA over SSE | Position ordering, ETA fallbacks (<20 samples), `queue` events only on change |
| 5 | Feedback + Google review via place id | **Google button present for every rating**, feedback once per order, ≤2 highlighting |
| 6 | Loyalty | Stamp only on staff pickup, one per order, device rate limit, reward attach/redeem, toggle off hides |
| 7 | Promo | Upload validation (≤500 KB, magic bytes), shown only while preparing, dates |
| 8 | Nightly backups, retention 7 days, optional S3, restore runbook + restore test | Restore → boot → data present |

## 23a. Implementation status

**Phase 1 is done.** All proposals in §24 were accepted when this design PR was merged. Notes from the implementation:
- `src/migrations.js` (user_version runner + `VACUUM INTO`), `src/control.js`, `src/db.js` (branch schema), `src/store.js` (`BranchStore`, bound to one file), `src/tenants.js` (LRU), `src/cookies.js` (HKDF), `src/migrate-v1.js`, `src/provision.js`, `src/bootstrap.js`.
- **Staff can still rename the branch.** The name is written to the control DB. This follows Q6 only after phase 2, which adds the owner dashboard, so that someone can still rename a branch.
- **v1 migration and logo files:** a missing v1 logo file logs a warning, and the branch starts without a logo. It doesn't abort, because there is nothing to lose. Row-count mismatches and any error do abort.
- **Dry run:** the migration was run against a snapshot of the production database before release. Settings, nonce, static key, PIN hash, and all orders came out identical, and the logo moved byte for byte.

**Phase 2 is done.**
- **Control migration 2:** adds the plan columns, the feature flags and `forced_off` to `branches`, plus the `owners`, `payments` and `audit_log` tables.
- **New modules:** `src/plans.js` (`effectivePlan`, `planView`, `featureFlags`), `src/sessions.js` (staff/owner/super cookies), `src/aggregate.js` (the only cross-branch reader), `src/routes/super.js`, `src/routes/brand.js`, and the `/super` and `/brand/:brand` pages.
- **Q6 now applies:** staff settings no longer rename the branch; owners and super do.
- **"Late today"** on the dashboards uses a fixed 10-minute threshold until phase 3 adds `late_after_minutes`.
- **"Average rating"** shows "—" until phase 5.

## 24. Open questions

These are places where the brief conflicts with the current code, or needs a decision. Each one has my proposal.

1. **CI trigger.** The brief says "CI on branch pushes". Since #6, CI runs on `pull_request` only, and CD skips re-running it for verified merges; you asked for that to stop the triple runs. **Proposal: keep it** (CI on every PR push, deploy after merge with approval).
2. **Caddy.** Production runs behind the host's Nginx with the Caddy profile off, because the server hosts other sites. **Proposal:** keep both supported, as today, with no change.
3. **Google review source.** #9 shipped a free-form Google review URL (g.page, maps.app.goo.gl, and so on) set by staff, with tap counting. The brief wants `writereview?placeid=`. **Proposal:**
   - Add `google_place_id`, editable by the brand owner per branch, because a place id belongs to one location.
   - Migrate it automatically when the stored URL contains `placeid=`.
   - Otherwise keep the old URL as a fallback until a place id is set, and remove the staff field.
4. **Feature 4 default on migrated shops.** **Proposal:** `ff_review = 1` for shops that already have a review link, so production keeps working, and 0 otherwise.
5. **Migrated shops' plan.** **Proposal:** `active` with no expiry (`paid_until` NULL) until you record a first payment. New branches get a 3-day trial.
6. **Branch name.** Today staff can rename the shop in settings. The name moves to the control DB. **Proposal:** owner and super rename it, and staff can't.
7. **Late chime toggle.** **Proposal:** per bar screen (`localStorage`), not a branch setting, so a quiet back-office screen doesn't silence the counter.
8. **Weekly email.** **Proposal:** an in-house SMTP client of about 150 lines, rather than adding `nodemailer`. OK?
9. **Off-site backup.** **Proposal:** in-house SigV4 for S3-compatible storage (AWS, R2, B2, MinIO), with no SDK dependency. OK?
10. **What a backup contains.** **Proposal:**
    - The DBs, media folders, and `secrets.json` locally (without `secrets.json`, a restore loses sessions and push keys).
    - Never `secrets.json` off-site.
11. **Loyalty after a reward.** **Proposal:** stamps reset to 0, unredeemed rewards stack, and a reward never expires. Should rewards expire, for example after 30 days?
12. **Device claim limit.** **Proposal:** 3 claims per device per 15 minutes, on top of the per-IP limit.
13. **Nonce rotation scope.** **Proposal:** rotate only branches with an open bar or QR screen, and reject nonces older than 2× the rotation period at claim time (§19). That keeps the "stale photo" guarantee without touching idle branches.
14. **Owner login.** **Proposal:** a unique username, plus an optional email used only for the weekly summary.
15. **Who sees feedback comments.** **Proposal:** the brand owner and super only, and not branch staff.
16. **iOS scope.** **Proposal:** iOS gets the route change in phase 1. Feedback, loyalty, and promo stay web-only for now, because the App Clip isn't released.
17. **Branch id prefix.** **Proposal:** enforce `<brand>-<area>` for new branches. Migrated ids (for example `demo-cafe`) are exempt.

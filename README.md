<div dir="rtl">

# Smart Pager — من Aurexis

بديل للبيجر (الجهاز اللي بيرن) في الكافيهات والمطاعم، **من غير ما العميل ينزّل أي تطبيق**.
العميل بيمسح QR عند الكاشير، بياخد رقم طلب على الموبايل، وموبايله بيرن أول ما الطلب يجهز.

- **العميل:** صفحة ويب بتفتح من الكاميرا. فيها رقم الطلب وحالته لحظة بلحظة. ولما الطلب يجهز الشاشة كلها بتبقى خضرا وبترن وبتهز لحد ما يلمسها.
- **الكاشير / البار:** شاشة فيها كل الطلبات المفتوحة. دوسة واحدة تخلّي الطلب جاهز وترن على العميل، ودوسة تانية تعلّمه إنه اتسلّم، ودوسة طويلة تفتح اختيارات أكتر.
- **أندرويد:** إشعار Web Push واحد لكل طلب، ساكت وقت التحضير وبيرن لما يجهز.
- **آيفون:** الصفحة بترن طول ما هي مفتوحة. ولما حساب Apple يبقى جاهز، فيه App Clip و Live Activity على شاشة القفل والـ Dynamic Island.

```
موبايل العميل ──HTTPS──► Caddy ──► Node 22 + Fastify (عملية واحدة)
  SSE / Web Push / APNs  ◄──────── SQLite (node:sqlite) في /data
```

## محتوى المستودع

| المسار | الوصف |
|---|---|
| `server/` | السيرفر: Fastify 5 و SQLite و SSE و Web Push و APNs، والصفحات (HTML/JS من غير build) |
| `ios/` | مشروع XcodeGen: التطبيق والـ App Clip وإضافات الـ Live Activity |
| `docker-compose.yml` و `Caddyfile` | التشغيل على السيرفر مع HTTPS تلقائي |
| `deploy/remote-deploy.sh` | سكربت النشر اللي بيشتغل على السيرفر، وفيه الرجوع التلقائي للنسخة القديمة |
| `.github/workflows/` | `ci.yml` و `cd.yml` |
| `docs/DESIGN.md` | وثيقة التصميم |

## الصفحات

| الرابط | لمين |
|---|---|
| `/s/{shopId}` | العميل (بيفتح من الـ QR) |
| `/bar/{shopId}` | البار / الكاشير (محمي برقم سري) |
| `/qr/{shopId}` | شاشة الـ QR جنب الكاشير (بيتغير تلقائي)، والطباعة للكود الثابت |
| `/settings/{shopId}` | الإعدادات: الشعار والرسايل ونوع الكود والأرقام والرقم السري |

## التشغيل على جهازك

محتاج Node.js 22.13 أو أحدث.

```bash
cd server
npm ci
ADMIN_TOKEN=dev-token PUBLIC_URL=http://localhost:3000 npm start
```

في terminal تاني اعمل محل:

```bash
cd server
npm run cli -- create demo-cafe "كافيه التجربة" 1234
```

بعد كده افتح:

- `http://localhost:3000/bar/demo-cafe` وادخل بالرقم السري `1234`
- `http://localhost:3000/qr/demo-cafe` وامسح الكود من موبايل على نفس الشبكة (غيّر `PUBLIC_URL` لعنوان جهازك على الشبكة)

> الـ Web Push والـ Wake Lock محتاجين HTTPS على الموبايل. للتجربة الكاملة استخدم دومين حقيقي أو نفق زي `cloudflared`.

### الأوامر

```bash
npm run check          # node --check على كل ملفات JS
npm run lint           # ESLint 9
npm test               # اختبارات end-to-end (بتشغّل السيرفر الحقيقي على DATA_DIR مؤقت)
npm run test:frontend  # اختبارات الواجهة (RTL و Powered by والـ splash و esc والـ service worker)
```

### أوامر الـ CLI

```bash
node src/cli.js create <id> <name> <pin> [dynamic|static|both]
node src/cli.js pin <id> <newPin>
node src/cli.js list
```

## متغيرات البيئة

كل المتغيرات موجودة في [`.env.example`](.env.example). أهمها:

| المتغير | الافتراضي | الوصف |
|---|---|---|
| `DOMAIN` | — | الدومين اللي Caddy هيطلّع له شهادة HTTPS |
| `PUBLIC_URL` | `http://localhost:3000` | الرابط اللي بيتحط جوه الـ QR |
| `ADMIN_TOKEN` | فاضي | بيفعّل `POST /api/admin/shops`. لو فاضي الـ API ده بيبقى مقفول |
| `TZ` | `Africa/Cairo` | الأرقام بتبدأ من 1 كل يوم على التوقيت ده |
| `NONCE_ROTATE_SECONDS` | `60` | الكود المتغير بيتغير كل كام ثانية (وكمان بعد كل عميل) |
| `CLAIM_RATE_PER_MIN` | `6` | أقصى عدد محاولات لأخذ رقم في الدقيقة من نفس الـ IP |
| `VAPID_*` و `COOKIE_SECRET` | تلقائي | لو فاضيين، بيتعملوا مرة واحدة ويتحفظوا في `/data/secrets.json` |
| `APPLE_*` و `APNS_*` | فاضي | إعدادات Apple (شوف قسم Apple تحت) |

## أول إعداد للسيرفر

1. **سيرفر Linux** (Ubuntu 22.04 أو أحدث) عليه Docker و Compose plugin:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo adduser --disabled-password deploy && sudo usermod -aG docker deploy
   ```
2. **DNS:** اعمل A record للدومين (مثلاً `pager.example.com`) يشاور على IP السيرفر، وافتح البورتات 80 و 443.
3. **مفتاح SSH للنشر:** اعمله على جهازك:
   ```bash
   ssh-keygen -t ed25519 -f deploy_key -C "github-deploy" -N ""
   ssh-copy-id -i deploy_key.pub deploy@SERVER_IP
   ```
   محتوى `deploy_key` هيبقى قيمة الـ secret اللي اسمه `SSH_PRIVATE_KEY`.
4. **مجلد التشغيل وملف `.env`** على السيرفر:
   ```bash
   sudo mkdir -p /opt/smart-pager/secrets && sudo chown -R deploy: /opt/smart-pager
   cd /opt/smart-pager
   # انسخ .env.example من المستودع لـ .env وعدّل DOMAIN و PUBLIC_URL و ADMIN_TOKEN
   nano .env
   ```
   عشان تعمل `ADMIN_TOKEN` قوي: `openssl rand -base64 32`
5. **أول نشر:** اعمل push على `main` (أو شغّل CD يدوي من تبويب Actions). الـ workflow هينسخ `docker-compose.yml` و `Caddyfile`، ويحط `APP_IMAGE`، ويشغّل كل حاجة.
   لو عايز تشغّل يدوي من غير CD: `docker compose up -d --build`.

## إنشاء محل

من جوه الحاوية على السيرفر:

```bash
cd /opt/smart-pager
docker compose exec app node src/cli.js create cafe-zamalek "كافيه الزمالك" 4821
```

أو من أي مكان عن طريق الـ Admin API:

```bash
curl -X POST https://pager.example.com/api/admin/shops \
  -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"id":"cafe-zamalek","name":"كافيه الزمالك","pin":"4821","qrMode":"dynamic"}'
```

- **المعرّف (`id`):** من 3 لـ 32 حرف إنجليزي صغير أو أرقام أو `-`.
- **الرقم السري:** من 4 لـ 8 أرقام.

بعد كده سلّم المحل الرابطين `/bar/{id}` و `/qr/{id}`.

### أنواع الكود

| النوع | الاستخدام |
|---|---|
| `dynamic` | الكود على شاشة عند الكاشير، وبيتغير بعد كل عميل وكل دقيقة. الكود اللي قبله بيفضل شغّال لحد التغيير الجاي، عشان لو اتنين مسحوا في نفس اللحظة. صورة الكود بتبطل تشتغل في خلال دقيقتين تقريباً. |
| `static` | ورقة مطبوعة على الكاونتر. أي حد معاه صورة منها يقدر ياخد رقم، وده اللي حد الطلبات لكل IP بيقلّله. غيّر الكود من الإعدادات لو حسيت إنه اتسرّب. |
| `both` | الاتنين شغالين مع بعض. |

## إعداد GitHub

### 1. Workflow permissions
**Settings ← Actions ← General ← Workflow permissions:** خليها `Read and write permissions` عشان النشر على `ghcr.io`، أو سيبها Read بس، لأن الـ jobs بتطلب `packages: write` بنفسها.

### 2. الـ environment اللي اسمه `production`
**Settings ← Environments ← New environment ← `production`:**
- **Required reviewers:** ضيف نفسك. كده كل نشر هيستنى موافقتك.
- **Deployment branches:** خليها `main` بس.
- **Environment secrets:**

  | الاسم | القيمة |
  |---|---|
  | `SSH_HOST` | IP السيرفر أو اسمه |
  | `SSH_USER` | `deploy` |
  | `SSH_PRIVATE_KEY` | محتوى `deploy_key` |
  | `SSH_PORT` | `22` (اختياري) |

- **Environment variables:**

  | الاسم | القيمة |
  |---|---|
  | `PUBLIC_URL` | `https://pager.example.com` |
  | `DEPLOY_PATH` | `/opt/smart-pager` |

- **Repository variable** (من **Settings ← Secrets and variables ← Actions ← Variables**): لازم تحط `DEPLOY_PATH` هنا كمان بنفس القيمة. ده عشان شرط تشغيل مرحلة النشر بيتقيّم قبل ما الـ job يدخل الـ environment، فمش بيشوف متغيرات الـ environment.

> لو `DEPLOY_PATH` مش متحدد على مستوى المستودع، مرحلة النشر بتتعدّى من غير ما تفشل. ده مقصود عشان أول تشغيل يعدّي قبل ما السيرفر يبقى جاهز.

### 3. حماية الفرع `main`
**Settings ← Branches ← Add rule** (أو Rulesets) للفرع `main`:
- فعّل **Require a pull request before merging**.
- فعّل **Require status checks to pass** واختار:
  `CI - Syntax check` و `CI - Lint` و `CI - Backend tests` و `CI - Frontend tests` و `CI - Asset audit` و `CI - Docker Compose validation` و `CI - Image build (linux/amd64)` و `CI - Image build (linux/arm64)`.
  ضيف `CI - iOS build` كمان لو عايزه إجباري. بس خلي بالك إنه بيشتغل بس لما مجلد `ios/` يتغير.
- فعّل **Require branches to be up to date** و **Block force pushes**.

### المراحل
- **`ci.yml`** بيشتغل على أي push لفرع غير `main`، وعلى كل PR، ولما `cd.yml` يستدعيه. فيه: الاعتماديات، والفحص، والـ lint (ومعاه actionlint)، والاختبارات، و `npm audit`، والتحقق من Compose و Caddy، وبناء الصورة لـ amd64 و arm64 ومعاه smoke test، وبناء iOS على macOS لو `ios/` اتغير.
- **`cd.yml`** بيشتغل على `main`. بيعيد الـ CI، وبعدين يشوف إيه اللي اتغير، ويبني وينشر الصورة على `ghcr.io/<owner>/<repo>` بالـ tags `sha-<sha>` و `latest`، وبعدها يستنى موافقتك وينشر على السيرفر.
  لو `/health` فشل بعد النشر، `APP_IMAGE` بيرجع للصورة القديمة تلقائي.

### النشر بيحدّث اللي اتغير بس

| اللي اتغير | اللي بيحصل في البرودكشن |
|---|---|
| كود التطبيق (`server/src` و `server/public` و `package*.json` و `Dockerfile`) | صورة جديدة، وبعدين `pull` و `up -d --no-deps app`. container الـ app بس اللي بيتعاد تشغيله |
| `docker-compose.yml` أو `Caddyfile` أو `deploy/` | الملفات دي بس بتتنسخ، و compose بيعيد تشغيل الخدمات اللي إعداداتها اتغيرت بس |
| الاختبارات أو lint أو الـ README أو iOS أو ملفات الـ workflows | الـ CI بيشتغل، ومفيش بناء صورة ولا نشر |
| تشغيل يدوي (Run workflow) | نشر كامل للصورة والملفات |

### Dependabot
- بيفتح PRs كل أسبوع لـ npm والـ actions، وكل شهر لصورة Docker.
- الترقيات الكبيرة (major) لـ Node و ESLint متجاهلة عن قصد. المشروع مبني على Node 22 و ESLint 9، والترقية دي بتتعمل يدوي في الـ CI والصورة مع بعض.
- أي PR لازم الـ CI بتاعه يعدّي قبل الـ merge، لأن `main` محمي.

## Apple (App Clip و Live Activity)

كل حاجة جاهزة للبناء. ناقص بس حساب Apple Developer.

1. **حساب Apple Developer:** خد الـ **Team ID** من Membership.
2. **Identifiers:** سجّل:
   - `cc.aurexis.pager` (App) وفعّل Associated Domains و Push Notifications.
   - `cc.aurexis.pager.Clip` (App Clip) وفعّل نفس القدرات.
   - `cc.aurexis.pager.Widget` و `cc.aurexis.pager.Clip.Widget`.
3. **مفتاح APNs:** من Keys اعمل مفتاح جديد فيه *Apple Push Notifications service* ونزّل `AuthKey_XXXXXX.p8`. حطّه على السيرفر في `/opt/smart-pager/secrets/AuthKey.p8`.
4. **`.env` على السيرفر:**
   ```env
   APPLE_TEAM_ID=ABCDE12345
   APPLE_APP_ID=1234567890        # رقم التطبيق في App Store Connect
   APNS_KEY_ID=XXXXXX
   APNS_KEY_PATH=/secrets/AuthKey.p8
   APNS_ENV=production            # sandbox لبناءات Xcode التجريبية
   ```
   وبعدين `docker compose up -d`.
   اتأكد إن `https://DOMAIN/.well-known/apple-app-site-association` بيرجع JSON، وإن حالة Apple في صفحة الإعدادات بقت "شغّال".
5. **توليد المشروع** (على Mac عليه Xcode 16 و `brew install xcodegen`):
   ```bash
   cd ios
   PAGER_DOMAIN=pager.example.com APPLE_TEAM_ID=ABCDE12345 ./generate.sh
   open SmartPager.xcodeproj
   ```
6. **App Store Connect:** ارفع التطبيق ومعاه الـ App Clip، واعمل **App Clip Experience** بالرابط `https://pager.example.com/s/`. لما الـ App Clip يتنشر، Safari هيعرض بانر التشغيل تلقائي، لأن السيرفر بيحط `apple-itunes-app` في صفحة العميل.
7. **التجربة:** في Xcode اختار scheme اسمه `SmartPagerClip`، وفي *Edit Scheme ← Run ← Environment* حط `_XCAppClipURL=https://pager.example.com/s/demo-cafe?k=...`.

> الـ App Clip بيطلب `Activity.request(pushType: .token)` وبيبعت التوكن لـ `/api/subscribe`. بعدها السيرفر بيحدّث الـ Live Activity مع كل تغيير في الحالة، وبيرن على شاشة القفل لما الطلب يجهز.

## بديل Nginx بدل Caddy

```nginx
server {
    listen 443 ssl http2;
    server_name pager.example.com;
    ssl_certificate     /etc/letsencrypt/live/pager.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pager.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3100;   # = APP_PORT
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        # SSE: من غير buffering ومع اتصال طويل
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        client_max_body_size 3M;
    }
}
```

لو السيرفر عليه Nginx شغّال أصلاً على 80/443، احذف السطر `COMPOSE_PROFILES=caddy` من `.env` على السيرفر، وكده Caddy مش هيشتغل. وحدد `APP_PORT` (مثلاً `3100`)، والتطبيق هيتفتح على `127.0.0.1:$APP_PORT` بس. بعدها خلي `proxy_pass` يشاور على البورت ده، وطلّع الشهادة بـ `certbot --nginx -d pager.example.com`. وزوّد `client_max_body_size 3M;` عشان رفع الشعار.
لاحظ إن `X-Forwarded-For` هنا بيتحط بـ `$remote_addr` بس، عشان محدش يقدر يزوّر الـ IP ويعدّي حد الطلبات.

## ملاحظات أمان

- **Order ID:** بيتعمل من 16 byte عشوائي، ومينفعش حد يخمّنه. ده المفتاح الوحيد اللي العميل معاه.
- **الرقم السري:** متخزّن بـ scrypt. الكوكي موقّعة و `httpOnly` و `SameSite=Strict`، ولما الرقم السري يتغير كل الجلسات القديمة بتقفل.
- **الشعار:** PNG أو JPG أو WEBP بس (السيرفر بيتأكد من محتوى الملف نفسه مش الامتداد بس)، وأقصى حجم 2 ميجا، و SVG ممنوع.
- **Web Push:** السيرفر مش بيبعت غير لخدمات Push المعروفة (Google و Mozilla و Apple و Microsoft).
- **CSP:** بيسمح بـ `self` بس، ومفيش أي inline scripts.

</div>

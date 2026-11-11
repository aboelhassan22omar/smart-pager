// Inside an installed app (cashier or owner): when a newer build is out (new template, new
// logo, renamed brand) the app takes it by itself, at a quiet moment. Nothing to remove:
//   Windows: from 1.1.0 the app fetches the new exe, swaps it in and reopens, on its own. Older
//            ones get the zip to run after closing the app.
//   Android: the APK downloads and the installer opens; Android asks for one tap on «تحديث»
//            (no app can install itself silently). Until then a bar says an update is waiting,
//            and the installer opens again an hour later.
// The pages themselves (the web part) reload on a new server version: see util.js.

import { api, esc, isCashierApp, pageBusy } from './util.js';

const CHECK_MS = 15 * 60_000;
// Nobody touched the screen for this long: updating now interrupts no one.
const QUIET_MS = 30_000;
const ANDROID_RETRY_MS = 3600_000;
const ANDROID_KEY = 'sp:update-opened';

let lastTouch = Date.now();
let pending = null;
let started = false;

function bar() {
  let el = document.getElementById('app-update');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-update';
    el.className = 'app-update';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  return el;
}

function hint(info) {
  if (info.platform === 'android') return 'لما التحميل يخلص، دوس «تحديث» في الشاشة اللي هتظهر. مش محتاج تمسح التطبيق.';
  if (info.inApp) return 'البرنامج هيقفل ويفتح لوحده بالنسخة الجديدة.';
  return 'لما التحميل يخلص: اقفل البرنامج، وافتح الملف اللي نزل وشغّل اللي جواه. هيحل مكان القديم.';
}

const selfUpdating = (info) => Boolean(info.inApp && info.rawUrl && window.ipc?.postMessage);

function start(info) {
  started = true;
  if (selfUpdating(info)) {
    window.ipc.postMessage(`update:${new URL(info.rawUrl, location.href).href}`);
  } else {
    try {
      localStorage.setItem(ANDROID_KEY, String(Date.now()));
    } catch {
      /* private mode */
    }
    location.href = info.url;
  }
  bar().innerHTML = `<span>بيتحدّث… ${esc(hint(info))}</span>`;
}

function show(info) {
  const el = bar();
  el.innerHTML = `
    <span>فيه نسخة جديدة، هتتحدّث لوحدها أول ما الشاشة تفضى</span>
    <button class="btn btn-sm btn-primary" type="button" data-update>حدّث دلوقتي</button>`;
  el.hidden = false;
  el.onclick = (e) => {
    if (e.target.closest('[data-update]')) start(info);
  };
}

// Android opens the installer again only an hour after the last time it was opened.
function androidDue() {
  try {
    return Date.now() - Number(localStorage.getItem(ANDROID_KEY) ?? 0) > ANDROID_RETRY_MS;
  } catch {
    return true;
  }
}

function tryNow() {
  if (!pending || started) return;
  if (Date.now() - lastTouch < QUIET_MS || pageBusy()) return;
  if (!selfUpdating(pending) && !androidDue()) return;
  start(pending);
}

/** Checks now and every 15 minutes; quiet outside the apps and on any error. */
export function watchAppUpdates() {
  if (typeof document === 'undefined' || !isCashierApp(document)) return;
  for (const e of ['pointerdown', 'keydown']) document.addEventListener(e, () => { lastTouch = Date.now(); }, true);
  const check = async () => {
    try {
      const info = await api('/api/app/update');
      if (!info.update) return;
      pending = info;
      if (!started) show(info);
      tryNow();
    } catch {
      /* offline or signed out: next time */
    }
  };
  check();
  setInterval(check, CHECK_MS);
  setInterval(tryNow, 10_000);
}

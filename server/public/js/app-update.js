// Inside an installed app (cashier or owner): when a newer build is out (new template, new
// logo, renamed brand) a bar offers it. The update installs over the app, nothing to remove:
//   Android: the APK downloads and the installer opens (from 1.1.0 by itself, before that from
//            the download notification).
//   Windows: from 1.1.0 the app fetches the new exe, swaps it in and reopens; older ones get
//            the zip to run after closing the app.

import { api, esc, isCashierApp } from './util.js';

const CHECK_MS = 6 * 3600 * 1000;
const DISMISS_KEY = 'sp:update-dismissed';

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

function show(info) {
  const el = bar();
  el.innerHTML = `
    <span>فيه نسخة جديدة من التطبيق</span>
    <button class="btn btn-sm btn-primary" type="button" data-update>حدّث</button>
    <button class="app-update-close" type="button" aria-label="بعدين" data-later>✕</button>`;
  el.hidden = false;
  el.onclick = (e) => {
    if (e.target.closest('[data-later]')) {
      el.hidden = true;
      try {
        sessionStorage.setItem(DISMISS_KEY, '1');
      } catch {
        /* private mode */
      }
      return;
    }
    if (!e.target.closest('[data-update]')) return;
    const absolute = (u) => new URL(u, location.href).href;
    if (info.inApp && info.rawUrl && window.ipc?.postMessage) {
      window.ipc.postMessage(`update:${absolute(info.rawUrl)}`);
    } else {
      location.href = info.url;
    }
    el.innerHTML = `<span>بيتحمّل… ${esc(hint(info))}</span>`;
  };
}

/** Checks now and every few hours; quiet outside the apps and on any error. */
export function watchAppUpdates() {
  if (typeof document === 'undefined' || !isCashierApp(document)) return;
  const check = async () => {
    try {
      if (sessionStorage.getItem(DISMISS_KEY)) return;
    } catch {
      /* private mode */
    }
    try {
      const info = await api('/api/app/update');
      if (info.update) show(info);
    } catch {
      /* offline or signed out: next time */
    }
  };
  check();
  setInterval(check, CHECK_MS);
}

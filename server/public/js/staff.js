// Shared bits for the PIN-protected staff pages (bar, qr, settings).

import { connectionWatch } from './app-report.js';
import { api, esc, isCashierApp } from './util.js';

export function toast(message, tone = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.append(el);
  }
  el.textContent = message;
  el.dataset.tone = tone;
  el.classList.add('is-shown');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('is-shown'), 2600);
}

// Renders the PIN form into `root` and resolves once the session cookie is set.
export function showLogin(root, shopId, shopName) {
  root.innerHTML = `
    <form class="login" novalidate>
      <h1>${esc(shopName || 'دخول الموظفين')}</h1>
      <p class="muted">اكتب الرقم السري بتاع المحل</p>
      <input class="input" name="pin" type="password" inputmode="numeric" autocomplete="current-password"
             maxlength="8" aria-label="الرقم السري" required>
      <p class="form-error" hidden></p>
      <button class="btn btn-primary btn-block" type="submit">دخول</button>
    </form>`;
  const form = root.querySelector('form');
  const input = form.elements.pin;
  const error = form.querySelector('.form-error');
  input.focus();

  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      error.hidden = true;
      try {
        await api('/api/bar/login', { method: 'POST', body: { shopId, pin: input.value.trim() } });
        root.innerHTML = '';
        resolve();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.select();
      } finally {
        button.disabled = false;
      }
    });
  });
}

// In the cashier app (a linked device) an expired staff session renews without the PIN.
// When the PIN changed the app goes back to its setup page; anywhere else this is a no-op.
async function renewFromApp(shopId) {
  try {
    await api('/api/app/renew', { method: 'POST', body: { shopId } });
    return true;
  } catch (err) {
    if (err.data?.relink) location.replace(err.data.relink);
    return false;
  }
}

// Loads bar state, asking for the PIN first when there is no session.
export async function loadStaffState(shopId, root) {
  let renewed = false;
  for (;;) {
    try {
      return await api(`/api/bar/${encodeURIComponent(shopId)}/state`);
    } catch (err) {
      if (err.status !== 401) throw err;
      if (!renewed && isCashierApp()) {
        renewed = true;
        if (await renewFromApp(shopId)) continue;
      }
      let name = '';
      try {
        name = (await api(`/api/b/${encodeURIComponent(shopId)}`)).name;
      } catch {
        name = '';
      }
      await showLogin(root, shopId, name);
    }
  }
}

// EventSource with status callback and manual reconnect after hard failures.
// Also: "reload" (the super refreshing this cashier app's screen) and, in the app,
// long connection drops for the device's error log.
export function staffEvents(shopId, handlers, onStatus, { screen = 'bar' } = {}) {
  let es = null;
  let retry = null;
  const watch = connectionWatch();
  const status = (online) => {
    watch(online);
    onStatus(online);
  };
  const connect = () => {
    es = new EventSource(`/api/bar/${encodeURIComponent(shopId)}/events?screen=${screen}`);
    es.addEventListener('open', () => status(true));
    es.addEventListener('reload', () => location.reload());
    es.addEventListener('error', () => {
      status(false);
      if (es.readyState === EventSource.CLOSED) {
        clearTimeout(retry);
        retry = setTimeout(connect, 3000);
      }
    });
    for (const [event, fn] of Object.entries(handlers)) {
      es.addEventListener(event, (e) => fn(JSON.parse(e.data)));
    }
  };
  connect();
  return () => {
    clearTimeout(retry);
    es?.close();
  };
}

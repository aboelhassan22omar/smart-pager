// Keeps the screen on while the page is visible; re-acquires after tab switches.

let sentinel = null;
let wanted = false;

async function acquire() {
  if (!wanted || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    sentinel = null;
  }
}

export function keepAwake() {
  wanted = true;
  return acquire();
}

export function releaseAwake() {
  wanted = false;
  sentinel?.release();
  sentinel = null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!sentinel) acquire();
  });
}

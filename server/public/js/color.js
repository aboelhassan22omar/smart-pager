// Brand accent from the shop logo. Pure functions (Node-importable); the server uses
// readableAccent() too, so customers always get a legible accent whatever was stored.
//
// The accent is the 10% of the 60/30/10 split: it replaces the default latte only.

export const BG = '#1e1f21';
const DARK_INK = '#1e1f21';
const LIGHT_INK = '#ffffff';
const MIN_UI_CONTRAST = 3; // WCAG 1.4.11 for UI parts against the graphite background

export function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function luminance([r, g, b]) {
  const c = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a, b) {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Hues that already mean something here: green = ready, red = cancel.
export function isStateHue(h, s) {
  return s > 0.35 && ((h >= 95 && h <= 165) || h >= 345 || h <= 15);
}

/**
 * Picks the dominant saturated color from RGBA pixel data (e.g. canvas ImageData.data).
 * Ignores transparent, near-black, near-white and greyish pixels. Skips hues that would
 * read as "ready" or "cancel". Returns a hex string, or null for monochrome logos.
 */
export function extractAccent(data) {
  const bins = Array.from({ length: 36 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < 0.28 || l < 0.14 || l > 0.88) continue;
    const w = s * (1 - Math.abs(l - 0.5));
    const bin = bins[Math.floor(h / 10) % 36];
    bin.w += w;
    bin.r += r * w;
    bin.g += g * w;
    bin.b += b * w;
    total += w;
  }
  if (total === 0) return null;

  // Score each hue bin with half of its neighbours so a gradient counts as one color.
  const scored = bins
    .map((bin, i) => ({ bin, score: bin.w + 0.5 * (bins[(i + 35) % 36].w + bins[(i + 1) % 36].w) }))
    .filter(({ bin }) => bin.w / total >= 0.04)
    .sort((x, y) => y.score - x.score);

  for (const { bin } of scored) {
    const color = rgbToHex(bin.r / bin.w, bin.g / bin.w, bin.b / bin.w);
    const [h, s] = rgbToHsl(...hexToRgb(color));
    if (!isStateHue(h, s)) return color;
  }
  return null;
}

/** Lightens `hex` until it stands out on the background, and picks the text color for it. */
export function readableAccent(hex, bg = BG) {
  const [h, s, start] = rgbToHsl(...hexToRgb(hex));
  let l = start;
  let color = hex.toLowerCase();
  for (let i = 0; i < 50 && contrast(color, bg) < MIN_UI_CONTRAST && l < 0.97; i++) {
    l = Math.min(0.97, l + 0.02);
    color = rgbToHex(...hslToRgb(h, s, l));
  }
  const ink = contrast(color, DARK_INK) >= contrast(color, LIGHT_INK) ? DARK_INK : LIGHT_INK;
  return { color, ink };
}

/** Sets the accent tokens on an element (usually document.documentElement); null restores the default. */
export function applyAccent(el, accent) {
  if (!el) return;
  if (!accent) {
    el.style.removeProperty('--accent');
    el.style.removeProperty('--on-accent');
    return;
  }
  el.style.setProperty('--accent', accent.color);
  el.style.setProperty('--on-accent', accent.ink);
}

/** Browser only: dominant accent of an image (HTMLImageElement / ImageBitmap). */
export function accentFromImage(image, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, size, size);
  return extractAccent(ctx.getImageData(0, 0, size, size).data);
}

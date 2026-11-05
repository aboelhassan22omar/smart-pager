// Brand accent from the shop logo. Pure functions (Node-importable); the server uses
// readableAccent() too, so customers always get a legible accent whatever was stored.
//
// A branch's color tints the whole page (brandTheme), not only the buttons, so it feels like its own.

export const BG = '#17191d';
const DARK_INK = '#17191d';
const LIGHT_INK = '#ffffff';
const MIN_UI_CONTRAST = 3; // WCAG 1.4.11 for UI parts against the graphite background
const DANGER = '#c8574f';
const MIN_TEXT_CONTRAST = 4.5; // WCAG 1.4.3 for the text on a button in that color

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

// A black-and-white logo gets a true grey look, so it still differs from the default blue.
export const MONO_COLOR = '#ececec';
const MIN_COLOR_SHARE = 0.015; // of the logo's visible area

/**
 * The logo's own color from RGBA pixel data (e.g. canvas ImageData.data): the hue that covers
 * the most, a colored background included. White, black and greys don't count, and neither do
 * pale tints that are really just paper. Red and green logos keep their color: the ready and
 * cancel screens are recognizable by more than the hue. Returns MONO_COLOR when the logo has no
 * color at all, or null when nothing in the image is visible.
 */
export function extractAccent(data) {
  const bins = Array.from({ length: 36 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let total = 0;
  let visible = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    visible += 1;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);
    if (Math.max(r, g, b) - Math.min(r, g, b) < 30 || s < 0.15 || l > 0.93) continue;
    const w = l > 0.82 ? 0.25 : 1;
    const bin = bins[Math.floor(h / 10) % 36];
    bin.w += w;
    bin.r += r * w;
    bin.g += g * w;
    bin.b += b * w;
    total += w;
  }
  if (!visible) return null;
  if (total / visible < MIN_COLOR_SHARE) return MONO_COLOR;

  // Score each hue bin with half of its neighbours so a gradient counts as one color.
  const [{ bin }] = bins
    .map((b, i) => ({ bin: b, score: b.w + 0.5 * (bins[(i + 35) % 36].w + bins[(i + 1) % 36].w) }))
    .filter((x) => x.bin.w > 0)
    .sort((x, y) => y.score - x.score);
  return rgbToHex(bin.r / bin.w, bin.g / bin.w, bin.b / bin.w);
}

/** Lightens `hex` until it stands out on the background, and picks the text color for it. */
export function readableAccent(hex, bg = BG) {
  const [h, s, start] = rgbToHsl(...hexToRgb(hex));
  let l = start;
  let color = hex.toLowerCase();
  const inkContrast = () => Math.max(contrast(color, DARK_INK), contrast(color, LIGHT_INK));
  // Bright mid-tones (a pure red) read poorly with both white and dark text on them, so they lift too.
  for (let i = 0; i < 50 && (contrast(color, bg) < MIN_UI_CONTRAST || inkContrast() < MIN_TEXT_CONTRAST) && l < 0.97; i++) {
    l = Math.min(0.97, l + 0.02);
    color = rgbToHex(...hslToRgb(h, s, l));
  }
  const ink = contrast(color, DARK_INK) >= contrast(color, LIGHT_INK) ? DARK_INK : LIGHT_INK;
  return { color, ink };
}

const hsl = (h, s, l) => rgbToHex(...hslToRgb(h, s, l));

function readableText(hex, bg) {
  const [h, s, start] = rgbToHsl(...hexToRgb(hex));
  let color = hex;
  for (let l = start; contrast(color, bg) < MIN_TEXT_CONTRAST && l < 0.97; l += 0.02) color = hsl(h, s, l);
  return color;
}

/**
 * The whole page in the logo's color: dark surfaces tinted strongly with its hue, text with a
 * hint of it, and the color itself on the actions. Stays dark so the green "ready" screen and
 * the order number keep standing out. Greys stay truly neutral.
 */
export function brandTheme(hex) {
  const [h, s] = rgbToHsl(...hexToRgb(hex));
  // Dark oranges and yellows turn to chocolate at full strength, so they stay a warm charcoal.
  const strongest = h >= 15 && h <= 65 ? 0.3 : 0.62;
  const tint = s < 0.1 ? 0 : Math.min(strongest, Math.max(0.3, s * 0.75));
  const bg = hsl(h, tint, 0.105);
  const surface = hsl(h, tint, 0.155);
  const surface2 = hsl(h, tint, 0.205);
  const textTint = Math.min(tint, 0.3);
  const text = hsl(h, textTint, 0.94);
  const [tr, tg, tb] = hexToRgb(text);
  const accent = readableAccent(hex, surface2);
  // On a red page the usual red for "cancel" would disappear: it lifts until it reads.
  const danger = readableText(DANGER, surface2);
  return {
    '--bg': bg,
    '--surface': surface,
    '--surface-2': surface2,
    '--line': `rgb(${tr} ${tg} ${tb} / 0.1)`,
    '--line-strong': `rgb(${tr} ${tg} ${tb} / 0.2)`,
    '--text': text,
    '--muted': hsl(h, textTint, 0.74),
    '--accent': accent.color,
    '--on-accent': accent.ink,
    '--danger': danger,
    '--on-danger': contrast(danger, LIGHT_INK) >= contrast(danger, DARK_INK) ? LIGHT_INK : DARK_INK,
  };
}

const THEME_TOKENS = [
  '--bg', '--surface', '--surface-2', '--line', '--line-strong', '--text', '--muted', '--accent', '--on-accent', '--danger', '--on-danger',
];

/** Paints a page with brandTheme() tokens (usually on document.documentElement); null restores the default. */
export function applyTheme(el, theme) {
  if (!el) return;
  for (const token of THEME_TOKENS) {
    if (theme) el.style.setProperty(token, theme[token]);
    else el.style.removeProperty(token);
  }
  const meta = el.ownerDocument?.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme?.['--bg'] ?? BG;
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

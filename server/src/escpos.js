import QRCode from 'qrcode';

// ESC/POS bytes the receipt printer agent adds at the end of a receipt: the order's QR as a
// raster image (GS v 0 prints on every ESC/POS printer, old ones without a QR command too),
// centered, with an optional big line above it.

const ESC = 0x1b;
const GS = 0x1d;
// Narrow enough for a 58 mm printer (384 dots); 80 mm ones are 576.
const MAX_DOTS = 360;
const QUIET = 2;

function raster(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cells = n + QUIET * 2;
  const dot = Math.max(3, Math.min(8, Math.floor(MAX_DOTS / cells)));
  const size = cells * dot;
  const rowBytes = Math.ceil(size / 8);
  const bits = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const my = Math.floor(y / dot) - QUIET;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / dot) - QUIET;
      if (mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.data[my * n + mx]) {
        bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  const head = Buffer.from([GS, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, size & 0xff, size >> 8]);
  return Buffer.concat([head, bits]);
}

/** The block added before the paper cut: [big title], the QR, a caption, some feed. */
export function qrBlock(url, { title = null, caption = 'Scan to follow your order' } = {}) {
  const ascii = (s) => Buffer.from(String(s).replace(/[^\x20-\x7e]/g, ''), 'latin1');
  return Buffer.concat([
    Buffer.from([0x0a, ESC, 0x61, 0x01]), // new line, centered
    ...(title ? [Buffer.from([GS, 0x21, 0x11]), ascii(title), Buffer.from([0x0a, GS, 0x21, 0x00])] : []),
    raster(url),
    Buffer.from([0x0a]),
    ascii(caption),
    Buffer.from([0x0a, 0x0a, 0x0a, ESC, 0x61, 0x00]), // feed, back to the left
  ]);
}

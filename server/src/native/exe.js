import { writeZip } from './zip.js';

// The Windows app (apps/windows) reserves a fixed 1 KB region that starts with MARKER and is
// filled with spaces. The brand's config JSON goes there in place, so the file keeps its size.

export const MARKER = Buffer.from('PAGER_APP_CONFIG_V1:', 'ascii');
const REGION = 1024;

export function patchExeConfig(exe, config) {
  const at = exe.indexOf(MARKER);
  if (at < 0 || exe.indexOf(MARKER, at + 1) >= 0) throw new Error('config region not found exactly once');
  const json = Buffer.from(JSON.stringify(config), 'utf8');
  const room = REGION - MARKER.length;
  if (json.length > room) throw new Error('config too long');
  const out = Buffer.from(exe);
  out.fill(0x20, at + MARKER.length, at + REGION);
  json.copy(out, at + MARKER.length);
  return out;
}

/** What the brand gets: a zip with the single exe in it (works even if run from inside the zip). */
export function zipExe(fileName, exe) {
  return writeZip([{ name: fileName, data: exe, method: 8, externalAttrs: 0x20 }]);
}

/** .ico with one PNG image (Windows Vista and later read PNG icons). */
export function pngToIco(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(1, 4); // one image
  head[6] = width >= 256 ? 0 : width;
  head[7] = height >= 256 ? 0 : height;
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

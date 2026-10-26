import crypto from 'node:crypto';
import { findEocd, readZip, writeZip } from './zip.js';

// Turns the generic cashier template (apps/android) into one brand's app:
//   - the launcher label (placeholder string in resources.arsc) becomes the brand name,
//   - the icon PNGs become the brand icon,
//   - assets/pager.json tells the app its server, brand and app key,
// then signs it with APK Signature Scheme v2 (Android 7.0+, which is the app's minSdk).

export const LABEL_PLACEHOLDER = 'PAGER_APP_LABEL';
const ICON_RE = /^res\/(drawable|mipmap)[^/]*\/(app_icon|ic_launcher)\.png$/;

// ---------------------------------------------------------------------------
// resources.arsc: rewrite the global string pool with the placeholder replaced
// ---------------------------------------------------------------------------

const RES_TABLE = 0x0002;
const RES_STRING_POOL = 0x0001;
const UTF8 = 1 << 8;
const SORTED = 1 << 0;

function readLen8(buf, p) {
  const a = buf[p];
  return a & 0x80 ? [((a & 0x7f) << 8) | buf[p + 1], 2] : [a, 1];
}

function readLen16(buf, p) {
  const a = buf.readUInt16LE(p);
  return a & 0x8000 ? [((a & 0x7fff) << 16) | buf.readUInt16LE(p + 2), 4] : [a, 2];
}

function len8(n) {
  if (n > 0x7fff) throw new Error('string too long');
  return n > 0x7f ? Buffer.from([0x80 | (n >> 8), n & 0xff]) : Buffer.from([n]);
}

function len16(n) {
  if (n > 0x7fff) throw new Error('string too long');
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function decodePool(pool) {
  const headerSize = pool.readUInt16LE(2);
  const count = pool.readUInt32LE(8);
  const styleCount = pool.readUInt32LE(12);
  const flags = pool.readUInt32LE(16);
  const stringsStart = pool.readUInt32LE(20);
  const stylesStart = pool.readUInt32LE(24);
  const utf8 = Boolean(flags & UTF8);
  const strings = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + pool.readUInt32LE(headerSize + i * 4);
    if (utf8) {
      p += readLen8(pool, p)[1]; // UTF-16 length, recomputed on encode
      const [bytes, n] = readLen8(pool, p);
      p += n;
      strings.push(pool.toString('utf8', p, p + bytes));
    } else {
      const [chars, n] = readLen16(pool, p);
      p += n;
      strings.push(pool.toString('utf16le', p, p + chars * 2));
    }
  }
  const styleOffsets = pool.subarray(headerSize + count * 4, headerSize + count * 4 + styleCount * 4);
  const styles = styleCount ? pool.subarray(stylesStart) : Buffer.alloc(0);
  return { headerSize, flags, utf8, strings, styleCount, styleOffsets, styles };
}

function encodeString(s, utf8) {
  if (utf8) {
    const bytes = Buffer.from(s, 'utf8');
    return Buffer.concat([len8(s.length), len8(bytes.length), bytes, Buffer.from([0])]);
  }
  return Buffer.concat([len16(s.length), Buffer.from(s, 'utf16le'), Buffer.alloc(2)]);
}

const pad4 = (buf) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf);

function encodePool(p) {
  const encoded = p.strings.map((s) => encodeString(s, p.utf8));
  const offsets = Buffer.alloc(encoded.length * 4);
  let at = 0;
  encoded.forEach((e, i) => {
    offsets.writeUInt32LE(at, i * 4);
    at += e.length;
  });
  const data = pad4(Buffer.concat(encoded));
  const stringsStart = p.headerSize + offsets.length + p.styleOffsets.length;
  const stylesStart = p.styleCount ? stringsStart + data.length : 0;
  const header = Buffer.alloc(p.headerSize);
  const size = stringsStart + data.length + p.styles.length;
  header.writeUInt16LE(RES_STRING_POOL, 0);
  header.writeUInt16LE(p.headerSize, 2);
  header.writeUInt32LE(size, 4);
  header.writeUInt32LE(p.strings.length, 8);
  header.writeUInt32LE(p.styleCount, 12);
  header.writeUInt32LE(p.flags & ~SORTED, 16);
  header.writeUInt32LE(stringsStart, 20);
  header.writeUInt32LE(stylesStart, 24);
  return Buffer.concat([header, offsets, p.styleOffsets, data, p.styles]);
}

/** resources.arsc with `from` replaced by `to` in the global string pool. */
export function replaceArscString(arsc, from, to) {
  if (arsc.readUInt16LE(0) !== RES_TABLE) throw new Error('not a resource table');
  const tableHeader = arsc.readUInt16LE(2);
  const poolSize = arsc.readUInt32LE(tableHeader + 4);
  if (arsc.readUInt16LE(tableHeader) !== RES_STRING_POOL) throw new Error('no global string pool');
  const pool = decodePool(arsc.subarray(tableHeader, tableHeader + poolSize));
  const i = pool.strings.indexOf(from);
  if (i < 0) throw new Error(`"${from}" not found in resources.arsc`);
  pool.strings[i] = to;
  const head = Buffer.from(arsc.subarray(0, tableHeader));
  const rest = arsc.subarray(tableHeader + poolSize);
  const newPool = encodePool(pool);
  head.writeUInt32LE(head.length + newPool.length + rest.length, 4);
  return Buffer.concat([head, newPool, rest]);
}

/** Strings of the global pool (tests and diagnostics). */
export function arscStrings(arsc) {
  const tableHeader = arsc.readUInt16LE(2);
  return decodePool(arsc.subarray(tableHeader, tableHeader + arsc.readUInt32LE(tableHeader + 4))).strings;
}

// ---------------------------------------------------------------------------
// APK Signature Scheme v2
// https://source.android.com/docs/security/features/apksigning/v2
// ---------------------------------------------------------------------------

const V2_BLOCK_ID = 0x7109871a;
const RSA_PKCS1_SHA256 = 0x0103;
const CHUNK = 1024 * 1024;
const MAGIC = Buffer.from('APK Sig Block 42', 'ascii');

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const lp = (buf) => Buffer.concat([u32(buf.length), buf]);
const lpSeq = (items) => lp(Buffer.concat(items.map(lp)));

function chunkedSha256(sections) {
  const digests = [];
  for (const section of sections) {
    for (let at = 0; at < section.length; at += CHUNK) {
      const chunk = section.subarray(at, Math.min(section.length, at + CHUNK));
      digests.push(crypto.createHash('sha256').update(Buffer.from([0xa5])).update(u32(chunk.length)).update(chunk).digest());
    }
  }
  return crypto.createHash('sha256').update(Buffer.from([0x5a])).update(u32(digests.length)).update(Buffer.concat(digests)).digest();
}

/** Signs an unsigned zip (EOCD without comment) and returns the signed apk. */
export function signV2(zip, { privateKey, certDer }) {
  const eocd = findEocd(zip);
  const entries = zip.subarray(0, eocd.cdOffset);
  const cd = zip.subarray(eocd.cdOffset, eocd.offset);
  const end = Buffer.from(zip.subarray(eocd.offset));
  // The EOCD's "central directory offset" is digested as the signing block's offset,
  // which is where the central directory is right now.
  const digest = chunkedSha256([entries, cd, end]);

  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const signedData = Buffer.concat([
    lpSeq([Buffer.concat([u32(RSA_PKCS1_SHA256), lp(digest)])]),
    lpSeq([certDer]),
    lp(Buffer.alloc(0)),
  ]);
  const signature = crypto.sign('sha256', signedData, privateKey);
  const signer = Buffer.concat([lp(signedData), lpSeq([Buffer.concat([u32(RSA_PKCS1_SHA256), lp(signature)])]), lp(publicKey)]);
  const value = lpSeq([signer]);

  const pair = Buffer.concat([u64(4 + value.length), u32(V2_BLOCK_ID), value]);
  const blockSize = pair.length + 8 + MAGIC.length;
  const block = Buffer.concat([u64(blockSize), pair, u64(blockSize), MAGIC]);

  end.writeUInt32LE(eocd.cdOffset + block.length, 16);
  return Buffer.concat([entries, block, cd, end]);
}

// ---------------------------------------------------------------------------

/**
 * template: unsigned apk from apps/android/build.sh
 * icon: square PNG, or null to keep the template's icon
 * config: { server, brand, key } written to assets/pager.json
 */
export function buildApk(template, { label, icon, config, privateKey, certDer }) {
  const entries = [];
  for (const e of readZip(template)) {
    if (e.name.startsWith('META-INF/')) continue;
    if (e.name === 'resources.arsc') {
      entries.push({ name: e.name, data: replaceArscString(e.data, LABEL_PLACEHOLDER, label), method: 0 });
    } else if (icon && ICON_RE.test(e.name)) {
      entries.push({ name: e.name, data: icon, method: 0 });
    } else {
      entries.push({ name: e.name, data: e.data, method: e.method });
    }
  }
  entries.push({ name: 'assets/pager.json', data: Buffer.from(JSON.stringify(config)), method: 8 });
  return signV2(writeZip(entries), { privateKey, certDer });
}

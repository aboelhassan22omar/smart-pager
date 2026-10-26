import zlib from 'node:zlib';

// Just enough ZIP for the app packages: read an archive (no ZIP64, no encryption) and write one
// with stored entries aligned the way zipalign does it (Android maps resources.arsc and PNGs
// straight from the file). Timestamps are fixed so the same input always gives the same bytes.

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01
const ALIGN_EXTRA_ID = 0xd935; // Android's zipalign extra field

export function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      return {
        offset: i,
        entries: buf.readUInt16LE(i + 10),
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16),
      };
    }
  }
  throw new Error('not a zip file');
}

/** Entries in archive order: { name, method, data } with `data` already uncompressed. */
export function readZip(buf) {
  const { entries, cdOffset } = findEocd(buf);
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOffset) !== LOCAL) throw new Error(`bad local header for ${name}`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compSize);
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression for ${name}`);
    out.push({ name, method, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
  }
  return out;
}

/**
 * entries: [{ name, data, method: 0 | 8, align? }] -> zip Buffer.
 * Stored entries get their data aligned to `align` (default 4) with a padding extra field.
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.data);
    const body = e.method === 8 ? zlib.deflateRawSync(e.data, { level: 9 }) : e.data;
    let extra = Buffer.alloc(0);
    if (e.method === 0) {
      const align = e.align ?? 4;
      // data starts after the 30-byte header, the name and this extra field (6 bytes + padding)
      const pad = (align - ((offset + 30 + name.length + 6) % align)) % align;
      extra = Buffer.alloc(6 + pad);
      extra.writeUInt16LE(ALIGN_EXTRA_ID, 0);
      extra.writeUInt16LE(2 + pad, 2);
      extra.writeUInt16LE(align, 4);
    }
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0);
    head.writeUInt16LE(e.method === 8 ? 20 : 10, 4);
    head.writeUInt16LE(UTF8_FLAG, 6);
    head.writeUInt16LE(e.method, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(extra.length, 28);
    locals.push(head, name, extra, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(e.method === 8 ? 20 : 10, 6);
    cd.writeUInt16LE(UTF8_FLAG, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(e.externalAttrs ?? 0, 38);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);

    offset += 30 + name.length + extra.length + body.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

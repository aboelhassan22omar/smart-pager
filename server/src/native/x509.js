import crypto from 'node:crypto';

// A self-signed X.509 certificate in DER, built by hand (Node can parse certificates but not
// create them). Android only uses it to carry the public key of the app signer.

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const NULL = Buffer.from([0x05, 0x00]);

function integer(buf) {
  let b = buf;
  while (b.length > 1 && b[0] === 0 && b[1] < 0x80) b = b.subarray(1);
  if (b[0] >= 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

// UTCTime up to 2049, GeneralizedTime from 2050 (RFC 5280 4.1.2.5).
function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), NULL);

export function selfSignedCert({ privateKey, publicKey, commonName, years = 50 }) {
  const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
  const notBefore = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const notAfter = new Date(Date.UTC(notBefore.getUTCFullYear() + years, 0, 1));
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(crypto.randomBytes(16)),
    SHA256_RSA,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  return seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

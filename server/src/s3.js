// Minimal S3 client for off-site backups: AWS Signature Version 4, path-style PUT only.
// In-house on purpose (no SDK): https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html

import crypto from 'node:crypto';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone).
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** 20150830T123600Z */
export const amzDate = (date) => date.toISOString().replace(/[:-]|\.\d{3}/g, '');

/**
 * Signs one request. `headers` must already hold every header to sign (host, x-amz-date,
 * x-amz-content-sha256 for S3, ...). Returns the Authorization header value.
 */
export function signV4({ method, path, query = '', headers, payloadHash, region, service, accessKeyId, secretAccessKey }) {
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const signedHeaders = names.join(';');
  const canonicalQuery = query
    ? query.split('&').map((p) => p.split('=').map((x) => uriEncode(decodeURIComponent(x ?? ''))))
      .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
      .map(([k, v = '']) => `${k}=${v}`).join('&')
    : '';
  const canonical = [
    method,
    path,
    canonicalQuery,
    names.map((n) => `${n}:${lower[n]}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');

  const date = lower['x-amz-date'];
  const scope = `${date.slice(0, 8)}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  let key = hmac(`AWS4${secretAccessKey}`, date.slice(0, 8));
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** Object key -> URL path (each segment encoded, slashes kept). */
export const objectPath = (bucket, key) => `/${[bucket, ...key.split('/')].map(uriEncode).join('/')}`;

/** PUT one object, path-style (`<endpoint>/<bucket>/<key>`): works with AWS, R2, MinIO, B2. */
export async function putObject(s3, key, body, { now = new Date(), fetchImpl = fetch } = {}) {
  const endpoint = new URL(s3.endpoint);
  const path = `${endpoint.pathname.replace(/\/+$/, '')}${objectPath(s3.bucket, key)}`;
  const payloadHash = sha256(body);
  const headers = { host: endpoint.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(now) };
  const authorization = signV4({ method: 'PUT', path, headers, payloadHash, region: s3.region, service: 's3', ...s3 });
  const res = await fetchImpl(`${endpoint.origin}${path}`, {
    method: 'PUT',
    headers: { ...headers, authorization, 'content-length': String(body.length) },
    body,
  });
  if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

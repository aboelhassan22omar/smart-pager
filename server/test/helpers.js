import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
export const ADMIN_TOKEN = 'test-admin-token';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Spawns the real server on a temp DATA_DIR (or a pre-seeded one) and waits for /health.
// With `expectExit`, waits for the process to exit instead and resolves {code, output}.
export async function startServer(env = {}, { dataDir: seeded, expectExit = false } = {}) {
  const dataDir = seeded ?? fs.mkdtempSync(path.join(os.tmpdir(), 'smart-pager-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_URL: url,
      LOG_LEVEL: 'warn',
      ADMIN_TOKEN,
      PUSH_ENDPOINT_HOSTS: 'push.test.invalid',
      APPLE_TEAM_ID: '',
      APPLE_APP_ID: '',
      APNS_KEY_ID: '',
      APNS_KEY_PATH: '',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      COOKIE_SECRET: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));

  if (expectExit) {
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve('timeout');
      }, 15_000);
      proc.once('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    return { code, output, dataDir };
  }

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    url,
    dataDir,
    output: () => output,
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill('SIGTERM');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

const randomIp = () => `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;

// fetch wrapper with a cookie jar. Every request gets a random client IP
// (via X-Forwarded-For from loopback) unless `ip` is given, so rate limits stay out of the way.
export function client(base) {
  const jar = new Map();

  async function request(method, pathname, { json, body, headers = {}, ip } = {}) {
    const h = { 'x-forwarded-for': ip ?? randomIp(), ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch(base + pathname, { method, headers: h, body: payload });
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  return {
    jar,
    request,
    get: (p, opts) => request('GET', p, opts),
    post: (p, json = {}, opts = {}) => request('POST', p, { ...opts, json }),
    del: (p, opts) => request('DELETE', p, opts),
  };
}

// Minimal SSE reader on top of fetch.
export async function sse(url, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const queue = [];
  const waiters = [];

  const deliver = () => {
    for (let w = 0; w < waiters.length; w++) {
      const idx = queue.findIndex(waiters[w].match);
      if (idx >= 0) {
        const [ev] = queue.splice(idx, 1);
        const [waiter] = waiters.splice(w, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(ev);
        w--;
      }
    }
  };

  if (res.ok) {
    (async () => {
      let buf = '';
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = 'message';
            const data = [];
            for (const line of raw.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data.push(line.slice(6));
            }
            if (data.length) queue.push({ event, data: JSON.parse(data.join('\n')) });
          }
          deliver();
        }
      } catch {
        /* aborted */
      }
    })();
  }

  return {
    status: res.status,
    next(event, predicate = () => true, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const waiter = {
          match: (ev) => ev.event === event && predicate(ev.data),
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`timed out waiting for SSE "${event}"`));
          }, timeoutMs),
        };
        waiters.push(waiter);
        deliver();
      });
    },
    close: () => ctrl.abort(),
  };
}

// Declares `declaredLength` bytes but only sends `head`, then waits for the server to
// answer from the Content-Length alone (e.g. 413). Streaming the full body would race
// the server closing the socket and can stall the client.
export function earlyRejectPost(url, declaredLength, head, headers, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { ...headers, 'content-length': declaredLength } }, (res) => {
      res.resume();
      resolve(res.statusCode);
      req.destroy();
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`no response within ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      if (!['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code)) reject(err);
    });
    req.write(head);
  });
}

export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

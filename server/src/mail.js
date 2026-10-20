// Minimal SMTP client (no dependency) for the optional weekly owner summary.
// Off unless SMTP_HOST is set. Modes: implicit TLS (465), STARTTLS (587), none (local dev).

import net from 'node:net';
import tls from 'node:tls';
import { randomId } from './util.js';

const TIMEOUT_MS = 20_000;
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
const addressOf = (s) => (clean(s).match(/<([^>]+)>/)?.[1] ?? clean(s));
const encodeHeader = (s) => `=?UTF-8?B?${Buffer.from(clean(s)).toString('base64')}?=`;

function reader(socket) {
  let buf = '';
  let lines = [];
  const waiting = [];
  const responses = [];
  const deliver = () => {
    while (responses.length && waiting.length) waiting.shift().resolve(responses.shift());
  };
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        responses.push({ code: Number(line.slice(0, 3)), lines });
        lines = [];
      }
    }
    deliver();
  };
  const onError = (err) => {
    while (waiting.length) waiting.shift().reject(err);
  };
  socket.on('data', onData);
  socket.on('error', onError);
  return {
    next: () => new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      deliver();
    }),
    detach: () => {
      socket.off('data', onData);
      socket.off('error', onError);
    },
  };
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const opts = { host: cfg.host, port: cfg.port };
    const socket = cfg.tls === 'implicit'
      ? tls.connect({ ...opts, servername: cfg.host }, () => resolve(socket))
      : net.connect(opts, () => resolve(socket));
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('SMTP timeout')));
    socket.once('error', reject);
  });
}

export function buildMessage({ from, to, subject, text, date = new Date() }) {
  const body = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${clean(from)}`,
    `To: ${to.map(clean).join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomId(12)}@smart-pager>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** Sends one plain-text UTF-8 message. Throws on any non-success SMTP reply. */
export async function sendMail(cfg, { to, subject, text }) {
  let socket = await connect(cfg);
  let rd = reader(socket);
  const expect = async (...codes) => {
    const res = await rd.next();
    if (!codes.includes(res.code)) throw new Error(`SMTP ${res.code}: ${res.lines.join(' | ')}`);
    return res;
  };
  const say = (line) => socket.write(`${line}\r\n`);
  try {
    await expect(220);
    say('EHLO smart-pager');
    await expect(250);
    if (cfg.tls === 'starttls') {
      say('STARTTLS');
      await expect(220);
      rd.detach();
      socket = await new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: cfg.host }, () => resolve(secure));
        secure.once('error', reject);
      });
      rd = reader(socket);
      say('EHLO smart-pager');
      await expect(250);
    }
    if (cfg.user) {
      say(`AUTH PLAIN ${Buffer.from(`\u0000${cfg.user}\u0000${cfg.pass}`).toString('base64')}`);
      await expect(235);
    }
    say(`MAIL FROM:<${addressOf(cfg.from)}>`);
    await expect(250);
    for (const rcpt of to) {
      say(`RCPT TO:<${addressOf(rcpt)}>`);
      await expect(250, 251);
    }
    say('DATA');
    await expect(354);
    const data = buildMessage({ from: cfg.from, to, subject, text }).replace(/^\./gm, '..'); // dot-stuffing
    socket.write(`${data}\r\n.\r\n`);
    await expect(250);
    say('QUIT');
    await expect(221).catch(() => {}); // the message is already accepted; a missing bye is harmless
  } finally {
    socket.end();
  }
}

export function smtpConfig(config) {
  return config.smtp.host ? config.smtp : null;
}

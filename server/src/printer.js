import fs from 'node:fs';
import { HttpError } from './errors.js';

// The receipt printer agent: a small Windows program on the cashier PC that sits between the
// POS and its receipt printer. Every receipt the POS prints passes through it; it asks the
// server for that order's QR and adds it before the paper cut. The scripts are in
// native/printer/; this file holds the branch's settings and what the server does per receipt.
//
// Each printed receipt is an order: the one with the receipt's number when the receipt's text
// can be read (and an open order with that number joins it), else the next number, printed big
// above the QR. Reports (Z / X / shift) are left alone.

const SCRIPTS = new URL('./native/printer/', import.meta.url);
const script = (name) => fs.readFileSync(new URL(name, SCRIPTS), 'utf8');

const PATTERN_MAX = 200;
const PRINTER_MAX = 120;

// Read from a receipt's text. A keyword before the number: random bytes of a printed image
// never spell one, so a receipt printed as a picture gives no false number.
const NUMBER_PATTERNS = [
  /(?:order|invoice|receipt|bill|check|cheque|ticket|trans(?:action)?)\s*(?:no\.?|num(?:ber)?\.?|#)?\s*[:#.-]?\s*(\d{1,6})\b/i,
  /(?:رقم\s*(?:الفاتورة|الفاتوره|الطلب|الأوردر|الاوردر|الشيك|الإيصال|الايصال)|(?:فاتورة|فاتوره|طلب|أوردر|اوردر|إيصال|ايصال)\s*رقم)\s*[:#.-]?\s*(\d{1,6})/,
];
const SKIP_DEFAULT = /\b(?:z|x)[\s-]*report\b|shift\s*(?:report|close)|end\s*of\s*day|تقرير|إغلاق|اغلاق|وردية|تقفيل/i;

// A void / cancel / refund slip for a receipt already printed. Strict on purpose: footers like
// "no refunds" or "لا يرد ولا يستبدل" are on ordinary receipts.
const CANCEL_DEFAULT = /\b(?:void(?:ed)?|cancell?ed)\b|\brefund\s*(?:receipt|invoice|slip|bill)\b|(?:فاتورة|فاتوره)\s*(?:مرتجع|ملغ)|مرتجع\s*(?:مبيعات|فاتورة|فاتوره)|(?:^|\s)ملغ(?:ي|ى|اة|اه)(?:\s|$)/i;

const latinDigits = (s) => s.replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 0xf));

function userRegex(source, field) {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    throw new HttpError(400, 'النمط ده مش مظبوط', { field });
  }
}

/** The branch's printer settings, or null when the agent is off for it. */
export function printerConfig(shop) {
  if (!shop?.print_agent) return null;
  try {
    return JSON.parse(shop.print_agent);
  } catch {
    return null;
  }
}

/** The super's form -> the stored settings (null: off). */
export function cleanPrinterConfig(body) {
  if (body?.enabled === false) return null;
  const text = (key, max) => (typeof body?.[key] === 'string' ? body[key].trim().slice(0, max) : '');
  const config = {
    pattern: text('pattern', PATTERN_MAX) || null,
    skip: text('skip', PATTERN_MAX) || null,
    cancel: text('cancel', PATTERN_MAX) || null,
    printer: text('printer', PRINTER_MAX) || null,
  };
  for (const field of ['pattern', 'skip', 'cancel']) userRegex(config[field], field);
  return config;
}

/** The receipt's number in its text, or null. */
export function findNumber(text, config) {
  const plain = latinDigits(text);
  const own = userRegex(config?.pattern, 'pattern');
  for (const re of own ? [own] : NUMBER_PATTERNS) {
    const m = plain.match(re);
    const digits = m && (m[1] ?? m[0]).match(/\d+/)?.[0];
    if (digits && Number(digits) > 0) return digits;
  }
  return null;
}

/** A slip that cancels a receipt printed before. */
export function isCancel(text, config) {
  return (userRegex(config?.cancel, 'cancel') ?? CANCEL_DEFAULT).test(text);
}

/** A report or anything else that isn't a customer's receipt. */
export function isSkipped(text, config) {
  return (userRegex(config?.skip, 'skip') ?? SKIP_DEFAULT).test(text);
}

const psQuote = (s) => String(s ?? '').replace(/'/g, "''");

/** The installer, ready to run on the branch's PC (it asks for admin by itself). */
export function installScript({ server, branch, token, printer }) {
  return script('install.ps1')
    .replace("'__SERVER__'", `'${psQuote(server)}'`)
    .replace("'__BRANCH__'", `'${psQuote(branch)}'`)
    .replace("'__TOKEN__'", `'${psQuote(token)}'`)
    .replace("'__PRINTER__'", `'${psQuote(printer)}'`);
}

export function removeScript({ server, branch, token }) {
  return script('remove.ps1')
    .replace("'__SELF__'", `'${psQuote(`${server}/api/pos/${branch}/${token}/printer-remove.ps1`)}'`);
}

export const agentScript = () => script('agent.ps1');

/** What the super copies and runs (or sends) for a branch. */
export function printerCommands({ server, branch, token }) {
  const run = (file) => `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm '${server}/api/pos/${branch}/${token}/${file}' | iex"`;
  return { install: run('printer.ps1'), remove: run('printer-remove.ps1') };
}

// Reads an order out of whatever a POS system posts to a branch's link. Systems name their
// fields differently (Foodics `number` + `type`, Loyverse `receipts[].receipt_number` +
// `dining_option`, ...), so this looks for the usual names instead of one fixed format.

const norm = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

// In order of preference: a customer-facing number beats a long internal reference.
const NUMBER_KEYS = [
  'ordernumber', 'orderno', 'ordernum', 'number', 'num', 'receiptnumber', 'receiptno', 'ticketnumber', 'ticketno',
  'trackingnumber', 'displaynumber', 'checknumber', 'checkno', 'billnumber', 'billno', 'invoicenumber', 'invoiceno',
  'posreference', 'reference', 'ref',
];
const TYPE_KEYS = [
  'ordertype', 'type', 'servicetype', 'diningoption', 'diningmode', 'fulfillmenttype', 'fulfilmenttype', 'deliverytype',
  'orderchannel', 'channel', 'ordersource', 'source', 'mode',
];
const STATE_KEYS = ['status', 'state', 'orderstatus', 'action', 'event', 'receipttype'];
const CANCEL_STAMP_KEYS = ['cancelledat', 'canceledat', 'voidedat', 'deletedat'];
// Branches of a payload that hold other things' numbers.
const SKIP_KEYS = new Set([
  'customer', 'client', 'user', 'employee', 'cashier', 'driver', 'address', 'business', 'merchant', 'store', 'branch', 'device',
  'items', 'lineitems', 'lines', 'products', 'payments', 'taxes', 'discounts', 'modifiers', 'combos', 'charges', 'tips',
]);

const DELIVERY_RE = /deliver|ديليفر|دليفر|توصيل|talabat|طلبات|elmenus|مرسول|mrsool|jahez|جاهز/i;
const CANCEL_RE = /cancel|void|refund|return|delete|ملغ|إلغاء|الغاء|مرتجع/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
export const MAX_POS_NUMBER = 9999;
const MAX_ORDERS_PER_CALL = 20;
const MAX_DEPTH = 5;

/** "1-1001" -> 1001, "INV-0045" -> 45, 77 -> 77. Numbers past 9999 keep their last 4 digits. */
export function parseNumber(value) {
  let digits;
  if (typeof value === 'number') digits = Number.isInteger(value) ? String(value) : null;
  else if (typeof value === 'string' && !UUID_RE.test(value.trim())) digits = value.trim().match(/(\d+)\D*$/)?.[1];
  if (!digits || digits.length > 18) return null;
  const n = Number(digits.slice(-4));
  return n > 0 && n <= MAX_POS_NUMBER ? n : null;
}

function fieldsOf(obj) {
  const fields = new Map();
  for (const [key, value] of Object.entries(obj)) fields.set(norm(key), value);
  return fields;
}

function numberOf(fields) {
  for (const key of NUMBER_KEYS) {
    const n = fields.has(key) ? parseNumber(fields.get(key)) : null;
    if (n) return n;
  }
  return null;
}

function isDelivery(fields, deliveryCode) {
  if (fields.get('isdelivery') === true) return true;
  for (const key of TYPE_KEYS) {
    const value = fields.get(key);
    if (typeof value === 'string' && DELIVERY_RE.test(value)) return true;
    // Numeric codes differ per system, so a code only counts when the link names it (&delivery=3).
    if (deliveryCode != null && value != null && String(value) === String(deliveryCode)) return true;
  }
  return false;
}

function isCancelled(fields) {
  if (CANCEL_STAMP_KEYS.some((key) => fields.get(key))) return true;
  return STATE_KEYS.some((key) => typeof fields.get(key) === 'string' && CANCEL_RE.test(fields.get(key)));
}

function findOrders(node, depth = 0) {
  if (depth > MAX_DEPTH || node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((item) => findOrders(item, depth + 1));
  if (numberOf(fieldsOf(node))) return [node];
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(norm(key))) continue;
    const found = findOrders(value, depth + 1);
    if (found.length) return found;
  }
  return [];
}

/** [{ number, delivery, cancelled }] for each order found in the payload. */
export function readOrders(payload, { deliveryCode = null } = {}) {
  return findOrders(payload).slice(0, MAX_ORDERS_PER_CALL).map((obj) => {
    const fields = fieldsOf(obj);
    return { number: numberOf(fields), delivery: isDelivery(fields, deliveryCode), cancelled: isCancelled(fields) };
  });
}

/** Field names only, never values: payloads can carry customer names and phones. */
export function payloadKeys(payload) {
  const obj = Array.isArray(payload) ? payload[0] : payload;
  if (obj == null || typeof obj !== 'object') return [];
  return Object.keys(obj).slice(0, 15).map((key) => key.slice(0, 30));
}

export function parseBody(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: a form post (number=12&type=delivery).
    const form = Object.fromEntries(new URLSearchParams(text));
    return Object.keys(form).length ? form : null;
  }
}

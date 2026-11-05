import { EventEmitter } from 'node:events';

// Listeners get (event, data). Channel names always embed the branch, and are only ever
// built from a resolved branch context, so a stream cannot subscribe outside its branch.
export function createBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  return bus;
}

export const channels = (branchId) => ({
  order: (orderId) => `b:${branchId}:order:${orderId}`,
  bar: `b:${branchId}:bar`,
});

/**
 * Open bar/QR streams per branch: drives nonce rotation and the "connected screens" count
 * (split by page: the cashier board vs the QR screen). Streams from a linked cashier app also
 * count per device ("online now" on the dashboards). Customers following an order and open
 * demo pages are counted too, for the super's "live now" line.
 */
export function createScreens() {
  const counts = new Map();
  const kinds = new Map(); // branchId -> { bar, qr }
  const devices = new Map();
  const customers = new Map();
  const barClosedAt = new Map(); // branchId -> when its last cashier screen closed
  const startedAt = Date.now();
  let demoPages = 0;
  const bump = (map, key, by) => {
    const n = (map.get(key) ?? 0) + by;
    if (n > 0) map.set(key, n);
    else map.delete(key);
  };
  return {
    addDevice: (id) => bump(devices, id, 1),
    removeDevice: (id) => bump(devices, id, -1),
    deviceOnline: (id) => (devices.get(id) ?? 0) > 0,
    add(branchId, kind = 'bar') {
      bump(counts, branchId, 1);
      const k = kinds.get(branchId) ?? { bar: 0, qr: 0 };
      k[kind] += 1;
      kinds.set(branchId, k);
      if (kind === 'bar') barClosedAt.delete(branchId);
    },
    remove(branchId, kind = 'bar') {
      bump(counts, branchId, -1);
      const k = kinds.get(branchId);
      if (!k) return;
      k[kind] = Math.max(0, k[kind] - 1);
      if (kind === 'bar' && !k.bar) barClosedAt.set(branchId, Date.now());
      if (!k.bar && !k.qr) kinds.delete(branchId);
    },
    /** null while a cashier screen is open; else since when none is (server start at the latest). */
    barClosedSince: (branchId) => ((kinds.get(branchId)?.bar ?? 0) > 0 ? null : barClosedAt.get(branchId) ?? startedAt),
    count: (branchId) => counts.get(branchId) ?? 0,
    kinds: (branchId) => ({ bar: 0, qr: 0, ...kinds.get(branchId) }),
    branches: () => [...counts.keys()],
    addCustomer: (branchId) => bump(customers, branchId, 1),
    removeCustomer: (branchId) => bump(customers, branchId, -1),
    customers: (branchId) => customers.get(branchId) ?? 0,
    openDemo() {
      demoPages += 1;
    },
    closeDemo() {
      demoPages = Math.max(0, demoPages - 1);
    },
    demoPages: () => demoPages,
  };
}

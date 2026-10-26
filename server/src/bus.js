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
 * Open bar/QR streams per branch: drives nonce rotation and the "connected screens" count.
 * Streams from a linked cashier app also count per device ("online now" on the dashboards).
 */
export function createScreens() {
  const counts = new Map();
  const devices = new Map();
  return {
    addDevice(id) {
      devices.set(id, (devices.get(id) ?? 0) + 1);
    },
    removeDevice(id) {
      const n = (devices.get(id) ?? 1) - 1;
      if (n > 0) devices.set(id, n);
      else devices.delete(id);
    },
    deviceOnline: (id) => (devices.get(id) ?? 0) > 0,
    add(branchId) {
      counts.set(branchId, (counts.get(branchId) ?? 0) + 1);
    },
    remove(branchId) {
      const n = (counts.get(branchId) ?? 1) - 1;
      if (n > 0) counts.set(branchId, n);
      else counts.delete(branchId);
    },
    count: (branchId) => counts.get(branchId) ?? 0,
    branches: () => [...counts.keys()],
  };
}

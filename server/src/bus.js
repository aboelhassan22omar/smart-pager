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

/** Open bar/QR streams per branch: drives nonce rotation and the "connected screens" count. */
export function createScreens() {
  const counts = new Map();
  return {
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

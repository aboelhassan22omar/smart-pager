import { EventEmitter } from 'node:events';

// Channels: `order:<orderId>` (customer) and `shop:<shopId>` (bar). Listeners get (event, data).
export function createBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  return bus;
}

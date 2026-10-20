import webpush from 'web-push';
import { CLOSED_STATUSES } from '../store.js';
import { logoUrl, statusMessage } from '../views.js';
import { createApns } from './apns.js';

const DISMISS_AFTER_S = 15 * 60;

export function createNotifier({ store, config, log }) {
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  const apns = createApns(config.apple, log);

  function webPushPayload(order, shop, renotify) {
    return {
      orderId: order.id,
      shopId: shop.id,
      shopName: shop.name,
      number: order.number,
      status: order.status,
      message: statusMessage(order, shop),
      icon: logoUrl(shop),
      renotify,
    };
  }

  async function sendWebPush(sub, order, shop, renotify = false) {
    const payload = JSON.stringify(webPushPayload(order, shop, renotify));
    try {
      await webpush.sendNotification(sub.payload, payload, {
        TTL: 6 * 3600,
        urgency: order.status === 'ready' ? 'high' : 'normal',
        topic: order.id.slice(0, 32),
      });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        store.deleteSubscription(sub.id);
        log.info({ orderId: order.id }, 'web push subscription gone; removed');
      } else {
        log.warn({ orderId: order.id, status: err.statusCode, err: err.message }, 'web push failed');
      }
    }
  }

  function liveActivityPayload(order, shop) {
    const now = Math.floor(Date.now() / 1000);
    const closed = CLOSED_STATUSES.includes(order.status);
    const aps = {
      timestamp: now,
      event: closed ? 'end' : 'update',
      'content-state': {
        status: order.status,
        number: order.number,
        message: statusMessage(order, shop),
        shopName: shop.name,
      },
    };
    if (closed) aps['dismissal-date'] = now + DISMISS_AFTER_S;
    if (order.status === 'ready') {
      aps.alert = { title: `طلبك رقم ${order.number} جاهز`, body: shop.ready_message, sound: 'default' };
    }
    return { aps };
  }

  async function sendLiveActivity(sub, order, shop) {
    if (!apns) return;
    const bundle = sub.payload.app === 'app' ? config.apple.appBundleId : config.apple.clipBundleId;
    const res = await apns.send(sub.payload.token, {
      topic: `${bundle}.push-type.liveactivity`,
      payload: liveActivityPayload(order, shop),
    });
    if (res.status === 410 || res.reason === 'BadDeviceToken' || res.reason === 'Unregistered') {
      store.deleteSubscription(sub.id);
      log.info({ orderId: order.id, reason: res.reason }, 'live activity token gone; removed');
    } else if (res.status !== 200) {
      log.warn({ orderId: order.id, status: res.status, reason: res.reason }, 'APNs push failed');
    }
  }

  function dispatch(sub, order, shop, renotify) {
    const job = sub.kind === 'webpush'
      ? sendWebPush(sub, order, shop, renotify)
      : sendLiveActivity(sub, order, shop);
    job.catch((err) => log.error({ err }, 'notification dispatch crashed'));
  }

  return {
    apnsReady: Boolean(apns),
    orderChanged(order, shop, { renotify = false } = {}) {
      for (const sub of store.subscriptions(order.id)) dispatch(sub, order, shop, renotify);
    },
    // A new web push subscriber immediately gets the silent "preparing" notification
    // (or the ready one if it subscribed late).
    subscribed(sub, order, shop) {
      if (sub.kind === 'webpush') dispatch(sub, order, shop, false);
    },
    close() {
      apns?.close();
    },
  };
}

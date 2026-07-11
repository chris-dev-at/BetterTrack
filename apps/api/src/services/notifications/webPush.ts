import webpush from 'web-push';

import type { PushSubscriptionRepository } from '../../data/repositories/pushSubscriptionRepository';
import type { Logger } from '../../logger';

import type { PushMessage } from './fcm';

/**
 * Browser-push channel over the Web Push protocol with VAPID (#368/#350).
 * Encryption + VAPID signing come from the `web-push` library, wrapped behind a
 * minimal transport seam so tests inject a recording fake and never hit a push
 * service. Env-gated like SMTP: both VAPID keys set ⇒ channel on, otherwise
 * {@link createWebPushChannel} returns null and the matrix column reports
 * unavailable — nothing crashes (#350's SMTP-suppressed precedent).
 *
 * The payload mirrors the FCM data message: the canonical `type` + deep-link
 * ids + title/body, rendered by the SPA's service worker as an OS notification.
 */

/** The subset of `web-push` the channel consumes (test seam). */
export interface WebPushTransport {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ): Promise<unknown>;
}

export interface WebPushChannel {
  /** Send to every stored subscription of the user; prunes 404/410 endpoints. */
  deliver(userId: string, message: PushMessage): Promise<void>;
}

export interface CreateWebPushChannelDeps {
  /** From config.webPush; `enabled` false ⇒ channel off (null). */
  vapid: { enabled: boolean; publicKey?: string; privateKey?: string; subject: string };
  subscriptions: PushSubscriptionRepository;
  logger: Logger;
  /** Injectable transport (tests). Defaults to the real `web-push` module. */
  transport?: WebPushTransport;
}

/** Build the webpush channel, or null when VAPID is unconfigured. */
export function createWebPushChannel(deps: CreateWebPushChannelDeps): WebPushChannel | null {
  const { vapid, subscriptions, logger } = deps;
  if (!vapid.enabled || !vapid.publicKey || !vapid.privateKey) {
    logger.warn('webpush channel disabled: VAPID keys are not configured');
    return null;
  }
  const transport = deps.transport ?? (webpush as WebPushTransport);
  try {
    transport.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  } catch (err) {
    logger.warn({ err }, 'webpush channel disabled: VAPID configuration rejected');
    return null;
  }
  logger.info('webpush channel enabled (VAPID)');

  return {
    async deliver(userId, message): Promise<void> {
      const subs = await subscriptions.listForUser(userId);
      for (const sub of subs) {
        try {
          await transport.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({
              type: message.type,
              title: message.title,
              body: message.body,
              data: message.data,
            }),
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // The push service says this subscription is gone — prune it (#350).
            await subscriptions.deleteByEndpoint(sub.endpoint);
            logger.info('pruned expired web-push subscription');
          } else {
            logger.warn({ err, status }, 'web-push send failed');
          }
        }
      }
    },
  };
}

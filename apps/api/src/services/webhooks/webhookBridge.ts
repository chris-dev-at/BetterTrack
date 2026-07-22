import { WEBHOOK_EVENT_TYPES } from '@bettertrack/contracts';

import type { WebhookSubscriptionRepository } from '../../data/repositories/webhookRepository';
import type { DomainEvent } from '../../events';
import type { Logger } from '../../logger';

import type { WebhookDeliveryJob } from './webhookDispatcher';

/**
 * Event-bus bridge (§13.5 V5-P10). Turns one incoming user-scoped domain event
 * into a delivery job per matching subscription. It taps the same durable event
 * pipeline the notification dispatcher runs on (`notifications.dispatch`), which
 * is where every {@link DomainEvent} in the subscribable catalog converges — so
 * webhooks never depend on the ephemeral pub/sub bus surviving a restart, and a
 * subscription only ever receives its owner's own events (`event.userId`).
 *
 * `handleEvent` never throws: a fan-out failure must not fail the notification
 * job it runs alongside.
 */

const WEBHOOK_EVENT_TYPE_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

/** Whether `type` is in the subscribable webhook catalog. */
export function isWebhookEventType(type: string): boolean {
  return WEBHOOK_EVENT_TYPE_SET.has(type);
}

/** The user an event belongs to, or null for a non-user-scoped event. */
export function eventUserId(event: DomainEvent): string | null {
  return 'userId' in event && typeof event.userId === 'string' ? event.userId : null;
}

export interface WebhookBridgeDeps {
  subscriptions: WebhookSubscriptionRepository;
  /** Enqueue one delivery (durable BullMQ in prod; synchronous under test). */
  enqueue: (job: WebhookDeliveryJob) => Promise<void>;
  /** Mint a stable delivery id (UUIDv7). */
  generateId: () => string;
  logger: Logger;
}

export interface WebhookBridge {
  handleEvent(event: DomainEvent): Promise<void>;
}

export function createWebhookBridge(deps: WebhookBridgeDeps): WebhookBridge {
  const { subscriptions, enqueue, generateId, logger } = deps;

  return {
    async handleEvent(event) {
      try {
        if (!isWebhookEventType(event.type)) return;
        const userId = eventUserId(event);
        if (!userId) return;

        const subs = await subscriptions.findEnabledForUserEvent(userId, event.type);
        for (const sub of subs) {
          await enqueue({ subscriptionId: sub.id, deliveryId: generateId(), event });
        }
      } catch (err) {
        // Isolated from the surrounding notification dispatch — log and move on.
        logger.error({ err, type: event.type }, 'webhook bridge: fan-out failed');
      }
    },
  };
}

import { createHash } from 'node:crypto';

import { WEBHOOK_EVENT_TYPES } from '@bettertrack/contracts';

import type { WebhookSubscriptionRepository } from '../../data/repositories/webhookRepository';
import type { DomainEvent } from '../../events';
import type { Logger } from '../../logger';
import {
  isPortfolioContentWebhookEvent,
  ParanoidModeError,
  type ParanoidModeGuard,
} from '../account/paranoidEnforcement';

import type { WebhookDeliveryJob } from './webhookDispatcher';

/**
 * Event-bus bridge (§13.5 V5-P10). Turns one incoming user-scoped domain event
 * into a delivery job per matching subscription. It taps the same durable event
 * pipeline the notification dispatcher runs on (`notifications.dispatch`), which
 * is where every {@link DomainEvent} in the subscribable catalog converges — so
 * webhooks never depend on the ephemeral pub/sub bus surviving a restart, and a
 * subscription only ever receives its owner's own events (`event.userId`).
 *
 * Enqueue failures are isolated per subscription so one broken enqueue cannot
 * suppress its siblings. Once every sibling has been attempted, a failure is
 * rethrown to the durable notification job for retry. Deterministic delivery
 * ids make that replay safe for receiver-side deduplication.
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

/** Serialize an event independent of the insertion order of its object keys. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A deterministic UUIDv8 for one subscription's delivery of one logical event.
 * Replaying the same BullMQ event therefore preserves both the receiver's
 * dedupe key and the delivery-log primary key.
 */
function webhookDeliveryId(subscriptionId: string, event: DomainEvent): string {
  const hash = createHash('sha256')
    .update('bettertrack:webhook-delivery:v1\0')
    .update(subscriptionId)
    .update('\0')
    .update(canonicalJson(event))
    .digest('hex');
  const variant = '89ab'.charAt(Number.parseInt(hash.slice(16, 17), 16) & 0x3);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `8${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

export interface WebhookBridgeDeps {
  subscriptions: WebhookSubscriptionRepository;
  /** Enqueue one delivery (durable BullMQ in prod; synchronous under test). */
  enqueue: (job: WebhookDeliveryJob) => Promise<void>;
  logger: Logger;
  paranoid?: Pick<ParanoidModeGuard, 'runAllowed'>;
}

export interface WebhookBridge {
  handleEvent(event: DomainEvent): Promise<void>;
}

export function createWebhookBridge(deps: WebhookBridgeDeps): WebhookBridge {
  const { subscriptions, enqueue, logger } = deps;

  return {
    async handleEvent(event) {
      if (!isWebhookEventType(event.type)) return;
      const userId = eventUserId(event);
      if (!userId) return;
      const enqueueDeliveries = async () => {
        const subs = await subscriptions.findEnabledForUserEvent(userId, event.type);
        let failedEnqueues = 0;

        for (const sub of subs) {
          try {
            await enqueue({
              subscriptionId: sub.id,
              deliveryId: webhookDeliveryId(sub.id, event),
              event,
            });
          } catch (err) {
            failedEnqueues += 1;
            logger.error(
              { subscriptionId: sub.id, type: event.type, err },
              'webhook bridge: delivery enqueue failed',
            );
          }
        }

        if (failedEnqueues > 0) {
          throw new Error(
            `webhook bridge: ${failedEnqueues} delivery ${failedEnqueues === 1 ? 'enqueue' : 'enqueues'} failed`,
          );
        }
      };

      if (!isPortfolioContentWebhookEvent(event) || !deps.paranoid) {
        await enqueueDeliveries();
        return;
      }
      try {
        await deps.paranoid.runAllowed(userId, 'portfolioWebhooks', enqueueDeliveries);
      } catch (error) {
        if (error instanceof ParanoidModeError) return;
        throw error;
      }
    },
  };
}

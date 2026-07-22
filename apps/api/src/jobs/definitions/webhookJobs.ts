import type { WebhookDeliveryRepository } from '../../data/repositories/webhookRepository';
import type { WebhookDispatcher } from '../../services/webhooks';
import { BACKOFF_BASE_MS } from '../options';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * Outbound-webhook jobs (§13.5 V5-P10, issue 1/2).
 *
 * - `webhooks.deliver` — one HMAC-signed POST per (event, subscription),
 *   enqueued by the bridge. BullMQ provides the retry/backoff: a still-retryable
 *   failure throws so the queue re-runs it with exponential backoff; the
 *   dispatcher owns the terminal outcome (log row + auto-disable streak). Runs at
 *   {@link WEBHOOK_DELIVER_ATTEMPTS} attempts.
 * - `webhooks.deliveryCleanup` — a daily sweep that prunes delivery-log rows
 *   older than {@link WEBHOOK_DELIVERY_RETENTION_DAYS}, keeping the per-
 *   subscription log bounded (the `exportJobs` cleanup pattern).
 */

/** Max delivery attempts before a failure is terminal (feeds auto-disable). */
export const WEBHOOK_DELIVER_ATTEMPTS = 5;

/** Delivery-log retention window enforced by the cleanup job. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

export const WEBHOOK_CLEANUP_SCHEDULER_ID = 'webhooks.deliveryCleanup';
/** Daily at 04:30 Europe/Vienna — off-peak, just after the export cleanup. */
export const WEBHOOK_CLEANUP_CRON = '30 4 * * *';
export const WEBHOOK_CLEANUP_TZ = 'Europe/Vienna';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Thrown to signal BullMQ to retry a still-retryable delivery with backoff. */
export class WebhookDeliveryRetryError extends Error {
  constructor(status: number | null, detail?: string) {
    super(`webhook delivery failed (${status ?? 'network'})${detail ? `: ${detail}` : ''}`);
    this.name = 'WebhookDeliveryRetryError';
  }
}

export interface WebhookDeliverJobDeps {
  dispatcher: WebhookDispatcher;
}

export function createWebhookDeliverJob(
  deps: WebhookDeliverJobDeps,
): JobDefinition<'webhooks.deliver'> {
  return {
    name: QUEUE_NAMES.webhooksDeliver,
    async handler(job) {
      const maxAttempts = job.opts.attempts ?? WEBHOOK_DELIVER_ATTEMPTS;
      // BullMQ increments `attemptsMade` only AFTER a failed attempt, so at
      // handler time it counts prior attempts — this run is `+ 1` (1-based).
      const attempt = job.attemptsMade + 1;
      const result = await deps.dispatcher.deliver(job.data, { attempt, maxAttempts });
      // A retryable failure re-throws so BullMQ re-runs with exponential backoff;
      // the terminal failure was already recorded by the dispatcher.
      if (result.outcome === 'retry') {
        throw new WebhookDeliveryRetryError(result.status, result.error);
      }
    },
    jobOptions: {
      attempts: WEBHOOK_DELIVER_ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_BASE_MS },
    },
  };
}

export interface WebhookCleanupJobDeps {
  deliveries: WebhookDeliveryRepository;
  /** Retention window in days; defaults to {@link WEBHOOK_DELIVERY_RETENTION_DAYS}. */
  retentionDays?: number;
}

export function createWebhookDeliveryCleanupJob(
  deps: WebhookCleanupJobDeps,
): JobDefinition<'webhooks.deliveryCleanup'> {
  const retentionDays = deps.retentionDays ?? WEBHOOK_DELIVERY_RETENTION_DAYS;
  return {
    name: QUEUE_NAMES.webhooksDeliveryCleanup,
    async handler(_job, ctx) {
      const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);
      const pruned = await deps.deliveries.deleteOlderThan(cutoff);
      if (pruned > 0) ctx.logger.info({ pruned }, 'expired webhook deliveries pruned');
    },
    schedule: {
      id: WEBHOOK_CLEANUP_SCHEDULER_ID,
      pattern: WEBHOOK_CLEANUP_CRON,
      tz: WEBHOOK_CLEANUP_TZ,
    },
  };
}

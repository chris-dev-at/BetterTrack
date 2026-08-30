import type { WebhookDeliveryRepository } from '../../data/repositories/webhookRepository';
import type { WebhookDispatcher } from '../../services/webhooks';
import { assertBatchBounds, deleteInBatches } from '../batchDelete';
import { QUEUE_JOB_OPTIONS } from '../options';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * Outbound-webhook jobs (§13.5 V5-P10, issue 1/2).
 *
 * - `webhooks.deliver` — one HMAC-signed POST per (event, subscription),
 *   enqueued by the bridge. BullMQ provides the retry/backoff: a still-retryable
 *   failure throws so the queue re-runs it with exponential backoff; the
 *   dispatcher owns the terminal outcome (log row + auto-disable streak). Runs at
 *   {@link WEBHOOK_DELIVER_ATTEMPTS} attempts. Idempotency key:
 *   `(subscription_id, delivery_id)`; `delivery_id` is deterministically derived
 *   from the logical event and is also the delivery-log primary key.
 * - `webhooks.deliveryCleanup` — a daily sweep that prunes delivery-log rows
 *   older than {@link WEBHOOK_DELIVERY_RETENTION_DAYS}, keeping the per-
 *   subscription log bounded. It drains in bounded batches under a per-run
 *   ceiling (`batchDelete.ts`), never as one full-range DELETE.
 */

/** The options every `webhooks.deliver` job carries (seeded onto the queue). */
const DELIVER_JOB_OPTIONS = QUEUE_JOB_OPTIONS[QUEUE_NAMES.webhooksDeliver];

/**
 * Max delivery attempts before a failure is terminal (feeds auto-disable).
 * Read from the queue declaration rather than restated, so this constant is
 * always the number BullMQ actually stamps on the job.
 */
export const WEBHOOK_DELIVER_ATTEMPTS: number = DELIVER_JOB_OPTIONS.attempts;

/** Delivery-log retention window enforced by the cleanup job. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

/** One bounded DELETE statement never removes more delivery rows than this. */
export const WEBHOOK_DELIVERY_DELETE_BATCH_SIZE = 500;

/**
 * Ceiling on how many delivery rows one run may shed. A busy account can leave
 * far more than this behind the 30-day cutoff; stopping here hands the worker
 * slot back, and tomorrow's run continues from the same cutoff rule rather than
 * dropping the remainder.
 */
export const WEBHOOK_DELIVERY_MAX_ROWS_PER_RUN = 50_000;

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
    jobOptions: DELIVER_JOB_OPTIONS,
  };
}

export interface WebhookCleanupJobDeps {
  deliveries: Pick<WebhookDeliveryRepository, 'deleteOlderThan'>;
  /** Retention window in days; defaults to {@link WEBHOOK_DELIVERY_RETENTION_DAYS}. */
  retentionDays?: number;
  batchSize?: number;
  maxRowsPerRun?: number;
  now?: () => Date;
}

export function createWebhookDeliveryCleanupJob(
  deps: WebhookCleanupJobDeps,
): JobDefinition<'webhooks.deliveryCleanup'> {
  const retentionDays = deps.retentionDays ?? WEBHOOK_DELIVERY_RETENTION_DAYS;
  const batchSize = deps.batchSize ?? WEBHOOK_DELIVERY_DELETE_BATCH_SIZE;
  const maxRowsPerRun = deps.maxRowsPerRun ?? WEBHOOK_DELIVERY_MAX_ROWS_PER_RUN;
  const now = deps.now ?? (() => new Date());
  assertBatchBounds('webhook delivery retention', batchSize, maxRowsPerRun);
  return {
    name: QUEUE_NAMES.webhooksDeliveryCleanup,
    async handler(_job, ctx) {
      const cutoff = new Date(now().getTime() - retentionDays * MS_PER_DAY);
      const { deleted, capped } = await deleteInBatches(
        deps.deliveries.deleteOlderThan.bind(deps.deliveries),
        cutoff,
        batchSize,
        maxRowsPerRun,
      );
      if (deleted > 0) {
        ctx.logger.info(
          // A capped run leaves eligible rows behind on purpose; the next
          // scheduled run continues, so this must be visible in the log.
          { pruned: deleted, deferredToNextRun: capped },
          'expired webhook deliveries pruned',
        );
      }
    },
    schedule: {
      id: WEBHOOK_CLEANUP_SCHEDULER_ID,
      pattern: WEBHOOK_CLEANUP_CRON,
      tz: WEBHOOK_CLEANUP_TZ,
    },
  };
}

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
 *   failure throws so the queue re-runs it with jittered exponential backoff;
 *   the dispatcher owns the terminal outcome (log row + auto-disable streak) and
 *   also owns whether a failure is retryable at all — a permanent receiver
 *   refusal (`410 Gone` and friends) comes back as a terminal outcome, so this
 *   handler returns normally and the ladder ends after ONE attempt. Runs at
 *   {@link WEBHOOK_DELIVER_ATTEMPTS} attempts, across
 *   {@link WEBHOOK_DELIVER_CONCURRENCY} worker slots under
 *   {@link WEBHOOK_DELIVER_LIMITER}, so one dead receiver cannot monopolize the
 *   queue every other user's deliveries share. Idempotency key:
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

/**
 * How many deliveries the worker runs at once. The queue is ONE global FIFO
 * shared by every user, and a black-holed receiver holds its slot for the full
 * transport timeout on each of its {@link WEBHOOK_DELIVER_ATTEMPTS} attempts —
 * at BullMQ's default concurrency of 1 that is minutes of head-of-line blocking
 * for everybody else. Running several in parallel means one stalled receiver
 * occupies one slot, not the queue.
 */
export const WEBHOOK_DELIVER_CONCURRENCY = 8;

/**
 * Throughput ceiling across those slots (BullMQ `limiter`, the
 * `marketDataJobs` idiom): a burst of deliveries — 20 subscriptions × a fan-out
 * event — is spread rather than fired at once, so outbound POSTs cannot crowd
 * out the rest of the worker's work.
 */
export const WEBHOOK_DELIVER_LIMITER = { max: 20, duration: 1000 } as const;

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
    workerOptions: {
      concurrency: WEBHOOK_DELIVER_CONCURRENCY,
      limiter: { ...WEBHOOK_DELIVER_LIMITER },
    },
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

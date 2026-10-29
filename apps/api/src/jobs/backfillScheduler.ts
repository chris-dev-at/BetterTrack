import { customJobId } from './jobIds';
import type { QueueRegistry } from './queues';
import { QUEUE_NAMES } from './types';

/**
 * Enqueues the on-demand `prices.backfill` job (PROJECTPLAN.md §9). Two call
 * sites: catalog enrichment, when a provider search *creates* a catalog row
 * (§6.2 first touch), and the first-reference trigger
 * (`services/assets/referenceBackfill.ts`), when a user first uses an asset
 * that still has no history — which covers seeded and pre-existing rows. Kept
 * behind this tiny port so services depend on an intent ("backfill this
 * asset"), not on BullMQ — which also lets tests assert enqueues without a
 * real queue.
 */
export interface BackfillScheduler {
  /** Enqueue a history backfill for `assetId`. Idempotent per asset. */
  enqueue(assetId: string): Promise<void>;
}

/**
 * The BullMQ job id of `assetId`'s backfill — `prices.backfill-<assetId>`, the
 * job's idempotency key (one backfill per asset). It is derived from the asset
 * alone, so a duplicate enqueue for the same asset is coalesced by BullMQ into
 * the existing job; the job body itself is idempotent on the `price_history`
 * `(asset_id, date)` key, so a run that does happen twice writes nothing new.
 *
 * Never ':'-joined (#1184): the original `prices.backfill:<assetId>` is refused
 * by BullMQ (`Custom Id cannot contain :`), so every production enqueue threw.
 * See {@link customJobId} for the rule and the shape.
 *
 * Accepted trade-off of a fixed per-asset id: while a finished job is still
 * retained (`DEFAULT_JOB_OPTIONS`: last 1000 completed, 5000 failed), a later add
 * for the same asset is a silent BullMQ no-op, so a backfill that found nothing
 * or failed all its attempts is not re-run by the next reference until that
 * job ages out. The nightly `prices.refreshDaily` still fills the recent window.
 */
export function backfillJobId(assetId: string): string {
  return customJobId(QUEUE_NAMES.pricesBackfill, assetId);
}

/**
 * Production scheduler over a {@link QueueRegistry}. The job id is
 * {@link backfillJobId}, so a duplicate enqueue for the same asset is coalesced
 * by BullMQ into the existing job — belt-and-suspenders on top of the callers'
 * own guards (row created exactly once / asset still has no history).
 */
export function createBackfillScheduler(queues: QueueRegistry): BackfillScheduler {
  return {
    async enqueue(assetId) {
      await queues.enqueue(
        QUEUE_NAMES.pricesBackfill,
        { assetId },
        { jobId: backfillJobId(assetId) },
      );
    },
  };
}

/**
 * No-op scheduler for the in-process test harness, where no BullMQ worker runs.
 * Tests that assert first-touch enqueue inject a recording fake instead.
 */
export const noopBackfillScheduler: BackfillScheduler = {
  async enqueue() {
    /* intentionally empty */
  },
};

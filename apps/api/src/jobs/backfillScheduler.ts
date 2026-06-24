import { QUEUE_NAMES } from './types';
import type { QueueRegistry } from './queues';

/**
 * Enqueues the on-demand `prices.backfill` job (PROJECTPLAN.md §9) the first
 * time an asset is referenced (§6.2 first-touch). Kept behind this tiny port so
 * the search service depends on an intent ("backfill this asset"), not on
 * BullMQ — which also lets tests assert enqueues without a real queue.
 */
export interface BackfillScheduler {
  /** Enqueue a history backfill for `assetId`. Idempotent per asset. */
  enqueue(assetId: string): Promise<void>;
}

/**
 * Production scheduler over a {@link QueueRegistry}. The job id is derived from
 * the asset id, so a duplicate enqueue for the same asset is coalesced by BullMQ
 * into the existing job — belt-and-suspenders on top of the first-touch guard
 * (the asset row is created exactly once, so this normally fires once anyway).
 */
export function createBackfillScheduler(queues: QueueRegistry): BackfillScheduler {
  return {
    async enqueue(assetId) {
      await queues.enqueue(
        QUEUE_NAMES.pricesBackfill,
        { assetId },
        { jobId: `${QUEUE_NAMES.pricesBackfill}:${assetId}` },
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

import type { MirrorService } from '../../services/mirror/mirrorService';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `mirror.replicate` — the MIRRORCHAIN replication job (§13.5 V5-P7, design §2,
 * issue #644). One job per chain brings every active copy up to `last_seq`,
 * applying ops strictly in seq order through each member's own services (force
 * mode), idempotent per op with the per-copy watermark bump last — so BullMQ's
 * at-least-once delivery yields exactly-once effect and a retry resumes from
 * the watermark, never skipping and never reordering.
 *
 * Per-chain serialization: producers enqueue with `jobId =
 * mirrorReplicateJobId(chainId)` (see {@link mirrorReplicateJobId}), so at most
 * one job per chain is queued/running at a time; ops appended while a run is in
 * flight are caught by the run's final lag check, which re-enqueues itself. A
 * copy that keeps failing makes the job throw AFTER the sweep (the other copies
 * still catch up — a stalled copy lags, never diverges); the standard retry →
 * dead-letter path then lands it on the admin Problems page via the worker's
 * `onPermanentFailure` hook, and a later re-run ("retry sync") resumes from the
 * stalled copy's watermark.
 */

export interface MirrorReplicateJobDeps {
  mirror: Pick<MirrorService, 'replicateChain'>;
  /** Re-enqueue for the late-append tail race (the durable queue's enqueue). */
  enqueue: (chainId: string) => Promise<void>;
}

/** Job-id dedupe key: at most one queued/active replicate per chain (design §2). */
export function mirrorReplicateJobId(chainId: string): string {
  return `mirror.replicate:${chainId}`;
}

export function createMirrorReplicateJob(
  deps: MirrorReplicateJobDeps,
): JobDefinition<'mirror.replicate'> {
  return {
    name: QUEUE_NAMES.mirrorReplicate,
    async handler(job, ctx) {
      const { chainId } = job.data;
      const result = await deps.mirror.replicateChain(chainId);
      ctx.logger.info({ chainId, ...result }, 'mirror.replicate complete');
      // Ops appended after this run read `last_seq` would otherwise wait for
      // the next write — chain the catch-up now that our job id is free again.
      if (result.lagging > 0) await deps.enqueue(chainId);
    },
  };
}

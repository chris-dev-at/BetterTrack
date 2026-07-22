import type { MirrorService } from '../../services/mirror/mirrorService';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `mirror.replicate` — the MIRRORCHAIN replication job (§13.5 V5-P7, design §2,
 * issue #644). One run brings every active copy of a chain up to `last_seq`,
 * applying ops strictly in seq order through each member's own services (force
 * mode), idempotent per op with the per-copy watermark bump last — so BullMQ's
 * at-least-once delivery yields exactly-once effect and a retry resumes from
 * the watermark, never skipping and never reordering.
 *
 * Producers enqueue plainly per write — deliberately NO job-id dedupe. BullMQ
 * silently ignores an `add` whose id still exists in ANY state, including the
 * retained completed/failed sets (`DEFAULT_JOB_OPTIONS` keeps both), so a fixed
 * per-chain id would swallow every enqueue after the first run and halt
 * replication (and one dead-lettered run would block the whole chain forever).
 * Serialization lives in `replicateChain` itself: each copy's replay runs under
 * the same per-chain Redis lock the submit path holds, so concurrent or
 * redundant jobs are safe and no-op cheaply off the watermark — the same
 * pattern as `snapshots.recompute`. A copy that keeps failing makes the run
 * throw AFTER the sweep (the other copies still catch up — a stalled copy lags,
 * never diverges); the standard retry → dead-letter path then lands it on the
 * admin Problems page via the worker's `onPermanentFailure` hook, and any later
 * enqueue ("retry sync" or the next write) resumes from the stalled copy's
 * watermark.
 */

export interface MirrorReplicateJobDeps {
  mirror: Pick<MirrorService, 'replicateChain'>;
  /** Chain a fresh run for ops appended while this one was sweeping. */
  enqueue: (chainId: string) => Promise<void>;
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
      // the next write — chain a fresh job to catch the tail now.
      if (result.lagging > 0) await deps.enqueue(chainId);
    },
  };
}

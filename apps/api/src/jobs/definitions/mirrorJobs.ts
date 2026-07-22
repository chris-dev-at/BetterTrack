import type { MirrorchainRepository } from '../../data/repositories/mirrorchainRepository';
import { MIRROR_INVITE_TTL_MS, type MirrorService } from '../../services/mirror/mirrorService';
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
 * watermark. The member-facing `mirror.sync_stalled` notice fires off that SAME
 * permanent-failure path (only once the auto-retries are exhausted, via
 * `notifyChainStalled`), so a transient blip that heals on retry never tells a
 * member to "Retry sync" manually.
 */

export interface MirrorReplicateJobDeps {
  mirror: Pick<MirrorService, 'replicateChain' | 'notifyChainStalled'>;
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
      let result;
      try {
        result = await deps.mirror.replicateChain(chainId);
      } catch (err) {
        // A stalled copy makes the run throw so BullMQ retries with backoff. The
        // `mirror.sync_stalled` notice tells the member to "Retry sync" manually,
        // so it must signal a GENUINE stall — fire it only when the auto-retries
        // are exhausted (this attempt is the last → permanent failure →
        // dead-letter → Problems), never on a transient blip that heals on retry.
        const maxAttempts = job.opts.attempts ?? 1;
        if (job.attemptsMade + 1 >= maxAttempts) {
          try {
            await deps.mirror.notifyChainStalled(chainId);
          } catch (notifyErr) {
            // Best-effort: a notify failure must not mask the replicate error
            // that drives the dead-letter path.
            ctx.logger.error(
              { chainId, err: notifyErr },
              'mirror.replicate: sync_stalled notify failed',
            );
          }
        }
        throw err;
      }
      ctx.logger.info({ chainId, ...result }, 'mirror.replicate complete');
      // Ops appended after this run read `last_seq` would otherwise wait for
      // the next write — chain a fresh job to catch the tail now.
      if (result.lagging > 0) await deps.enqueue(chainId);
    },
  };
}

/**
 * `mirror.inviteCleanup` — the daily sweep that retires pending invites past the
 * §4 30-day token-hygiene horizon ({@link MIRROR_INVITE_TTL_MS}), keeping the
 * `(chain, invitee)` pending-unique slot free for re-invites (the accept path
 * already rejects a stale invite at use time; this just tidies the rows). The
 * `webhookJobs`/`apiKeyJobs` cleanup pattern.
 */

export const MIRROR_INVITE_CLEANUP_SCHEDULER_ID = 'mirror.inviteCleanup';
/** Daily at 04:50 Europe/Vienna — off-peak, just after the api-key sweep. */
export const MIRROR_INVITE_CLEANUP_CRON = '50 4 * * *';
export const MIRROR_INVITE_CLEANUP_TZ = 'Europe/Vienna';

export interface MirrorInviteCleanupJobDeps {
  repo: Pick<MirrorchainRepository, 'expireStalePendingInvites'>;
}

export function createMirrorInviteCleanupJob(
  deps: MirrorInviteCleanupJobDeps,
): JobDefinition<'mirror.inviteCleanup'> {
  return {
    name: QUEUE_NAMES.mirrorInviteCleanup,
    async handler(_job, ctx) {
      const cutoff = new Date(Date.now() - MIRROR_INVITE_TTL_MS);
      const expired = await deps.repo.expireStalePendingInvites(cutoff);
      if (expired > 0) ctx.logger.info({ expired }, 'stale mirror invites expired');
    },
    schedule: {
      id: MIRROR_INVITE_CLEANUP_SCHEDULER_ID,
      pattern: MIRROR_INVITE_CLEANUP_CRON,
      tz: MIRROR_INVITE_CLEANUP_TZ,
    },
  };
}

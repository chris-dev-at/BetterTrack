import type { MirrorchainRepository } from '../../data/repositories/mirrorchainRepository';
import { MIRROR_INVITE_TTL_MS, type MirrorService } from '../../services/mirror/mirrorService';
import type {
  ProblemCaptureContext,
  ProblemService,
} from '../../services/observability/problemService';
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

/**
 * `mirror.consistencySweep` — the MIRRORCHAIN M4 defense-in-depth repair sweep
 * (§13.5 V5-P7, design §2/§7, issue #684). One run:
 *  - (0) re-applies §7 succession to any **ownerless active chain** — an
 *    invariant the service never produces, so a hit means the chain was mutated
 *    behind the service (manual SQL); the oldest manager is crowned (or the
 *    chain dissolves with no manager);
 *  - (a) detects the submit path's origin-commit-then-append crash residual (an
 *    origin mirror-row link with no op);
 *  - (b) detects the tax-immutable correction path's re-create-then-re-point
 *    residual (a synced-copy transaction with no mirror link).
 * Every finding is logged onto the admin Problems page (V5-P2) — the (0)
 * repairs as a healed anomaly, (a)/(b) as anomalies for an admin to act on. The
 * `webhookJobs`/`apiKeyJobs`/`mirrorInviteCleanup` daily-sweep pattern.
 */

export const MIRROR_CONSISTENCY_SWEEP_SCHEDULER_ID = 'mirror.consistencySweep';
/** Daily at 05:05 Europe/Vienna — off-peak, just after the invite sweep. */
export const MIRROR_CONSISTENCY_SWEEP_CRON = '5 5 * * *';
export const MIRROR_CONSISTENCY_SWEEP_TZ = 'Europe/Vienna';

export interface MirrorConsistencySweepJobDeps {
  mirror: Pick<MirrorService, 'runConsistencySweep'>;
  /** Surfaces each finding onto the admin Problems page (design §2 / V5-P2). */
  problems: Pick<ProblemService, 'captureError'>;
}

export function createMirrorConsistencySweepJob(
  deps: MirrorConsistencySweepJobDeps,
): JobDefinition<'mirror.consistencySweep'> {
  return {
    name: QUEUE_NAMES.mirrorConsistencySweep,
    async handler(_job, ctx) {
      const result = await deps.mirror.runConsistencySweep();

      // captureError folds by (kind, normalized title, message) and rate-caps, so
      // a storm of identical residuals costs one Problems row with an occurrence
      // count — the title names the anomaly class, the context carries specifics.
      const surface = (title: string, message: string, context: ProblemCaptureContext): void => {
        const err = new Error(message);
        err.name = title;
        deps.problems.captureError(err, context);
      };

      for (const r of result.ownerlessRepaired) {
        surface(
          'mirror: ownerless chain repaired',
          `chain ${r.chainId} had no active owner — applied §7 succession (${r.outcome})`,
          { chainId: r.chainId, outcome: r.outcome, newOwnerUserId: r.newOwnerUserId },
        );
      }
      for (const r of result.danglingOriginRows) {
        surface(
          'mirror: origin row without op',
          `mirror row ${r.mirrorId} (${r.kind}) in portfolio ${r.portfolioId} has no op`,
          { chainId: r.chainId, portfolioId: r.portfolioId, mirrorId: r.mirrorId, kind: r.kind },
        );
      }
      for (const r of result.orphanedLocalRows) {
        surface(
          'mirror: orphaned synced transaction',
          `transaction ${r.localId} in synced portfolio ${r.portfolioId} has no mirror link`,
          { portfolioId: r.portfolioId, localId: r.localId },
        );
      }

      ctx.logger.info(
        {
          ownerlessRepaired: result.ownerlessRepaired.length,
          danglingOriginRows: result.danglingOriginRows.length,
          orphanedLocalRows: result.orphanedLocalRows.length,
        },
        'mirror.consistencySweep complete',
      );
    },
    schedule: {
      id: MIRROR_CONSISTENCY_SWEEP_SCHEDULER_ID,
      pattern: MIRROR_CONSISTENCY_SWEEP_CRON,
      tz: MIRROR_CONSISTENCY_SWEEP_TZ,
    },
  };
}

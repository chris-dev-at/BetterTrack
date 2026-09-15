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
 * mode). Idempotency key: `(mirror_chain_member_id, mirror_chain_op_seq)`, with
 * the per-copy watermark bump last — so BullMQ's at-least-once delivery yields
 * exactly-once effect and a retry resumes from the watermark, never skipping
 * and never reordering.
 *
 * Producers enqueue plainly per write — deliberately NO job-id dedupe. BullMQ
 * silently ignores an `add` whose id still exists in ANY state, including the
 * retained completed/failed sets (`DEFAULT_JOB_OPTIONS` keeps both), so a fixed
 * per-chain id would swallow every enqueue after the first run and halt
 * replication (and one dead-lettered run would block the whole chain forever).
 * Serialization lives in `replicateChain` itself: each copy's replay runs under
 * the same per-chain Redis lock the submit path holds, so concurrent or
 * redundant jobs are safe and no-op cheaply off the watermark — the same
 * pattern as `snapshots.recompute`. The tail-catch re-enqueue this handler does
 * itself IS bounded, on two axes: it carries a delay, and it only happens after
 * a pass that moved a watermark — or one whose only lag appeared while it ran
 * (`stagnant === 0`), which the NEXT pass then resolves either way (see the
 * handler). A copy that keeps failing makes the run
 * throw AFTER the sweep (the other copies still catch up — a stalled copy lags,
 * never diverges); the standard retry → dead-letter path then lands it on the
 * admin Problems page via the worker's `onPermanentFailure` hook, and any later
 * enqueue ("retry sync" or the next write) resumes from the stalled copy's
 * watermark. The member-facing `mirror.sync_stalled` notice fires off that SAME
 * permanent-failure path (only once the auto-retries are exhausted, via
 * `notifyChainStalled`), so a transient blip that heals on retry never tells a
 * member to "Retry sync" manually.
 */

/**
 * Spacing on the tail-catch re-enqueue. The chained run exists to pick up ops
 * appended while this one swept — a job's worth of latency, not a microsecond's
 * — and the delay is what keeps a chain that keeps producing work from spinning
 * the queue at CPU speed.
 */
export const MIRROR_REPLICATE_CHAIN_DELAY_MS = 2_000;

export interface MirrorReplicateJobDeps {
  mirror: Pick<MirrorService, 'replicateChain' | 'notifyChainStalled' | 'escalateStalledChain'>;
  /** Chain a fresh run for ops appended while this one was sweeping. */
  enqueue: (chainId: string, opts?: { delay?: number }) => Promise<void>;
  /** Surfaces a chain that cannot replicate at all onto the admin Problems page. */
  problems?: Pick<ProblemService, 'captureError'>;
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
      // The stagnant USER IDS drive the escalation's aim, not the log line.
      const { stagnantUserIds, ...counts } = result;
      ctx.logger.info({ chainId, ...counts }, 'mirror.replicate complete');
      if (result.lagging <= 0) return;
      // Ops appended after this run read `last_seq` would otherwise wait for
      // the next write — chain a fresh job to catch the tail now. ONLY after a
      // pass that actually moved a watermark: a copy nothing can replay (a
      // departed op author who later enabled paranoid mode blocks the guard for
      // every member behind them) is a SKIP, not a failure, so nothing throws,
      // nothing retries, and an unconditional re-enqueue is a tight infinite
      // loop that re-scans the whole oplog forever while the copy sits at
      // "Syncing… 0 %".
      if (result.advanced > 0) {
        await deps.enqueue(chainId, { delay: MIRROR_REPLICATE_CHAIN_DELAY_MS });
        return;
      }
      // Nothing moved, but nothing was STUCK when the pass began either: the
      // outstanding lag is an op appended (or a member who joined) while the
      // pass ran, and their own scheduleReplicate is already on its way. Chain
      // one more pass instead of escalating — the notice must signal a genuine
      // stall, never a transient blip. Still bounded: on the next pass that copy
      // is behind at pass start, so it either advances or counts as stagnant.
      if (result.stagnant <= 0) {
        await deps.enqueue(chainId, { delay: MIRROR_REPLICATE_CHAIN_DELAY_MS });
        return;
      }
      // No forward progress on a copy that was already behind when the pass
      // started: an identical pass would do exactly this again.
      // Escalate to the stalled path instead — the members are marked stalled
      // (so their copies stop pretending to sync and offer Retry sync) and the
      // notice fires once, on the transition into that state. Aimed at the
      // copies this pass PROVED stagnant, so the marked set is the set the
      // decision was made on: a member who joined (or was written to) while the
      // pass ran is lagging in the DB but was never stuck, and must not be told
      // to "Retry sync".
      const escalation = await deps.mirror.escalateStalledChain(chainId, {
        userIds: stagnantUserIds,
      });
      ctx.logger.warn(
        { chainId, ...counts, ...escalation },
        'mirror.replicate: no forward progress — escalated instead of re-enqueueing',
      );
      if (escalation.stalled > 0 && deps.problems) {
        const err = new Error(
          `chain ${chainId} made no replication progress with ${escalation.stalled} cop${
            escalation.stalled === 1 ? 'y' : 'ies'
          } behind (${result.skipped} skipped by a privacy guard)`,
        );
        err.name = 'mirror: chain cannot replicate';
        deps.problems.captureError(err, {
          chainId,
          lagging: result.lagging,
          skipped: result.skipped,
          stalled: escalation.stalled,
        });
      }
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
 *    residual (a synced-copy transaction with no mirror link);
 *  - (c) detects a lost `*.delete` — an entity the oplog keeps alive that a
 *    copy which has already applied past its latest op no longer carries;
 *  - (d) detects a lost `tx.update` — a synced transaction whose stored money
 *    contradicts the full state its own latest op carries.
 * (c) and (d) are the crash window (a) structurally cannot see: the origin
 * commits its local effect BEFORE it appends, and an update leaves the link
 * intact while a delete takes the link with it.
 * Findings are logged onto the admin Problems page (V5-P2) — the (0) repairs as
 * a healed anomaly, (a)–(d) as anomalies for an admin to act on — as ONE row per
 * anomaly class carrying the count, not one row per finding. The
 * `webhookJobs`/`apiKeyJobs`/`mirrorInviteCleanup` daily-sweep pattern.
 * Idempotency keys: repair convergence is `(chain_id, status,
 * active_owner_count)`; surfaced findings fold on `(problem_kind,
 * normalized_title, message)` in the Problems repository. (a)–(d) are paged in
 * the service (a keyset cursor per detector), so a set larger than one run's
 * bound is walked across runs instead of being cut off at a fixed first page.
 */

/**
 * How many findings of one class a Problems row names individually. The rest
 * are counted, not listed: the row is a signal to go look, and an unbounded
 * example list would just re-create the storm inside a single context blob.
 */
export const MIRROR_SWEEP_ITEMISED_EXAMPLES = 5;

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

      /**
       * One Problems row per anomaly CLASS, never one per finding. `captureError`
       * folds on `(kind, normalized title, message)`, so the message must be
       * id-free — the previous per-row message embedded the row and portfolio
       * ids, which normalize inconsistently (a hex group that is all digits
       * collapses, a mixed one does not), so a storm of N residuals could spend
       * N distinct fingerprints and exhaust the whole minute's `error` budget,
       * taking unrelated application errors down with it. The findings ride in
       * the context: a bounded list of examples plus the counts that say how
       * many were NOT named individually, and how many this run's page bound
       * left for the next run.
       */
      const surface = <T>(spec: {
        title: string;
        message: string;
        rows: readonly T[];
        deferred: number;
        example: (row: T) => ProblemCaptureContext;
      }): void => {
        if (spec.rows.length === 0) return;
        const examples = spec.rows.slice(0, MIRROR_SWEEP_ITEMISED_EXAMPLES).map(spec.example);
        const context: ProblemCaptureContext = {
          found: spec.rows.length,
          itemised: examples.length,
          notItemised: spec.rows.length - examples.length,
          deferredToLaterRuns: spec.deferred,
          examples,
        };
        const err = new Error(spec.message);
        err.name = spec.title;
        deps.problems.captureError(err, context, { occurrences: spec.rows.length });
      };

      surface({
        title: 'mirror: ownerless chain repaired',
        message: 'active chains had no owner and were repaired by §7 succession',
        rows: result.ownerlessRepaired,
        deferred: 0,
        example: (r) => ({
          chainId: r.chainId,
          outcome: r.outcome,
          newOwnerUserId: r.newOwnerUserId,
        }),
      });
      surface({
        title: 'mirror: origin row without op',
        message: 'origin mirror rows exist whose mirror id has no op (design §2 (a) residual)',
        rows: result.danglingOriginRows,
        deferred: result.deferred.danglingOriginRows,
        example: (r) => ({
          chainId: r.chainId,
          portfolioId: r.portfolioId,
          mirrorId: r.mirrorId,
          kind: r.kind,
        }),
      });
      surface({
        title: 'mirror: orphaned synced transaction',
        message: 'transactions in synced copies have no mirror link (design §2 (b) residual)',
        rows: result.orphanedLocalRows,
        deferred: result.deferred.orphanedLocalRows,
        example: (r) => ({ portfolioId: r.portfolioId, localId: r.localId }),
      });
      surface({
        title: 'mirror: entry missing from a caught-up copy',
        message:
          'entries the oplog keeps alive are missing from copies that already applied past them (design §2 (c) residual)',
        rows: result.divergentMissingRows,
        deferred: result.deferred.divergentMissingRows,
        example: (r) => ({
          chainId: r.chainId,
          portfolioId: r.portfolioId,
          mirrorId: r.mirrorId,
          opKind: r.opKind,
          opSeq: r.opSeq,
        }),
      });
      surface({
        title: 'mirror: synced transaction diverges from its op',
        message:
          'synced transactions contradict the full state their own latest op carries (design §2 (d) residual)',
        rows: result.divergentTransactionRows,
        deferred: result.deferred.divergentTransactionRows,
        example: (r) => ({
          chainId: r.chainId,
          portfolioId: r.portfolioId,
          mirrorId: r.mirrorId,
          localId: r.localId,
          opSeq: r.opSeq,
        }),
      });

      ctx.logger.info(
        {
          ownerlessRepaired: result.ownerlessRepaired.length,
          danglingOriginRows: result.danglingOriginRows.length,
          orphanedLocalRows: result.orphanedLocalRows.length,
          divergentMissingRows: result.divergentMissingRows.length,
          divergentTransactionRows: result.divergentTransactionRows.length,
          deferred: result.deferred,
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

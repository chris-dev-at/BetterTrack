import type { PortfolioSnapshotService } from '../../services/portfolio/portfolioSnapshots';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * The V5-P1 daily-snapshot job bodies (issue #553, §16 2026-07-17):
 *
 *  - `snapshots.recompute` — on demand, enqueued by every history-mutating
 *    write's invalidation: re-runs the value engine for ONE portfolio and
 *    refills the deleted tail (insert-missing-only — days before the
 *    invalidation point are never rewritten).
 *  - `snapshots.backfill` — nightly at 03:30 Europe/Vienna (after the 03:00
 *    `prices.refreshDaily` upsert, so yesterday's closes are in): sweeps EVERY
 *    portfolio with history. Its first run IS the backfill of all existing
 *    portfolios; every later run rolls yesterday's row in and re-heals the
 *    trailing {@link SNAPSHOT_HEAL_WINDOW_DAYS} against provider close
 *    revisions. Idempotent and resumable: each portfolio persists as the sweep
 *    reaches it, converged rows re-upsert to identical values, and a re-run
 *    after a crash simply continues from durable state.
 *
 * Both close over the snapshot service (the ONE engine); failures per
 * portfolio are collected, never aborting the sweep, and a run with any
 * failure throws at the end so BullMQ retries and — on exhausted attempts —
 * dead-letters it (§9).
 */

/** Stable scheduler id + cron for the nightly snapshot roll (§9-style, in code). */
export const SNAPSHOTS_BACKFILL_SCHEDULER_ID = 'snapshots.backfill';
export const SNAPSHOTS_BACKFILL_CRON = '30 3 * * *';
export const SNAPSHOTS_BACKFILL_TZ = 'Europe/Vienna';

/**
 * Trailing window (days) the nightly roll overwrites instead of
 * insert-missing-only. `prices.refreshDaily` re-fetches a 1M window nightly and
 * may revise stored closes; without this, a revised close would leave the
 * affected snapshot rows drifted from a fresh recompute until a write happened
 * to invalidate them (§16 2026-07-17). Sized to comfortably cover that 1M
 * refresh window.
 */
export const SNAPSHOT_HEAL_WINDOW_DAYS = 35;

export interface SnapshotJobDeps {
  snapshots: PortfolioSnapshotService;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

/** ISO day `days` before the clock's today (UTC). */
function isoDaysAgo(now: () => number, days: number): string {
  return new Date(now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * `snapshots.recompute` — refill one invalidated portfolio's snapshot tail.
 * A portfolio deleted between enqueue and run is a no-op inside the service
 * (no history → its snapshot state is cleared), never a dead-letter.
 */
export function createSnapshotsRecomputeJob(
  deps: SnapshotJobDeps,
): JobDefinition<'snapshots.recompute'> {
  return {
    name: QUEUE_NAMES.snapshotsRecompute,
    async handler(job, ctx) {
      const { portfolioId } = job.data;
      await deps.snapshots.recompute(portfolioId);
      ctx.logger.info({ portfolioId }, 'snapshots.recompute complete');
    },
  };
}

/**
 * `snapshots.backfill` — the nightly roll over every portfolio with history
 * (and, on its first run, the backfill of all existing portfolios). Portfolios
 * are processed independently; a failure is collected and the handler throws
 * at the end so the retry → dead-letter path engages, while the portfolios
 * that succeeded keep their freshly persisted rows (resumable by construction).
 */
export function createSnapshotsBackfillJob(
  deps: SnapshotJobDeps,
): JobDefinition<'snapshots.backfill'> {
  const now = deps.now ?? Date.now;
  return {
    name: QUEUE_NAMES.snapshotsBackfill,
    schedule: {
      id: SNAPSHOTS_BACKFILL_SCHEDULER_ID,
      pattern: SNAPSHOTS_BACKFILL_CRON,
      tz: SNAPSHOTS_BACKFILL_TZ,
    },
    async handler(_job, ctx) {
      const healFrom = isoDaysAgo(now, SNAPSHOT_HEAL_WINDOW_DAYS);
      const { total, failures } = await deps.snapshots.recomputeAll({ healFrom });
      ctx.logger.info({ total, failed: failures.length }, 'snapshots.backfill complete');
      if (failures.length > 0) {
        throw new Error(
          `snapshots.backfill: ${failures.length}/${total} portfolios failed (first: ${failures[0]})`,
        );
      }
    },
  };
}

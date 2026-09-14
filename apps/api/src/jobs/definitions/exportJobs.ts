import type { ExportService, ExportServiceDeps } from '../../services/export';
import type { QueueRegistry } from '../queues';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * Account data-export jobs (§13.4 V4-P6a, #494), composed in the worker
 * bootstrap because they close over the fully-built {@link ExportService} (db +
 * collector + notification center).
 *
 * - `data.export` — on-demand: the request handler enqueues `{ jobId }`; this
 *   handler assembles the zip, marks the job ready, and emits the export-ready
 *   notification. Idempotent under BullMQ's at-least-once (a ready job no-ops).
 * - `data.exportCleanup` — a daily schedule that deletes every expired export's
 *   file + row, so ready zips never outlive their download window, and then
 *   sweeps the export directory for artifacts no row points at any more.
 */
export const EXPORT_CLEANUP_SCHEDULER_ID = 'data.exportCleanup';
/** Daily at 04:00 Europe/Vienna — off-peak, after the 03:00 price refresh. */
export const EXPORT_CLEANUP_CRON = '0 4 * * *';
export const EXPORT_CLEANUP_TZ = 'Europe/Vienna';

export interface ExportJobDeps {
  exportService: ExportService;
}

/**
 * The one mapping from {@link ExportServiceDeps.enqueueBuild} onto the durable
 * `data.export` queue, shared by BOTH composition roots (the API's `context.ts`
 * and the worker bootstrap). The worker is the process that actually defers a
 * build, so a second hand-written closure there would silently drop `delayMs`
 * — TypeScript accepts a shorter-arity function — and turn the deferral into an
 * unthrottled self-re-enqueue loop (#1812). One mapping, no drift.
 *
 * `delayMs` is how a build deferred by a portfolio-vault finalization waits for
 * the sweep that clears it; the queue's own retry ladder is far too short to
 * reach one.
 */
export function createExportBuildEnqueuer(
  queues: QueueRegistry,
): ExportServiceDeps['enqueueBuild'] {
  return async (jobId: string, opts?: { delayMs?: number }): Promise<void> => {
    await queues.enqueue(
      QUEUE_NAMES.dataExport,
      { jobId },
      ...(opts?.delayMs !== undefined ? [{ delay: opts.delayMs }] : []),
    );
  };
}

export function createExportBuildJob(deps: ExportJobDeps): JobDefinition<'data.export'> {
  return {
    name: QUEUE_NAMES.dataExport,
    async handler(job) {
      await deps.exportService.buildExport(job.data.jobId);
    },
  };
}

export function createExportCleanupJob(deps: ExportJobDeps): JobDefinition<'data.exportCleanup'> {
  return {
    name: QUEUE_NAMES.dataExportCleanup,
    async handler(_job, ctx) {
      const pruned = await deps.exportService.cleanupExpired();
      if (pruned > 0) ctx.logger.info({ pruned }, 'expired data exports pruned');
      // Row-driven pruning can only reach artifacts a row still points at. The
      // directory sweep is the second half: it reaps the files that lost their
      // pointer — a crash mid-build, a kill after the rename, a deleted account
      // whose rows cascaded away (#1714).
      const swept = await deps.exportService.sweepOrphanedArtifacts();
      if (swept > 0) ctx.logger.warn({ swept }, 'orphaned data-export artifacts swept');
    },
    schedule: {
      id: EXPORT_CLEANUP_SCHEDULER_ID,
      pattern: EXPORT_CLEANUP_CRON,
      tz: EXPORT_CLEANUP_TZ,
    },
  };
}

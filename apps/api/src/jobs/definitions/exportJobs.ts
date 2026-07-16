import type { ExportService } from '../../services/export';
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
 *   file + row, so ready zips never outlive their download window.
 */
export const EXPORT_CLEANUP_SCHEDULER_ID = 'data.exportCleanup';
/** Daily at 04:00 Europe/Vienna — off-peak, after the 03:00 price refresh. */
export const EXPORT_CLEANUP_CRON = '0 4 * * *';
export const EXPORT_CLEANUP_TZ = 'Europe/Vienna';

export interface ExportJobDeps {
  exportService: ExportService;
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
    },
    schedule: {
      id: EXPORT_CLEANUP_SCHEDULER_ID,
      pattern: EXPORT_CLEANUP_CRON,
      tz: EXPORT_CLEANUP_TZ,
    },
  };
}

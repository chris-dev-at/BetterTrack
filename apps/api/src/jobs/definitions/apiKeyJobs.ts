import type { ApiKeyRequestLogRepository } from '../../data/repositories/apiKeyRequestLogRepository';
import { assertBatchBounds, deleteInBatches } from '../batchDelete';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * API-key governance jobs (§13.5 V5-P10, issue 2/2).
 *
 * - `apiKeys.requestLogCleanup` — a daily sweep that prunes per-key request-log
 *   rows older than {@link API_KEY_REQUEST_LOG_RETENTION_DAYS}, keeping the
 *   audit trail bounded. This is the highest-volume operational table in the
 *   app — one row per bearer request, so a single key at its default tier can
 *   put millions of rows inside the window — so the sweep drains in bounded
 *   batches under a per-run ceiling (`batchDelete.ts`), never as one
 *   full-range DELETE.
 */

/** Request-log retention window enforced by the cleanup job. */
export const API_KEY_REQUEST_LOG_RETENTION_DAYS = 30;

/** One bounded DELETE statement never removes more request-log rows than this. */
export const API_KEY_REQUEST_LOG_DELETE_BATCH_SIZE = 500;

/**
 * Ceiling on how many request-log rows one run may shed. The backlog behind the
 * cutoff is unbounded in principle; stopping here hands the worker slot back,
 * and tomorrow's run continues from the same cutoff rule rather than dropping
 * the remainder.
 */
export const API_KEY_REQUEST_LOG_MAX_ROWS_PER_RUN = 50_000;

export const API_KEY_REQUEST_LOG_CLEANUP_SCHEDULER_ID = 'apiKeys.requestLogCleanup';
/** Daily at 04:40 Europe/Vienna — off-peak, just after the webhook cleanup. */
export const API_KEY_REQUEST_LOG_CLEANUP_CRON = '40 4 * * *';
export const API_KEY_REQUEST_LOG_CLEANUP_TZ = 'Europe/Vienna';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ApiKeyRequestLogCleanupJobDeps {
  requestLog: Pick<ApiKeyRequestLogRepository, 'deleteOlderThan'>;
  /** Retention window in days; defaults to {@link API_KEY_REQUEST_LOG_RETENTION_DAYS}. */
  retentionDays?: number;
  batchSize?: number;
  maxRowsPerRun?: number;
  now?: () => Date;
}

export function createApiKeyRequestLogCleanupJob(
  deps: ApiKeyRequestLogCleanupJobDeps,
): JobDefinition<'apiKeys.requestLogCleanup'> {
  const retentionDays = deps.retentionDays ?? API_KEY_REQUEST_LOG_RETENTION_DAYS;
  const batchSize = deps.batchSize ?? API_KEY_REQUEST_LOG_DELETE_BATCH_SIZE;
  const maxRowsPerRun = deps.maxRowsPerRun ?? API_KEY_REQUEST_LOG_MAX_ROWS_PER_RUN;
  const now = deps.now ?? (() => new Date());
  assertBatchBounds('api-key request-log retention', batchSize, maxRowsPerRun);
  return {
    name: QUEUE_NAMES.apiKeyRequestLogCleanup,
    async handler(_job, ctx) {
      const cutoff = new Date(now().getTime() - retentionDays * MS_PER_DAY);
      const { deleted, capped } = await deleteInBatches(
        deps.requestLog.deleteOlderThan.bind(deps.requestLog),
        cutoff,
        batchSize,
        maxRowsPerRun,
      );
      if (deleted > 0) {
        ctx.logger.info(
          // A capped run leaves eligible rows behind on purpose; the next
          // scheduled run continues, so this must be visible in the log.
          { pruned: deleted, deferredToNextRun: capped },
          'expired api-key request-log rows pruned',
        );
      }
    },
    schedule: {
      id: API_KEY_REQUEST_LOG_CLEANUP_SCHEDULER_ID,
      pattern: API_KEY_REQUEST_LOG_CLEANUP_CRON,
      tz: API_KEY_REQUEST_LOG_CLEANUP_TZ,
    },
  };
}

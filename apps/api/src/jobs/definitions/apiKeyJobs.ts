import type { ApiKeyRequestLogRepository } from '../../data/repositories/apiKeyRequestLogRepository';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * API-key governance jobs (§13.5 V5-P10, issue 2/2).
 *
 * - `apiKeys.requestLogCleanup` — a daily sweep that prunes per-key request-log
 *   rows older than {@link API_KEY_REQUEST_LOG_RETENTION_DAYS}, keeping the
 *   audit trail bounded (the `webhookJobs`/`exportJobs` cleanup pattern).
 */

/** Request-log retention window enforced by the cleanup job. */
export const API_KEY_REQUEST_LOG_RETENTION_DAYS = 30;

export const API_KEY_REQUEST_LOG_CLEANUP_SCHEDULER_ID = 'apiKeys.requestLogCleanup';
/** Daily at 04:40 Europe/Vienna — off-peak, just after the webhook cleanup. */
export const API_KEY_REQUEST_LOG_CLEANUP_CRON = '40 4 * * *';
export const API_KEY_REQUEST_LOG_CLEANUP_TZ = 'Europe/Vienna';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ApiKeyRequestLogCleanupJobDeps {
  requestLog: ApiKeyRequestLogRepository;
  /** Retention window in days; defaults to {@link API_KEY_REQUEST_LOG_RETENTION_DAYS}. */
  retentionDays?: number;
}

export function createApiKeyRequestLogCleanupJob(
  deps: ApiKeyRequestLogCleanupJobDeps,
): JobDefinition<'apiKeys.requestLogCleanup'> {
  const retentionDays = deps.retentionDays ?? API_KEY_REQUEST_LOG_RETENTION_DAYS;
  return {
    name: QUEUE_NAMES.apiKeyRequestLogCleanup,
    async handler(_job, ctx) {
      const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);
      const pruned = await deps.requestLog.deleteOlderThan(cutoff);
      if (pruned > 0) ctx.logger.info({ pruned }, 'expired api-key request-log rows pruned');
    },
    schedule: {
      id: API_KEY_REQUEST_LOG_CLEANUP_SCHEDULER_ID,
      pattern: API_KEY_REQUEST_LOG_CLEANUP_CRON,
      tz: API_KEY_REQUEST_LOG_CLEANUP_TZ,
    },
  };
}

import type { AuditRepository } from '../../data/repositories/auditRepository';
import type { EmailLogRepository } from '../../data/repositories/emailLogRepository';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/** One bounded DELETE statement never removes more rows than this. */
export const DATA_RETENTION_DELETE_BATCH_SIZE = 500;

export const DATA_RETENTION_CLEANUP_SCHEDULER_ID = 'data.retentionCleanup';
/** Daily at 04:50 Europe/Vienna, after the other operational-log cleanup jobs. */
export const DATA_RETENTION_CLEANUP_CRON = '50 4 * * *';
export const DATA_RETENTION_CLEANUP_TZ = 'Europe/Vienna';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type BoundedDelete = (cutoff: Date, limit: number) => Promise<number>;

async function deleteInBatches(
  deleteOlderThan: BoundedDelete,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  let total = 0;
  while (true) {
    const deleted = await deleteOlderThan(cutoff, batchSize);
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

export interface DataRetentionCleanupJobDeps {
  audit: Pick<AuditRepository, 'deleteOlderThan'>;
  emailLog: Pick<EmailLogRepository, 'deleteOlderThan'>;
  /** Whole days; `0` explicitly means retain audit rows forever. */
  auditRetentionDays: number;
  /** Whole days; `0` explicitly means retain email-log rows forever. */
  emailLogRetentionDays: number;
  batchSize?: number;
  now?: () => Date;
}

/**
 * Daily, idempotent retention sweep for identifying operational trails. Each
 * repository call is bounded; the handler repeats until a short batch proves
 * that no row before the fixed run cutoff remains.
 */
export function createDataRetentionCleanupJob(
  deps: DataRetentionCleanupJobDeps,
): JobDefinition<'data.retentionCleanup'> {
  const batchSize = deps.batchSize ?? DATA_RETENTION_DELETE_BATCH_SIZE;
  const now = deps.now ?? (() => new Date());
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('data retention batch size must be a positive integer');
  }

  return {
    name: QUEUE_NAMES.dataRetentionCleanup,
    async handler(_job, ctx) {
      const runAt = now().getTime();
      const auditPruned =
        deps.auditRetentionDays === 0
          ? 0
          : await deleteInBatches(
              deps.audit.deleteOlderThan.bind(deps.audit),
              new Date(runAt - deps.auditRetentionDays * MS_PER_DAY),
              batchSize,
            );
      const emailLogPruned =
        deps.emailLogRetentionDays === 0
          ? 0
          : await deleteInBatches(
              deps.emailLog.deleteOlderThan.bind(deps.emailLog),
              new Date(runAt - deps.emailLogRetentionDays * MS_PER_DAY),
              batchSize,
            );

      if (auditPruned > 0 || emailLogPruned > 0) {
        ctx.logger.info({ auditPruned, emailLogPruned }, 'expired audit and email-log rows pruned');
      }
    },
    schedule: {
      id: DATA_RETENTION_CLEANUP_SCHEDULER_ID,
      pattern: DATA_RETENTION_CLEANUP_CRON,
      tz: DATA_RETENTION_CLEANUP_TZ,
    },
  };
}

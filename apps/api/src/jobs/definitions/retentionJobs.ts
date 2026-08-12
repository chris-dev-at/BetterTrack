import type { AuditRepository } from '../../data/repositories/auditRepository';
import type { EmailLogRepository } from '../../data/repositories/emailLogRepository';
import type { ParanoidVaultRepository } from '../../data/repositories/paranoidVaultRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { sweepLegacyRememberedDeviceBindings } from '../../services/auth/loginThrottle';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/** One bounded DELETE statement never removes more rows than this. */
export const DATA_RETENTION_DELETE_BATCH_SIZE = 500;

/**
 * Ceiling on how many rows one table may shed in a single run. The first run
 * after an owner shortens a window can face a very large backlog; stopping here
 * hands the worker slot back and the next daily run continues from the same
 * cutoff rule.
 */
export const DATA_RETENTION_MAX_ROWS_PER_RUN = 50_000;

export const DATA_RETENTION_CLEANUP_SCHEDULER_ID = 'data.retentionCleanup';
/** Daily at 04:50 Europe/Vienna, after the other operational-log cleanup jobs. */
export const DATA_RETENTION_CLEANUP_CRON = '50 4 * * *';
export const DATA_RETENTION_CLEANUP_TZ = 'Europe/Vienna';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type BoundedDelete = (cutoff: Date, limit: number) => Promise<number>;

interface BatchedDeleteResult {
  deleted: number;
  /** True when the per-run ceiling stopped the drain before it converged. */
  capped: boolean;
}

async function deleteInBatches(
  deleteOlderThan: BoundedDelete,
  cutoff: Date,
  batchSize: number,
  maxRows: number,
): Promise<BatchedDeleteResult> {
  let total = 0;
  while (total < maxRows) {
    const limit = Math.min(batchSize, maxRows - total);
    const deleted = await deleteOlderThan(cutoff, limit);
    total += deleted;
    if (deleted < limit) return { deleted: total, capped: false };
  }
  return { deleted: total, capped: true };
}

export interface DataRetentionCleanupJobDeps {
  audit: Pick<AuditRepository, 'deleteOlderThan'>;
  emailLog: Pick<EmailLogRepository, 'deleteOlderThan'>;
  /** Expired normal-mode enable windows and every opaque byte staged under them. */
  vaultStaging: Pick<ParanoidVaultRepository, 'cleanupExpiredEnableStaging'>;
  /** Batched account lookup for the remembered-device sweep. */
  users: Pick<UserRepository, 'listByIds'>;
  /** Whole days; `0` explicitly means retain audit rows forever. */
  auditRetentionDays: number;
  /** Whole days; `0` explicitly means retain email-log rows forever. */
  emailLogRetentionDays: number;
  batchSize?: number;
  maxRowsPerRun?: number;
  now?: () => Date;
}

const NOTHING_PRUNED: BatchedDeleteResult = { deleted: 0, capped: false };

/**
 * Daily, idempotent retention sweep for identifying operational trails. Each
 * repository call is bounded; the handler repeats until a short batch proves
 * that no row before the fixed run cutoff remains, or until the per-run ceiling
 * defers the rest to tomorrow's run. The same pass retires the pre-retention
 * remembered-device bindings in Redis, so that population becomes enumerable
 * and TTL-bounded without waiting for each browser to return.
 */
export function createDataRetentionCleanupJob(
  deps: DataRetentionCleanupJobDeps,
): JobDefinition<'data.retentionCleanup'> {
  const batchSize = deps.batchSize ?? DATA_RETENTION_DELETE_BATCH_SIZE;
  const maxRowsPerRun = deps.maxRowsPerRun ?? DATA_RETENTION_MAX_ROWS_PER_RUN;
  const now = deps.now ?? (() => new Date());
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('data retention batch size must be a positive integer');
  }
  if (!Number.isSafeInteger(maxRowsPerRun) || maxRowsPerRun < batchSize) {
    throw new Error('data retention per-run ceiling must be an integer at least one batch wide');
  }

  return {
    name: QUEUE_NAMES.dataRetentionCleanup,
    async handler(_job, ctx) {
      const runAt = now().getTime();
      const audit =
        deps.auditRetentionDays === 0
          ? NOTHING_PRUNED
          : await deleteInBatches(
              deps.audit.deleteOlderThan.bind(deps.audit),
              new Date(runAt - deps.auditRetentionDays * MS_PER_DAY),
              batchSize,
              maxRowsPerRun,
            );
      const emailLog =
        deps.emailLogRetentionDays === 0
          ? NOTHING_PRUNED
          : await deleteInBatches(
              deps.emailLog.deleteOlderThan.bind(deps.emailLog),
              new Date(runAt - deps.emailLogRetentionDays * MS_PER_DAY),
              batchSize,
              maxRowsPerRun,
            );
      const vaultStaging = await deleteInBatches(
        deps.vaultStaging.cleanupExpiredEnableStaging.bind(deps.vaultStaging),
        new Date(runAt),
        batchSize,
        maxRowsPerRun,
      );
      const devices = await sweepLegacyRememberedDeviceBindings(ctx.redis, deps.users);

      if (audit.deleted > 0 || emailLog.deleted > 0 || vaultStaging.deleted > 0) {
        ctx.logger.info(
          {
            auditPruned: audit.deleted,
            emailLogPruned: emailLog.deleted,
            abandonedVaultStagesPruned: vaultStaging.deleted,
            // A capped run leaves eligible rows behind on purpose; the next
            // scheduled run continues, so this must be visible in the log.
            deferredToNextRun: audit.capped || emailLog.capped || vaultStaging.capped,
          },
          'expired audit, email-log and abandoned vault-staging rows pruned',
        );
      }
      if (devices.legacy > 0) {
        ctx.logger.info(devices, 'pre-retention remembered-device bindings retired');
      }
    },
    schedule: {
      id: DATA_RETENTION_CLEANUP_SCHEDULER_ID,
      pattern: DATA_RETENTION_CLEANUP_CRON,
      tz: DATA_RETENTION_CLEANUP_TZ,
    },
  };
}

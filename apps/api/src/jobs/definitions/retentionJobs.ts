import type { AuditRepository } from '../../data/repositories/auditRepository';
import type { EmailLogRepository } from '../../data/repositories/emailLogRepository';
import type { ParanoidVaultRepository } from '../../data/repositories/paranoidVaultRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { VaultBlobRepository } from '../../data/repositories/vaultBlobRepository';
import { sweepLegacyRememberedDeviceBindings } from '../../services/auth/loginThrottle';
import { assertBatchBounds, deleteInBatches, NOTHING_PRUNED } from '../batchDelete';
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

export interface DataRetentionCleanupJobDeps {
  audit: Pick<AuditRepository, 'deleteOlderThan'>;
  emailLog: Pick<EmailLogRepository, 'deleteOlderThan'>;
  /** Expired normal-mode enable windows and every opaque byte staged under them. */
  vaultStaging: Pick<ParanoidVaultRepository, 'cleanupExpiredEnableStaging'>;
  /**
   * Per-vault staged server candidates past their TTL. The #1491 retention
   * ruling keeps a staged candidate recoverable until `expires_at` rather than
   * deleting it at move-in; without this sweep a candidate on a vault nobody
   * reads again would outlive that window forever (#1521). The lazy expiry
   * checks in the repository stay — this is the belt to their braces.
   */
  vaultCandidates: Pick<VaultBlobRepository, 'cleanupExpiredServerCandidates'>;
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
  assertBatchBounds('data retention', batchSize, maxRowsPerRun);

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
      const abandonedVaultStagesExamined = vaultStaging.deleted;
      const vaultCandidates = await deleteInBatches(
        deps.vaultCandidates.cleanupExpiredServerCandidates.bind(deps.vaultCandidates),
        new Date(runAt),
        batchSize,
        maxRowsPerRun,
      );
      const devices = await sweepLegacyRememberedDeviceBindings(ctx.redis, deps.users);

      if (
        audit.deleted > 0 ||
        emailLog.deleted > 0 ||
        abandonedVaultStagesExamined > 0 ||
        vaultCandidates.deleted > 0
      ) {
        ctx.logger.info(
          {
            auditPruned: audit.deleted,
            emailLogPruned: emailLog.deleted,
            abandonedVaultStagesExamined,
            // The staged residue the #1491 TTL promises to bound (#1521).
            expiredVaultCandidatesDisposed: vaultCandidates.deleted,
            // A capped run leaves eligible rows behind on purpose; the next
            // scheduled run continues, so this must be visible in the log.
            deferredToNextRun:
              audit.capped || emailLog.capped || vaultStaging.capped || vaultCandidates.capped,
          },
          'expired audit and email-log rows pruned; abandoned vault-staging rows examined; expired vault candidates disposed',
        );
      }
      if (devices.legacy > 0) {
        ctx.logger.info(devices, 'pre-retention remembered-device bindings retired');
      }

      // The same counts the log line carries, returned so they survive as this
      // run's BullMQ `returnvalue` and the admin operations cockpit can show
      // what the sweep actually did (#1406 W4). Counts only — never an id.
      // Booleans are widened to 0/1 because `JobRunSummary` is numbers-only.
      return {
        auditPruned: audit.deleted,
        emailLogPruned: emailLog.deleted,
        abandonedVaultStagesExamined,
        expiredVaultCandidatesDisposed: vaultCandidates.deleted,
        legacyDeviceBindingsRetired: devices.legacy,
        deferredToNextRun:
          audit.capped || emailLog.capped || vaultStaging.capped || vaultCandidates.capped ? 1 : 0,
      };
    },
    schedule: {
      id: DATA_RETENTION_CLEANUP_SCHEDULER_ID,
      pattern: DATA_RETENTION_CLEANUP_CRON,
      tz: DATA_RETENTION_CLEANUP_TZ,
    },
  };
}

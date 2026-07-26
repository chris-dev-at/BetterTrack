import type { ParanoidVaultRepository } from '../../data/repositories/paranoidVaultRepository';
import { QUEUE_NAMES, type JobDefinition } from '../types';

export const VAULT_SERVER_CANDIDATE_CLEANUP_SCHEDULER_ID = 'vault.serverCandidateCleanup';
/** Candidate TTL is ten minutes; a one-minute sweep keeps expiry lag bounded. */
export const VAULT_SERVER_CANDIDATE_CLEANUP_INTERVAL_MS = 60 * 1000;
/** Keep each cleanup transaction small after a long worker outage. */
export const VAULT_SERVER_CANDIDATE_CLEANUP_BATCH_SIZE = 100;

export interface VaultServerCandidateCleanupJobDeps {
  vaults: ParanoidVaultRepository;
  now?: () => Date;
  batchSize?: number;
}

/**
 * Independent physical expiry for inactive server candidates. Lazy request-path
 * cleanup remains defense in depth, but Drive-only zero-server-bytes no longer
 * relies on the owner returning after an interrupted switch.
 */
export function createVaultServerCandidateCleanupJob(
  deps: VaultServerCandidateCleanupJobDeps,
): JobDefinition<'vault.serverCandidateCleanup'> {
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? VAULT_SERVER_CANDIDATE_CLEANUP_BATCH_SIZE;
  return {
    name: QUEUE_NAMES.vaultServerCandidateCleanup,
    async handler(_job, ctx) {
      const pruned = await deps.vaults.deleteExpiredServerCandidates(now(), batchSize);
      if (pruned > 0) ctx.logger.info({ pruned }, 'expired paranoid vault candidates pruned');
    },
    schedule: {
      id: VAULT_SERVER_CANDIDATE_CLEANUP_SCHEDULER_ID,
      every: VAULT_SERVER_CANDIDATE_CLEANUP_INTERVAL_MS,
    },
  };
}

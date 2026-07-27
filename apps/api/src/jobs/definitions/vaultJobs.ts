import type { ParanoidVaultRepository } from '../../data/repositories/paranoidVaultRepository';
import { QUEUE_NAMES, type JobDefinition } from '../types';

export const VAULT_SERVER_CANDIDATE_CLEANUP_SCHEDULER_ID = 'vault.serverCandidateCleanup';
/** A one-minute sweep keeps physical expiry lag bounded independently of user traffic. */
export const VAULT_SERVER_CANDIDATE_CLEANUP_INTERVAL_MS = 60 * 1000;
/** Keep every cleanup transaction bounded after a long worker outage. */
export const VAULT_SERVER_CANDIDATE_CLEANUP_BATCH_SIZE = 100;

export interface VaultServerCandidateCleanupJobDeps {
  vaults: ParanoidVaultRepository;
  now?: () => Date;
  batchSize?: number;
}

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

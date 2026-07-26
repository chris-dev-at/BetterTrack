import { describe, expect, it, vi } from 'vitest';

import type { ParanoidVaultRepository } from '../../data/repositories/paranoidVaultRepository';
import {
  createVaultServerCandidateCleanupJob,
  VAULT_SERVER_CANDIDATE_CLEANUP_BATCH_SIZE,
  VAULT_SERVER_CANDIDATE_CLEANUP_INTERVAL_MS,
  VAULT_SERVER_CANDIDATE_CLEANUP_SCHEDULER_ID,
} from '../definitions/vaultJobs';
import type { JobContext } from '../types';

describe('paranoid vault candidate cleanup job', () => {
  it('runs an independent bounded expiry sweep on the repeatable schedule', async () => {
    const cutoff = new Date('2026-07-26T12:00:00.000Z');
    const deleteExpiredServerCandidates = vi.fn(async () => 2);
    const logger = { info: vi.fn() };
    const job = createVaultServerCandidateCleanupJob({
      vaults: { deleteExpiredServerCandidates } as unknown as ParanoidVaultRepository,
      now: () => cutoff,
    });

    await job.handler({ data: {} } as never, { logger } as unknown as JobContext);

    expect(job.schedule).toEqual({
      id: VAULT_SERVER_CANDIDATE_CLEANUP_SCHEDULER_ID,
      every: VAULT_SERVER_CANDIDATE_CLEANUP_INTERVAL_MS,
    });
    expect(deleteExpiredServerCandidates).toHaveBeenCalledWith(
      cutoff,
      VAULT_SERVER_CANDIDATE_CLEANUP_BATCH_SIZE,
    );
    expect(logger.info).toHaveBeenCalledWith(
      { pruned: 2 },
      'expired paranoid vault candidates pruned',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { JobContext } from '../types';
import {
  createPortfolioVaultFinalizeJob,
  PORTFOLIO_VAULT_FINALIZE_INTERVAL_MS,
  PORTFOLIO_VAULT_FINALIZE_MAX_BATCH_SIZE,
  PORTFOLIO_VAULT_FINALIZE_SCHEDULER_ID,
} from '../definitions/portfolioVaultJobs';

function context() {
  const logger = { info: vi.fn(), error: vi.fn() };
  return { logger, ctx: { logger } as unknown as JobContext };
}

describe('portfolioVault.finalize', () => {
  it('runs every 60 seconds and delegates one bounded pending-guard recovery batch', async () => {
    const finalizePending = vi.fn(async () => ({ processed: 2, failures: [] }));
    const definition = createPortfolioVaultFinalizeJob({ finalizePending, batchSize: 7 });
    const { logger, ctx } = context();

    expect(definition.name).toBe('portfolioVault.finalize');
    expect(definition.schedule).toEqual({
      id: PORTFOLIO_VAULT_FINALIZE_SCHEDULER_ID,
      every: PORTFOLIO_VAULT_FINALIZE_INTERVAL_MS,
    });
    expect(definition.workerOptions).toEqual({ concurrency: 1 });

    await definition.handler({} as never, ctx);

    expect(finalizePending).toHaveBeenCalledOnce();
    expect(finalizePending).toHaveBeenCalledWith(7);
    expect(logger.info).toHaveBeenCalledWith(
      { processed: 2 },
      'pending portfolio vault move-outs finalized',
    );
  });

  it('fails the BullMQ attempt when any transition remains pending', async () => {
    // Deterministic TEST VECTOR UUID; it is not a credential.
    const portfolioId = '019c8200-0000-7000-8000-000000000001';
    const definition = createPortfolioVaultFinalizeJob({
      finalizePending: async () => ({ processed: 1, failures: [portfolioId] }),
    });
    const { logger, ctx } = context();

    await expect(definition.handler({} as never, ctx)).rejects.toThrow(
      '1 portfolio vault move-out finalization(s) remain pending',
    );
    expect(logger.error).toHaveBeenCalledWith(
      { processed: 1, failures: [portfolioId] },
      'one or more portfolio vault move-outs remain pending',
    );
  });

  it.each([0, -1, 1.5, PORTFOLIO_VAULT_FINALIZE_MAX_BATCH_SIZE + 1])(
    'rejects an unsafe batch size (%s)',
    (batchSize) => {
      expect(() =>
        createPortfolioVaultFinalizeJob({
          finalizePending: async () => ({ processed: 0, failures: [] }),
          batchSize,
        }),
      ).toThrow(/batch size must be an integer between/);
    },
  );
});

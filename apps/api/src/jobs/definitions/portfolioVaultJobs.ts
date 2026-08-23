import { QUEUE_NAMES, type JobDefinition } from '../types';

export const PORTFOLIO_VAULT_FINALIZE_SCHEDULER_ID = 'portfolioVault.finalize';
export const PORTFOLIO_VAULT_FINALIZE_INTERVAL_MS = 60_000;
export const PORTFOLIO_VAULT_FINALIZE_BATCH_SIZE = 50;
export const PORTFOLIO_VAULT_FINALIZE_MAX_BATCH_SIZE = 100;

export interface PortfolioVaultFinalizeSweepResult {
  /** Pending transitions that reached their durable final state during this pass. */
  processed: number;
  /** Stable portfolio ids (or equally opaque identifiers) that remain pending. */
  failures: readonly string[];
}

export interface PortfolioVaultFinalizeJobDeps {
  /** The service owns locking and idempotency; the job only bounds each sweep. */
  finalizePending(limit: number): Promise<PortfolioVaultFinalizeSweepResult>;
  batchSize?: number;
}

/**
 * Frequent recovery sweep for outcome-ambiguous portfolio move-outs. The
 * restore commit has already cleared vault membership; its durable pending
 * marker lets every retry repeat derived and externally visible convergence
 * without changing the already-committed E2 membership state. Failing the
 * BullMQ attempt makes the outage visible while normal retries continue.
 */
export function createPortfolioVaultFinalizeJob(
  deps: PortfolioVaultFinalizeJobDeps,
): JobDefinition<'portfolioVault.finalize'> {
  const batchSize = deps.batchSize ?? PORTFOLIO_VAULT_FINALIZE_BATCH_SIZE;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > PORTFOLIO_VAULT_FINALIZE_MAX_BATCH_SIZE
  ) {
    throw new Error(
      `portfolio vault finalize batch size must be an integer between 1 and ${PORTFOLIO_VAULT_FINALIZE_MAX_BATCH_SIZE}`,
    );
  }

  return {
    name: QUEUE_NAMES.portfolioVaultFinalize,
    async handler(_job, ctx) {
      const result = await deps.finalizePending(batchSize);
      if (result.processed > 0) {
        ctx.logger.info(
          { processed: result.processed },
          'pending portfolio vault move-outs finalized',
        );
      }
      if (result.failures.length > 0) {
        ctx.logger.error(
          { processed: result.processed, failures: result.failures },
          'one or more portfolio vault move-outs remain pending',
        );
        throw new Error(
          `${result.failures.length} portfolio vault move-out finalization(s) remain pending`,
        );
      }
    },
    schedule: {
      id: PORTFOLIO_VAULT_FINALIZE_SCHEDULER_ID,
      every: PORTFOLIO_VAULT_FINALIZE_INTERVAL_MS,
    },
    workerOptions: { concurrency: 1 },
  };
}

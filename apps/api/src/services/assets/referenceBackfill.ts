import type { AssetRepository } from '../../data/repositories/assetRepository';
import type { BackfillScheduler } from '../../jobs';
import type { Logger } from '../../logger';

/**
 * First-reference history warming (PROJECTPLAN.md §6.2, §9): the first time a
 * user actually *uses* an asset — adds it to a workboard or records a
 * transaction on it — its max-range daily history is backfilled into
 * `price_history`, so sparklines, the portfolio value-over-time series and
 * backtests have data to work with.
 *
 * This complements the enrichment-side enqueue (which only fires when a
 * provider search *creates* a catalog row): seeded rows (§6.2(c)) and rows
 * created by earlier searches never get that enqueue, so without this trigger
 * their history would stay empty forever. Custom (manual-provider) assets pass
 * through unchanged — their value points already live in `price_history`, so
 * the emptiness probe usually skips them, and a backfill of an empty one is a
 * harmless no-op.
 *
 * The trigger is gated on "has no history yet" rather than "first reference
 * ever", so it is cheap to call on every reference and self-heals if an earlier
 * backfill found nothing. Conglomerate positions (P4) must call
 * {@link ReferenceBackfill.ensureHistory} from their create/update path too.
 */
export interface ReferenceBackfill {
  /**
   * Enqueue a history backfill for `assetId` if it has no `price_history` rows
   * yet. Best-effort: a failed probe or enqueue is logged, never thrown — the
   * user's write must not fail because the queue hiccuped.
   */
  ensureHistory(assetId: string): Promise<void>;
}

export interface ReferenceBackfillDeps {
  assetRepo: Pick<AssetRepository, 'hasPriceHistory'>;
  backfill: BackfillScheduler;
  logger: Logger;
}

export function createReferenceBackfill(deps: ReferenceBackfillDeps): ReferenceBackfill {
  const { assetRepo, backfill, logger } = deps;
  return {
    async ensureHistory(assetId) {
      try {
        if (await assetRepo.hasPriceHistory(assetId)) return;
        await backfill.enqueue(assetId);
      } catch (err) {
        logger.warn({ err, assetId }, 'first-reference history backfill failed');
      }
    },
  };
}

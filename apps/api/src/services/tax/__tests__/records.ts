import type { CashMovementRecord } from '../../../data/repositories/cashMovementRepository';
import type { DividendRecord } from '../../../data/repositories/taxRepository';
import type { TransactionRecord } from '../../../data/repositories/transactionRepository';
import {
  dePotCategoryForAssetType,
  realizedSellsEur,
  viennaYearOf,
  type CostBasisStrategy,
  type DePotCategory,
  type SellRealizationEur,
  type TaxableTransaction,
} from '../../../domain/tax';

/**
 * Row/movement fixture builders shared by the service-layer tax-engine unit
 * suites (openYear / countryState / customState). They mint the persisted
 * record shapes the engine reads (`TransactionRecord`, `DividendRecord`,
 * `CashMovementRecord`) with sensible tax-clean defaults, and rebuild the
 * recomputed-realizations view the same way the service does — via the domain
 * {@link realizedSellsEur} replay — so every test drives the REAL money math
 * with no DB and no network.
 */

/** A `country_specific` sell/buy record; caller overrides id/side/quantity/price. */
export function txRecord(
  over: Partial<TransactionRecord> & { id: string; side: 'buy' | 'sell' },
): TransactionRecord {
  return {
    portfolioId: 'p1',
    assetId: 'a1',
    quantity: 1,
    price: 0,
    fee: 0,
    executedAt: new Date('2026-01-01T00:00:00.000Z'),
    note: null,
    taxMode: 'country_specific',
    taxCountry: 'AT',
    taxAmountEur: null,
    taxParams: null,
    allowUncovered: false,
    uncoveredEntryPrice: null,
    source: 'manual',
    ...over,
  };
}

/** A `country_specific` dividend record; caller overrides id/gross/date/mode. */
export function divRecord(
  over: Partial<DividendRecord> & { id: string; grossAmountEur: number },
): DividendRecord {
  return {
    portfolioId: 'p1',
    assetId: 'a1',
    cashSourceId: 'cash-1',
    executedAt: new Date('2026-01-01T00:00:00.000Z'),
    note: null,
    taxMode: 'country_specific',
    taxCountry: 'AT',
    taxAmountEur: null,
    taxParams: null,
    source: 'manual',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

/** An unattached tax movement of a given Vienna year (a settlement correction). */
export function taxMovement(
  over: Partial<CashMovementRecord> & {
    id: string;
    kind: 'tax_withholding' | 'tax_refund';
    amountEur: number;
    taxYear: number;
  },
): CashMovementRecord {
  return {
    portfolioId: 'p1',
    sourceId: 'cash-1',
    transactionId: null,
    transferId: null,
    counterpartSourceId: null,
    dividendId: null,
    executedAt: new Date('2026-01-01T00:00:00.000Z'),
    note: null,
    source: 'manual',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

const toTaxable = (t: TransactionRecord): TaxableTransaction => ({
  id: t.id,
  assetId: t.assetId,
  side: t.side,
  quantity: t.quantity,
  priceEur: t.price,
  feeEur: t.fee,
  executedAt: t.executedAt.toISOString(),
  allowUncovered: t.allowUncovered,
  uncoveredEntryPriceEur: t.uncoveredEntryPrice,
});

/**
 * A memoized `realizationsFor(strategy)` over the given records — the recomputed
 * per-sell EUR realizations the engine looks gains up in, one map per cost-basis
 * strategy, exactly as the service supplies them (treating `price` as already
 * EUR, which the service's FX conversion has done by the time rows reach here).
 */
export function realizationsBuilder(
  transactions: readonly TransactionRecord[],
): (strategy: CostBasisStrategy) => ReadonlyMap<string, SellRealizationEur> {
  const cache = new Map<CostBasisStrategy, ReadonlyMap<string, SellRealizationEur>>();
  return (strategy) => {
    let map = cache.get(strategy);
    if (!map) {
      map = new Map(realizedSellsEur(transactions.map(toTaxable), strategy).map((r) => [r.id, r]));
      cache.set(strategy, map);
    }
    return map;
  };
}

/** The Vienna tax year of a record timestamp (the engine's bucketing rule). */
export const yearOf = (at: Date): number => viennaYearOf(at.toISOString());

/**
 * A `categoryOf(assetId)` over an explicit asset-type map (default `etf` →
 * Sonstige), routed through the real {@link dePotCategoryForAssetType} so the
 * `stock → aktien` rule is exercised too.
 */
export function categoryOfBuilder(
  assetType: Record<string, string> = {},
): (assetId: string) => DePotCategory {
  return (assetId) => dePotCategoryForAssetType(assetType[assetId] ?? 'etf');
}

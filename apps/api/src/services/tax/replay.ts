import type { Database } from '../../data/db';
import {
  createCashMovementRepository,
  insertReconciledCashMovementsInTransaction,
} from '../../data/repositories/cashMovementRepository';
import type {
  CashMovementRecord,
  NewCashMovement,
} from '../../data/repositories/cashMovementRepository';
import { createCashSourceRepository } from '../../data/repositories/cashSourceRepository';
import { createPortfolioRepository } from '../../data/repositories/portfolioRepository';
import { createPortfolioSettingsRepository } from '../../data/repositories/portfolioSettingsRepository';
import { createTaxRepository } from '../../data/repositories/taxRepository';
import { createTransactionRepository } from '../../data/repositories/transactionRepository';
import type { TransactionRecord } from '../../data/repositories/transactionRepository';
import type { AssetRow } from '../../data/schema';
import {
  InsufficientCashError,
  projectCashLedgerBySource,
  type SourcedCashMovement,
} from '../../domain/cashLedger';
import {
  dePotCategoryForAssetType,
  floorCents,
  realizedSellsEur,
  taxMovementForDelta,
  type CostBasisStrategy,
  type SellRealizationEur,
  type TaxableTransaction,
} from '../../domain/tax';
import {
  heldForYear,
  liveDerivableYears,
  liveRegimeOf,
  settleLiveYears,
  viennaYearOfDate,
  type LiveRegime,
  type LiveYearSettlement,
} from './livingYear';
import {
  activeCustomParams,
  PORTFOLIO_SETTING_KEY_TAX,
  resolveEffectiveTaxSettings,
} from './settings';

/**
 * Historical EUR conversion supplied by the rehydration caller. The callback
 * is deliberately outside the transaction contract: provider/cache I/O must
 * complete before the caller chooses to commit the restored graph.
 */
export type TaxReplayToEur = (amount: number, currency: string, day: string) => Promise<number>;

export interface ReplayRestoredTaxStateInput {
  userId: string;
  /** The exact restored portfolios whose money rows should be replayed. */
  portfolioIds: readonly string[];
  /** Timestamp assigned to corrections created by this replay. */
  now: Date;
  toEur: TaxReplayToEur;
}

export interface ReplayedDeYearState {
  allowanceUsedEur: number;
  allowanceRemainingEur: number;
  aktienPotInEur: number;
  aktienPotOutEur: number;
  sonstigePotInEur: number;
  sonstigePotOutEur: number;
  kapestEur: number;
  soliEur: number;
}

export interface ReplayedTaxYearState {
  year: number;
  /** Automatic rows are always live; manual-only state remains literal. */
  derivation: 'live' | 'manual';
  /** Engine tax held after replay and any correction inserted by this call. */
  heldEur: number;
  /** The state the normal engine considers settled after replay. */
  targetEur: number;
  /** DE pot/allowance state when the year is derived under DE. */
  de: ReplayedDeYearState | null;
}

export interface ReplayedTaxPortfolioState {
  portfolioId: string;
  effectiveRegime: 'none' | 'manual_per_trade' | 'AT' | 'DE' | 'FI' | 'custom';
  years: ReplayedTaxYearState[];
}

export interface ReplayedTaxState {
  portfolios: ReplayedTaxPortfolioState[];
}

const LIVE_CORRECTION_NOTES = {
  none: 'Tax year correction (tax tracking off)',
  AT: 'Live tax correction (AT)',
  DE: 'Live tax correction (DE)',
  FI: 'Live tax correction (FI)',
  custom: 'Live tax correction (custom rules)',
} as const;

const regimeLabel = (regime: LiveRegime): ReplayedTaxPortfolioState['effectiveRegime'] => {
  if (regime.kind === 'none') return 'none';
  if (regime.kind === 'manual') return 'manual_per_trade';
  if (regime.kind === 'custom') return 'custom';
  return regime.country;
};

const correctionNote = (regime: Exclude<LiveRegime, { kind: 'manual' }>): string => {
  if (regime.kind === 'none') return LIVE_CORRECTION_NOTES.none;
  if (regime.kind === 'custom') return LIVE_CORRECTION_NOTES.custom;
  return LIVE_CORRECTION_NOTES[regime.country];
};

const deState = (state: NonNullable<LiveYearSettlement['deState']>): ReplayedDeYearState => ({
  allowanceUsedEur: floorCents(state.outcome.allowanceUsedEur),
  allowanceRemainingEur: floorCents(state.outcome.allowanceRemainingEur),
  aktienPotInEur: floorCents(state.potIns.aktienEur),
  aktienPotOutEur: floorCents(state.outcome.aktienPotOutEur),
  sonstigePotInEur: floorCents(state.potIns.sonstigeEur),
  sonstigePotOutEur: floorCents(state.outcome.sonstigePotOutEur),
  kapestEur: state.outcome.kapestEur,
  soliEur: state.outcome.soliEur,
});

const toSourcedMovement = (
  movement: Pick<CashMovementRecord, 'kind' | 'amountEur' | 'executedAt' | 'sourceId'>,
): SourcedCashMovement => ({
  kind: movement.kind,
  amountEur: movement.amountEur,
  occurredAt: movement.executedAt.toISOString(),
  sourceId: movement.sourceId,
});

async function taxableTransactions(
  transactions: readonly TransactionRecord[],
  assetsById: ReadonlyMap<string, AssetRow>,
  toEur: TaxReplayToEur,
): Promise<TaxableTransaction[]> {
  const neededAssetIds = new Set(
    transactions.filter((row) => row.side === 'sell').map((row) => row.assetId),
  );
  return Promise.all(
    transactions
      .filter((row) => neededAssetIds.has(row.assetId))
      .map(async (row): Promise<TaxableTransaction> => {
        const asset = assetsById.get(row.assetId);
        if (!asset) {
          throw new Error(`Tax replay: restored transaction ${row.id} references a missing asset`);
        }
        const day = row.executedAt.toISOString().slice(0, 10);
        return {
          id: row.id,
          assetId: row.assetId,
          side: row.side,
          quantity: row.quantity,
          priceEur: await toEur(row.price, asset.currency, day),
          feeEur: await toEur(row.fee, asset.currency, day),
          executedAt: row.executedAt.toISOString(),
          // Storage-quantum shortfalls need no restore-side waiver: the shared
          // domain replay bounds them per contributing row itself (#917).
          allowUncovered: row.allowUncovered,
          uncoveredEntryPriceEur:
            row.uncoveredEntryPrice === null
              ? null
              : await toEur(row.uncoveredEntryPrice, asset.currency, day),
        };
      }),
  );
}

const realizationsById = (
  rows: readonly TaxableTransaction[],
  strategy: CostBasisStrategy = 'moving-average',
): Map<string, SellRealizationEur> =>
  new Map(realizedSellsEur(rows, strategy).map((row) => [row.id, row]));

/**
 * Reconstruct the tax engine state of restored portfolios inside an already
 * open caller transaction.
 *
 * This entry point intentionally accepts the transaction itself and never
 * opens, commits, or rolls one back. Every repository below is constructed
 * against that executor. The restored source rows are re-read on every call;
 * living-year reconciliation therefore converges: after the first correction
 * is inserted, a second call sees the updated held amount and inserts nothing.
 */
export async function replayRestoredTaxState(
  tx: Database,
  input: ReplayRestoredTaxStateInput,
): Promise<ReplayedTaxState> {
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error('Tax replay: now must be a valid date');
  }

  const portfolioIds = [...new Set(input.portfolioIds)].sort();
  const portfolioRepo = createPortfolioRepository(tx);
  const settingsRepo = createPortfolioSettingsRepository(tx);
  const transactionRepo = createTransactionRepository(tx);
  const taxRepo = createTaxRepository(tx);
  const movementRepo = createCashMovementRepository(tx);
  const sourceRepo = createCashSourceRepository(tx);
  const userDefault = await taxRepo.getUserTaxSettings(input.userId);
  const portfolios: ReplayedTaxPortfolioState[] = [];

  for (const portfolioId of portfolioIds) {
    if (!(await portfolioRepo.findByIdForUser(input.userId, portfolioId))) {
      throw new Error(`Tax replay: restored portfolio ${portfolioId} is not owned by the user`);
    }

    const [rawOverride, transactions, dividends, initialMovements] = await Promise.all([
      settingsRepo.getSetting(portfolioId, PORTFOLIO_SETTING_KEY_TAX),
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      movementRepo.listForPortfolio(portfolioId),
    ]);
    const settings = resolveEffectiveTaxSettings(userDefault, rawOverride);
    const regime = liveRegimeOf(settings, activeCustomParams);
    const assetIds = [
      ...new Set([
        ...transactions.map((row) => row.assetId),
        ...dividends.map((row) => row.assetId),
      ]),
    ];
    const assetsById = new Map(
      (await portfolioRepo.assetsByIds(assetIds)).map((row) => [row.id, row]),
    );
    if (assetsById.size !== assetIds.length) {
      throw new Error(`Tax replay: portfolio ${portfolioId} references a missing asset`);
    }

    const taxables = await taxableTransactions(transactions, assetsById, input.toEur);
    const movingAverage = realizationsById(taxables);
    const fifo = realizationsById(taxables, 'fifo');
    const categoryOf = (assetId: string) => {
      const asset = assetsById.get(assetId);
      if (!asset) throw new Error(`Tax replay: asset ${assetId} is unavailable`);
      return dePotCategoryForAssetType(asset.type);
    };
    const liveYears =
      regime.kind === 'manual'
        ? []
        : liveDerivableYears(
            { transactions, dividendRows: dividends, yearOf: viennaYearOfDate },
            initialMovements,
          );
    const settlements =
      regime.kind === 'manual'
        ? []
        : settleLiveYears({
            regime,
            view: {
              transactions,
              dividendRows: dividends,
              realizationsFor: (requested) => (requested === 'fifo' ? fifo : movingAverage),
              categoryOf,
              yearOf: viennaYearOfDate,
            },
            years: liveYears,
            heldOf: (year) => heldForYear(transactions, dividends, initialMovements, year),
          });

    let movements: CashMovementRecord[] = [...initialMovements];
    if (
      regime.kind !== 'manual' &&
      settlements.some((settlement) => settlement.correctionDeltaEur !== 0)
    ) {
      const main = (await sourceRepo.listForPortfolio(portfolioId, { includeArchived: true })).find(
        (source) => source.isMain,
      );
      if (!main) {
        throw new Error(`Tax replay: restored portfolio ${portfolioId} has no Main cash source`);
      }

      await insertReconciledCashMovementsInTransaction(tx, portfolioId, (fresh) => {
        const existing = fresh.map(toSourcedMovement);
        const posted: NewCashMovement[] = [];
        for (const settlement of settlements) {
          // Match the normal read-path reconciler's stale-derivation guard:
          // only settle against the exact held state used above.
          const heldAtDerivation = floorCents(
            settlement.targetAfterEur - settlement.correctionDeltaEur,
          );
          const heldNow = heldForYear(transactions, dividends, fresh, settlement.year);
          if (heldNow !== heldAtDerivation) continue;

          const spec = taxMovementForDelta(settlement.correctionDeltaEur);
          if (!spec) continue;
          const movement = {
            sourceId: main.id,
            kind: spec.kind,
            amountEur: spec.amountEur,
            executedAt: input.now,
            note: correctionNote(regime),
            taxYear: settlement.year,
          } as const;
          if (movement.kind === 'tax_withholding') {
            try {
              projectCashLedgerBySource([
                ...existing,
                ...posted.map(toSourcedMovement),
                toSourcedMovement(movement),
              ]);
            } catch (error) {
              if (error instanceof InsufficientCashError) continue;
              throw error;
            }
          }
          posted.push(movement);
        }
        return posted;
      });
      // The reconciler re-read under its advisory lock. Re-read again so the
      // returned state includes exactly the movements committed in this same
      // caller transaction, including a deliberately deferred withholding.
      movements = await movementRepo.listForPortfolio(portfolioId);
    }

    const settlementByYear = new Map(
      settlements.map((settlement) => [settlement.year, settlement]),
    );
    const allYears = new Set<number>();
    for (const row of transactions) {
      if (row.side === 'sell') allYears.add(viennaYearOfDate(row.executedAt));
    }
    for (const row of dividends) allYears.add(viennaYearOfDate(row.executedAt));
    for (const movement of movements) {
      if (movement.taxYear !== null) allYears.add(movement.taxYear);
    }
    for (const year of liveYears) allYears.add(year);
    const years = [...allYears]
      .sort((a, b) => a - b)
      .map((year): ReplayedTaxYearState => {
        const heldEur = heldForYear(transactions, dividends, movements, year);
        const live = settlementByYear.get(year);
        if (live) {
          return {
            year,
            derivation: 'live',
            heldEur,
            targetEur: live.targetAfterEur,
            de: live.deState ? deState(live.deState) : null,
          };
        }
        return {
          year,
          derivation: 'manual',
          heldEur,
          targetEur: heldEur,
          de: null,
        };
      });

    portfolios.push({
      portfolioId,
      effectiveRegime: regimeLabel(regime),
      years,
    });
  }

  return { portfolios };
}

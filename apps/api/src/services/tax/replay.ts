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
  viennaYearOf,
  TAX_COUNTRY_DE,
  type CostBasisStrategy,
  type SellRealizationEur,
  type TaxableTransaction,
} from '../../domain/tax';
import {
  buildFrozenComponentState,
  engineTaxedYears,
  frozenTargetForYear,
  heldForYear,
  lockedResidueForYear,
  viennaYearOfDate,
} from './closedSettlement';
import { deYearStateForYear, portfolioHasDeRows, portfolioHasFiRows } from './countryState';
import { customParamsKey, portfolioHasCustomRows } from './customState';
import {
  closedYearSlice,
  openDerivableYears,
  openRegimeOf,
  settleOpenYears,
  type OpenRegime,
  type OpenYearSettlement,
} from './openYear';
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
  /** The replay boundary's clock; determines the current Vienna/open tax year. */
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
  /** Calendar state; a manual regime can keep an open calendar year frozen. */
  lifecycle: 'open' | 'closed';
  /** `live` means settleOpenYears derived the target; `frozen` preserves locked history. */
  derivation: 'live' | 'frozen';
  /** Engine tax held after replay and any correction inserted by this call. */
  heldEur: number;
  /** The state the normal engine considers settled after replay. */
  targetEur: number;
  /** Standalone frozen-component target (AT + DE + FI + custom groups). */
  frozenTargetEur: number;
  /** Present for frozen state: held minus the standalone decomposition. */
  lockedResidueEur: number | null;
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

const OPEN_CORRECTION_NOTES = {
  none: 'Tax year correction (tax tracking off)',
  AT: 'Live tax correction (AT)',
  DE: 'Live tax correction (DE)',
  FI: 'Live tax correction (FI)',
  custom: 'Live tax correction (custom rules)',
} as const;

const regimeLabel = (regime: OpenRegime): ReplayedTaxPortfolioState['effectiveRegime'] => {
  if (regime.kind === 'none') return 'none';
  if (regime.kind === 'manual') return 'manual_per_trade';
  if (regime.kind === 'custom') return 'custom';
  return regime.country;
};

const correctionNote = (regime: Exclude<OpenRegime, { kind: 'manual' }>): string => {
  if (regime.kind === 'none') return OPEN_CORRECTION_NOTES.none;
  if (regime.kind === 'custom') return OPEN_CORRECTION_NOTES.custom;
  return OPEN_CORRECTION_NOTES[regime.country];
};

const deState = (state: NonNullable<OpenYearSettlement['deState']>): ReplayedDeYearState => ({
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
 * open-year reconciliation therefore converges: after the first correction is
 * inserted, a second call sees the updated held amount and inserts nothing.
 * Closed years are never re-taxed—their held-vs-frozen gap is reconstructed as
 * the same locked residue the normal mutation paths preserve.
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
  const currentYear = viennaYearOf(input.now.toISOString());
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
    const regime = openRegimeOf(settings, activeCustomParams);
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
    const involveDe = portfolioHasDeRows(transactions, dividends);
    const involveFi = portfolioHasFiRows(transactions, dividends);
    const involveCustom = portfolioHasCustomRows(transactions, dividends);
    const frozen = buildFrozenComponentState({
      transactions,
      dividendRows: dividends,
      realizations: movingAverage,
      fifoRealizations: fifo,
      categoryOf,
      involveDe,
      involveFi,
      involveCustom,
    });

    const openFrom = regime.kind === 'manual' ? Number.POSITIVE_INFINITY : currentYear;
    const openYears =
      regime.kind === 'manual'
        ? []
        : openDerivableYears(
            { transactions, dividendRows: dividends, yearOf: viennaYearOfDate },
            initialMovements,
            openFrom,
          );
    const settlements =
      regime.kind === 'manual'
        ? []
        : settleOpenYears({
            regime,
            view: {
              transactions,
              dividendRows: dividends,
              realizationsFor: (requested) => (requested === 'fifo' ? fifo : movingAverage),
              categoryOf,
              yearOf: viennaYearOfDate,
            },
            years: openYears,
            heldOf: (year) => heldForYear(transactions, dividends, initialMovements, year),
            closedDeEvents:
              regime.kind === 'country' && regime.country === TAX_COUNTRY_DE
                ? closedYearSlice(frozen.deEvents, openFrom)
                : undefined,
            closedCustomEvents:
              regime.kind === 'custom'
                ? closedYearSlice(
                    frozen.customGroups.get(customParamsKey(regime.params))?.eventsByYear ??
                      new Map(),
                    openFrom,
                  )
                : undefined,
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
    const allYears = new Set(engineTaxedYears(transactions, dividends, movements));
    for (const year of openYears) allYears.add(year);
    const years = [...allYears]
      .sort((a, b) => a - b)
      .map((year): ReplayedTaxYearState => {
        const heldEur = heldForYear(transactions, dividends, movements, year);
        const frozenTargetEur = frozenTargetForYear(frozen, year);
        const live = settlementByYear.get(year);
        if (live) {
          return {
            year,
            lifecycle: year >= currentYear ? 'open' : 'closed',
            derivation: 'live',
            heldEur,
            targetEur: live.targetAfterEur,
            frozenTargetEur,
            lockedResidueEur: null,
            de: live.deState ? deState(live.deState) : null,
          };
        }
        const residue = lockedResidueForYear(frozen, movements, year);
        const frozenDe =
          frozen.deEvents.has(year) && involveDe ? deYearStateForYear(frozen.deEvents, year) : null;
        return {
          year,
          lifecycle: year >= currentYear ? 'open' : 'closed',
          derivation: 'frozen',
          heldEur,
          targetEur: floorCents(frozenTargetEur + residue),
          frozenTargetEur,
          lockedResidueEur: residue,
          de: frozenDe ? deState(frozenDe) : null,
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

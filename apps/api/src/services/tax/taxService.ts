import type {
  CashMovement as CashMovementDto,
  CreateDividendRequest,
  CreateDividendResponse,
  Dividend as DividendDto,
  DividendListResponse,
  TaxSettingsResponse,
  TaxYearListResponse,
  TaxYearPosition,
  TaxYearReportResponse,
  TaxYearSummary,
  TransactionInput,
  UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import type { AssetRow } from '../../data/schema';
import type {
  CashMovementRecord,
  CashMovementRepository,
  NewCashMovement,
} from '../../data/repositories/cashMovementRepository';
import type { CashSourceRepository } from '../../data/repositories/cashSourceRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type {
  DividendRecord,
  TaxRepository,
  UserTaxSettingsRecord,
} from '../../data/repositories/taxRepository';
import type {
  BatchCashMovement,
  LinkedCashMovement,
  NewTransactionTax,
  TransactionRecord,
  TransactionRepository,
} from '../../data/repositories/transactionRepository';
import {
  cashBalance,
  cashBalancesBySource,
  InsufficientCashError,
  projectCashLedgerBySource,
  floorCents,
  type SourcedCashMovement,
} from '../../domain/cashLedger';
import {
  atYearTargetEur,
  dePotCategoryForAssetType,
  manualTaxEur,
  realizedSellsEur,
  settleAtYear,
  settleDeYear,
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  taxMovementForDelta,
  viennaYearOf,
  type CostBasisStrategy,
  type DePotCategory,
  type DeTaxableEvent,
  type SellRealizationEur,
  type TaxableTransaction,
  type TaxMovementSpec,
} from '../../domain/tax';
import {
  countrySpecificYears,
  deEventsByYear,
  dePotsInForYear,
  deTargetForYear,
  deYearStateForYear,
  isDeDividend,
  isDeSell,
  portfolioHasDeRows,
  rowEngineCountry,
  type DeRowView,
} from './countryState';
import { badRequest, notFound, unprocessable } from '../../errors';
import type { Logger } from '../../logger';
import { FxRateUnavailableError, type CurrencyService } from '../currency/currencyService';
import type { PortfolioSnapshotService } from '../portfolio/portfolioSnapshots';

/**
 * Tax service (V3-P4, §13.3, issue #331): the orchestration seam between the
 * pure `domain/tax` engine and persistence. Owns Settings → Taxes, the tax
 * planning the portfolio service folds into transaction writes, dividends
 * (record / list / delete), and the per-year report.
 *
 * The load-bearing invariants, all enforced here on the way into the pure
 * engine (§16 2026-07-08 cutover semantics):
 *
 *  - **Recording-time mode.** Every sell/dividend is taxed per the mode active
 *    when it is *recorded*; the applied mode + computed tax freeze onto the
 *    row. Mode switches never recompute existing rows — they apply forward.
 *  - **Trade-date year, Vienna calendar.** Aggregation buckets by the trade's
 *    `executedAt` in Europe/Vienna; the AT pool of a year contains only rows
 *    that were themselves taxed under AT mode. The pool is **per portfolio**
 *    (a portfolio models one depot; the report is portfolio-scoped and tax
 *    cash stays in the portfolio's sources).
 *  - **Append-only settlement.** The tax *held* for a year is derived from
 *    movements (attached settlements mirror their row's frozen tax 1:1;
 *    unattached corrections carry an explicit `taxYear`), and every mutation
 *    that re-shapes history — a backdated buy shifting existing AT gains, a
 *    deletion — posts a correcting movement rather than editing anything.
 *  - **EUR at trade dates.** Realized gains are computed in EUR with each
 *    leg converted at its own trade-date rate (§5.4 historical rates), so FX
 *    moves are part of the taxable gain, as they are for KESt. An
 *    unavailable rate fails loud rather than silently mis-taxing.
 */

export interface TaxServiceDeps {
  taxRepo: TaxRepository;
  transactionRepo: TransactionRepository;
  cashMovementRepo: CashMovementRepository;
  cashSourceRepo: CashSourceRepository;
  portfolioRepo: PortfolioRepository;
  currencyService: CurrencyService;
  /** The V5-P1 snapshot layer (issue #553): dividend writes invalidate through it. */
  snapshots: PortfolioSnapshotService;
  logger?: Logger;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

/** The tax outcome planned for one transaction input (parallel to the batch). */
export interface PlannedRowTax {
  /** Frozen onto the row (null on buys — they are not taxed events). */
  tax: NewTransactionTax | null;
  /** The row's own settlement movement, written atomically with it (or null). */
  movement: LinkedCashMovement | null;
}

/** The full tax plan for one transaction batch. */
export interface TransactionTaxPlan {
  /** Per-input outcome, in input order. */
  rows: PlannedRowTax[];
  /** Unattached year corrections the batch necessitates (backdated buys). */
  extras: BatchCashMovement[];
  /**
   * Every proposed movement (row settlements + extras) in the pure-domain
   * shape, ready to join the caller's solvency replay.
   */
  proposed: SourcedCashMovement[];
}

export interface TransactionTaxPlanInput {
  userId: string;
  portfolioId: string;
  inputs: readonly TransactionInput[];
  /** Asset rows for every batch asset (already visibility-checked). */
  assetsById: ReadonlyMap<string, AssetRow>;
  /**
   * Resolves a cash source for a settlement: the explicit id (must be an
   * active source of this portfolio) or the portfolio's Main. Supplied by the
   * portfolio service so both share one resolution (and its caching).
   */
  resolveSourceId: (explicitId: string | undefined) => Promise<string>;
}

export interface TaxService {
  /** Settings → Taxes: the caller's mode (+ country); `none` when never set. */
  getSettings(userId: string): Promise<TaxSettingsResponse>;
  /** Update the mode; `country` exactly with `country_specific` (AT | DE). */
  updateSettings(userId: string, input: UpdateTaxSettingsRequest): Promise<TaxSettingsResponse>;
  /** The effective settings as a record (missing row = `none`). */
  getEffectiveSettings(userId: string): Promise<UserTaxSettingsRecord>;
  /**
   * Plan the tax side of a transaction batch (called by the portfolio service
   * after oversell validation, before insert): per-row frozen tax facts +
   * settlement movements, and any unattached year corrections. Pure planning —
   * nothing is written here.
   */
  planTransactionTaxes(input: TransactionTaxPlanInput): Promise<TransactionTaxPlan>;
  /**
   * The corrections deleting a transaction necessitates (posted by the caller
   * after the delete): removing an AT-taxed sell — or a buy that feeds AT
   * sells' averages — re-shapes year pools, and each affected year settles
   * append-only against the simulated post-delete state.
   */
  planTransactionDeleteCorrections(
    portfolioId: string,
    transaction: TransactionRecord,
  ): Promise<NewCashMovement[]>;
  /**
   * Record a dividend (V3-P4c): gross EUR into a source, tax-mode aware.
   * `opts.source` is the V5-P0c source tag stamped on the dividend and its cash
   * movements — `manual` by default, `import:<broker>` from the CSV apply path.
   * Server-assigned only (the HTTP body carries no source field).
   */
  recordDividend(
    userId: string,
    portfolioId: string,
    input: CreateDividendRequest,
    opts?: { source?: string },
  ): Promise<CreateDividendResponse>;
  /** The portfolio's dividends, newest pay date first; optional source-tag filter (V5-P0c). */
  listDividends(
    userId: string,
    portfolioId: string,
    opts?: { source?: string },
  ): Promise<DividendListResponse>;
  /** Delete a dividend; movements cascade, AT years settle append-only. */
  deleteDividend(userId: string, portfolioId: string, dividendId: string): Promise<void>;
  /** Per-year summaries (realized P/L, dividends, taxes), newest first. */
  getYearReports(userId: string, portfolioId: string): Promise<TaxYearListResponse>;
  /** One year with per-position drill-down. */
  getYearReport(userId: string, portfolioId: string, year: number): Promise<TaxYearReportResponse>;
}

/** Movement notes (stored data, mirroring the cash-link note precedent). */
const NOTE_AT_WITHHELD = 'KESt withheld (AT)';
const NOTE_AT_REFUNDED = 'KESt refunded (AT)';
const NOTE_AT_CORRECTION = 'Tax year correction (AT)';
const NOTE_DE_WITHHELD = 'KapESt + Soli withheld (DE)';
const NOTE_DE_REFUNDED = 'KapESt + Soli refunded (DE)';
const NOTE_DE_CORRECTION = 'Tax year correction (DE)';
const NOTE_MANUAL_WITHHELD = 'Tax withheld (manual entry)';

type EngineCountry = typeof TAX_COUNTRY_AT | typeof TAX_COUNTRY_DE;

const settlementNote = (country: EngineCountry, kind: TaxMovementSpec['kind']): string =>
  country === TAX_COUNTRY_DE
    ? kind === 'tax_withholding'
      ? NOTE_DE_WITHHELD
      : NOTE_DE_REFUNDED
    : kind === 'tax_withholding'
      ? NOTE_AT_WITHHELD
      : NOTE_AT_REFUNDED;

const correctionNote = (country: EngineCountry): string =>
  country === TAX_COUNTRY_DE ? NOTE_DE_CORRECTION : NOTE_AT_CORRECTION;

const isTaxMovementKind = (kind: CashMovementRecord['kind']): boolean =>
  kind === 'tax_withholding' || kind === 'tax_refund';

export function createTaxService(deps: TaxServiceDeps): TaxService {
  const { taxRepo, transactionRepo, cashMovementRepo, cashSourceRepo, portfolioRepo } = deps;
  const { currencyService, snapshots } = deps;
  const now = deps.now ?? Date.now;

  // ── Shared plumbing ────────────────────────────────────────────────────────

  async function requireOwnedPortfolio(userId: string, portfolioId: string): Promise<void> {
    const portfolio = await portfolioRepo.findByIdForUser(userId, portfolioId);
    if (!portfolio) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
  }

  async function effectiveSettings(userId: string): Promise<UserTaxSettingsRecord> {
    return (await taxRepo.getUserTaxSettings(userId)) ?? { mode: 'none', country: null };
  }

  const viennaYearOfDate = (at: Date): number => viennaYearOf(at.toISOString());

  /**
   * EUR conversion at each trade's own date (§5.4 historical rates), memoised
   * per (currency, day) so a long history costs one rate lookup per distinct
   * pair. Identity (no lookup) for EUR itself. An unavailable rate maps to
   * the supplied typed error — a silently skipped conversion would mis-tax.
   */
  function createTradeDateConverter(onUnavailable: (currency: string) => Error) {
    const rateCache = new Map<string, Promise<number>>();
    return async (amount: number, currency: string, day: string): Promise<number> => {
      if (currency === currencyService.baseCurrency) return amount;
      const key = `${currency}|${day}`;
      let pending = rateCache.get(key);
      if (!pending) {
        pending = currencyService.getRate(currency, currencyService.baseCurrency, { date: day });
        rateCache.set(key, pending);
      }
      try {
        return amount * (await pending);
      } catch (err) {
        if (err instanceof FxRateUnavailableError) throw onUnavailable(currency);
        throw err;
      }
    };
  }

  /** A pending batch input joined with its temp id (pre-insert planning). */
  interface PendingInput {
    tempId: string;
    input: TransactionInput;
  }

  /**
   * Build the EUR taxable view of `neededAssetIds`' transactions — existing
   * records plus not-yet-inserted batch inputs — each leg converted at its own
   * trade date. The caller picks the needed set; every transaction of a needed
   * asset enters (a sell's average depends on all of its asset's buys).
   */
  async function buildTaxables(
    existing: readonly TransactionRecord[],
    pending: readonly PendingInput[],
    neededAssetIds: ReadonlySet<string>,
    currencyOf: (assetId: string) => string,
    toEur: (amount: number, currency: string, day: string) => Promise<number>,
  ): Promise<TaxableTransaction[]> {
    const taxables: TaxableTransaction[] = [];
    const push = async (
      id: string,
      assetId: string,
      side: 'buy' | 'sell',
      quantity: number,
      price: number,
      fee: number,
      executedAt: string,
      allowUncovered: boolean,
      uncoveredEntryPrice: number | null,
    ): Promise<void> => {
      const currency = currencyOf(assetId);
      const day = executedAt.slice(0, 10);
      taxables.push({
        id,
        assetId,
        side,
        quantity,
        priceEur: await toEur(price, currency, day),
        feeEur: await toEur(fee, currency, day),
        executedAt,
        // Uncovered sell (issue #369): the acknowledgment lets the replay accept
        // an oversell, and the user's native entry price is converted at the
        // sell's own trade date (like every other leg) so the uncovered shares
        // carry a real EUR basis — or, when absent, the sale price → 0 gain.
        allowUncovered,
        uncoveredEntryPriceEur:
          uncoveredEntryPrice == null ? null : await toEur(uncoveredEntryPrice, currency, day),
      });
    };
    for (const t of existing) {
      if (!neededAssetIds.has(t.assetId)) continue;
      await push(
        t.id,
        t.assetId,
        t.side,
        t.quantity,
        t.price,
        t.fee,
        t.executedAt.toISOString(),
        t.allowUncovered,
        t.uncoveredEntryPrice,
      );
    }
    for (const { tempId, input } of pending) {
      if (!neededAssetIds.has(input.assetId)) continue;
      await push(
        tempId,
        input.assetId,
        input.side,
        input.quantity,
        input.price,
        input.fee,
        new Date(input.executedAt).toISOString(),
        input.side === 'sell' ? (input.allowUncovered ?? false) : false,
        input.side === 'sell' && input.allowUncovered ? (input.uncoveredEntryPrice ?? null) : null,
      );
    }
    return taxables;
  }

  const realizationsById = (
    taxables: readonly TaxableTransaction[],
    strategy: CostBasisStrategy = 'moving-average',
  ): Map<string, SellRealizationEur> =>
    new Map(realizedSellsEur(taxables, strategy).map((r) => [r.id, r]));

  /** The country the ACTIVE `country_specific` settings tax new rows under. */
  const effectiveCountry = (settings: UserTaxSettingsRecord): EngineCountry =>
    settings.country === TAX_COUNTRY_DE ? TAX_COUNTRY_DE : TAX_COUNTRY_AT;

  /** A stored 2-char country narrowed to the contract enum (`AT` | `DE` | null). */
  const toContractCountry = (country: string | null): EngineCountry | null =>
    country === TAX_COUNTRY_AT || country === TAX_COUNTRY_DE ? country : null;

  /** DE pot category from a preloaded asset map; a miss is a programming error. */
  function categoryLookup(assetsById: ReadonlyMap<string, AssetRow>) {
    return (assetId: string): DePotCategory => {
      const asset = assetsById.get(assetId);
      if (!asset) throw new Error(`Tax engine: asset ${assetId} missing while classifying`);
      return dePotCategoryForAssetType(asset.type);
    };
  }

  /** Assemble the {@link DeRowView} the countryState derivations run over. */
  function buildDeView(
    transactions: readonly TransactionRecord[],
    dividendRows: readonly DividendRecord[],
    deRealizations: ReadonlyMap<string, SellRealizationEur>,
    assetsById: ReadonlyMap<string, AssetRow>,
  ): DeRowView {
    return {
      transactions,
      dividendRows,
      deRealizations,
      categoryOf: categoryLookup(assetsById),
      yearOf: viennaYearOfDate,
    };
  }

  /**
   * The tax currently **held** for one Vienna year of one portfolio: the sum
   * of the frozen tax on the year's AT rows (their attached settlement
   * movements mirror those 1:1 — created atomically, immutable, cascading
   * together) plus the unattached year corrections among the movements.
   * Manual-mode rows are excluded: the AT pool contains only rows taxed under
   * AT mode (§16), and manual withholdings are never refunded by the engine.
   */
  function heldForYear(
    transactions: readonly TransactionRecord[],
    dividendRows: readonly DividendRecord[],
    movements: readonly CashMovementRecord[],
    year: number,
  ): number {
    let held = 0;
    for (const t of transactions) {
      if (t.side !== 'sell' || t.taxMode !== 'country_specific') continue;
      if (viennaYearOfDate(t.executedAt) !== year) continue;
      held += t.taxAmountEur ?? 0;
    }
    for (const d of dividendRows) {
      if (d.taxMode !== 'country_specific') continue;
      if (viennaYearOfDate(d.executedAt) !== year) continue;
      held += d.taxAmountEur ?? 0;
    }
    for (const m of movements) {
      if (!isTaxMovementKind(m.kind) || m.taxYear !== year) continue;
      if (m.transactionId !== null || m.dividendId !== null) continue;
      held += -m.amountEur;
    }
    return floorCents(held);
  }

  /**
   * The year's already-persisted AT pool inputs, gains recomputed. DE-frozen
   * rows are NOT part of the AT pool (V5-P4): they enter the year through the
   * DE target instead, so both countries' settlements coexist in one year.
   */
  function existingAtPool(
    transactions: readonly TransactionRecord[],
    dividendRows: readonly DividendRecord[],
    realizations: ReadonlyMap<string, SellRealizationEur>,
    year: number,
  ): { existingGainsEur: number[]; existingDividendsEur: number[] } {
    const existingGainsEur: number[] = [];
    for (const t of transactions) {
      if (t.side !== 'sell' || t.taxMode !== 'country_specific' || isDeSell(t)) continue;
      if (viennaYearOfDate(t.executedAt) !== year) continue;
      const realization = realizations.get(t.id);
      if (!realization) {
        throw new Error(`Tax engine: no realization for AT sell ${t.id} (year ${year})`);
      }
      existingGainsEur.push(realization.realizedPnlEur);
    }
    const existingDividendsEur = dividendRows
      .filter(
        (d) =>
          d.taxMode === 'country_specific' &&
          !isDeDividend(d) &&
          viennaYearOfDate(d.executedAt) === year,
      )
      .map((d) => d.grossAmountEur);
    return { existingGainsEur, existingDividendsEur };
  }

  /** The AT component of a year's held-tax target (0 without AT rows). */
  function atTargetForYear(
    transactions: readonly TransactionRecord[],
    dividendRows: readonly DividendRecord[],
    realizations: ReadonlyMap<string, SellRealizationEur>,
    year: number,
  ): number {
    const pool = existingAtPool(transactions, dividendRows, realizations, year);
    let poolEur = 0;
    for (const gain of pool.existingGainsEur) poolEur += gain;
    for (const dividend of pool.existingDividendsEur) poolEur += dividend;
    return atYearTargetEur(poolEur);
  }

  /** Map a settlement spec to the unattached correction movement it posts. */
  function correctionMovement(
    spec: TaxMovementSpec,
    sourceId: string,
    year: number,
    note: string = NOTE_AT_CORRECTION,
  ): NewCashMovement {
    return {
      sourceId,
      kind: spec.kind,
      amountEur: spec.amountEur,
      executedAt: new Date(now()),
      note,
      taxYear: year,
    };
  }

  const fxWriteError = (currency: string): Error =>
    badRequest(
      'Taxing this trade needs a EUR conversion that is currently unavailable for its currency.',
      'TAX_FX_UNAVAILABLE',
      { currency },
    );

  const fxReadError = (currency: string): Error =>
    unprocessable(
      `Exchange rates needed for this report are currently unavailable (${currency}).`,
      'TAX_FX_UNAVAILABLE',
    );

  /** Currency lookup over a preloaded asset map; a miss is a programming error. */
  function currencyLookup(assetsById: ReadonlyMap<string, AssetRow>) {
    return (assetId: string): string => {
      const asset = assetsById.get(assetId);
      if (!asset) throw new Error(`Tax engine: asset ${assetId} missing while converting`);
      return asset.currency;
    };
  }

  async function loadAssets(assetIds: Iterable<string>): Promise<Map<string, AssetRow>> {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0) return new Map();
    return new Map((await portfolioRepo.assetsByIds(ids)).map((r) => [r.id, r]));
  }

  function assetToDto(row: AssetRow): DividendDto['asset'] {
    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      exchange: row.exchange ?? null,
      currency: row.currency,
      type: row.type,
      isCustom: row.ownerId !== null,
    };
  }

  function dividendToDto(record: DividendRecord, asset: AssetRow): DividendDto {
    return {
      id: record.id,
      assetId: record.assetId,
      grossAmountEur: record.grossAmountEur,
      executedAt: record.executedAt.toISOString(),
      note: record.note,
      taxMode: record.taxMode,
      taxCountry: toContractCountry(record.taxCountry),
      taxAmountEur: record.taxAmountEur,
      cashSourceId: record.cashSourceId,
      source: record.source,
      createdAt: record.createdAt.toISOString(),
      asset: assetToDto(asset),
    };
  }

  function movementToDto(r: CashMovementRecord): CashMovementDto {
    return {
      id: r.id,
      kind: r.kind,
      amountEur: r.amountEur,
      sourceId: r.sourceId,
      transactionId: r.transactionId,
      transferId: r.transferId,
      counterpartSourceId: r.counterpartSourceId,
      dividendId: r.dividendId,
      taxYear: r.taxYear,
      executedAt: r.executedAt.toISOString(),
      note: r.note,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    };
  }

  const toDomainMovement = (r: CashMovementRecord): SourcedCashMovement => ({
    kind: r.kind,
    amountEur: r.amountEur,
    occurredAt: r.executedAt.toISOString(),
    sourceId: r.sourceId,
  });

  const newToDomainMovement = (m: NewCashMovement): SourcedCashMovement => ({
    kind: m.kind,
    amountEur: m.amountEur,
    occurredAt: m.executedAt.toISOString(),
    sourceId: m.sourceId,
  });

  /** Per-source solvency replay; 400 when any source would dip negative. */
  function assertCashSolvent(
    existing: readonly SourcedCashMovement[],
    proposed: readonly SourcedCashMovement[],
  ): void {
    try {
      projectCashLedgerBySource([...existing, ...proposed]);
    } catch (err) {
      if (err instanceof InsufficientCashError) {
        throw badRequest('Insufficient cash balance.', 'INSUFFICIENT_CASH', {
          availableEur: err.balanceEur,
          shortfallEur: err.shortfallEur,
          kind: err.movement.kind,
        });
      }
      throw err;
    }
  }

  /** The correction target: unattached settlements post to the Main source. */
  const correctionSourceId = (portfolioId: string): Promise<string> =>
    cashSourceRepo.getOrCreateMain(portfolioId).then((s) => s.id);

  /**
   * Report a history-mutating dividend write to the snapshot layer from its
   * earliest affected day (§16 2026-07-17 rules 5/6).
   */
  async function invalidateHistory(portfolioId: string, fromDay: string): Promise<void> {
    await snapshots.invalidate(portfolioId, fromDay);
  }

  /** ISO day of a Date (UTC). */
  const dayOfDate = (at: Date): string => at.toISOString().slice(0, 10);

  /** Reject manual tax entries wherever the mode does not accept them. */
  function assertManualEntryAllowed(
    settings: UserTaxSettingsRecord,
    input: { taxAmountEur?: number; taxRatePct?: number },
    context: 'sell' | 'buy' | 'dividend',
  ): void {
    const hasEntry = input.taxAmountEur !== undefined || input.taxRatePct !== undefined;
    if (!hasEntry) return;
    if (context === 'buy') {
      throw badRequest('Manual tax entries apply only to sells.', 'TAX_ENTRY_INVALID');
    }
    if (settings.mode !== 'manual_per_trade') {
      throw badRequest(
        'Manual tax entries require the manual-per-trade tax mode.',
        'TAX_ENTRY_NOT_ALLOWED',
      );
    }
  }

  // ── Transaction batch planning ─────────────────────────────────────────────

  async function planTransactionTaxes(
    planInput: TransactionTaxPlanInput,
  ): Promise<TransactionTaxPlan> {
    const { userId, portfolioId, inputs, assetsById, resolveSourceId } = planInput;
    const settings = await effectiveSettings(userId);

    const rows: PlannedRowTax[] = inputs.map((input) => ({
      tax:
        input.side === 'sell' && settings.mode !== 'none'
          ? null // filled below per mode
          : input.side === 'sell'
            ? { mode: 'none', country: null, amountEur: null }
            : null,
      movement: null,
    }));

    for (const input of inputs) {
      assertManualEntryAllowed(settings, input, input.side);
    }
    if (settings.mode === 'none') {
      return { rows, extras: [], proposed: [] };
    }

    const pendingSells: Array<{ index: number; tempId: string; input: TransactionInput }> = [];
    inputs.forEach((input, index) => {
      if (input.side === 'sell') {
        pendingSells.push({ index, tempId: `pending-${index}`, input });
      }
    });

    // ── Manual per trade: literal recording, zero automation ────────────────
    if (settings.mode === 'manual_per_trade') {
      // Realized gains are needed only as the base of a RATE entry; convert
      // only those assets so an amount-only entry never depends on FX.
      const rateAssetIds = new Set(
        pendingSells.filter((p) => p.input.taxRatePct !== undefined).map((p) => p.input.assetId),
      );
      let realizations = new Map<string, SellRealizationEur>();
      if (rateAssetIds.size > 0) {
        // Rate assets come from the batch, so their rows are already loaded.
        const existingOfRateAssets = (
          await Promise.all(
            [...rateAssetIds].map((assetId) => transactionRepo.listForAsset(portfolioId, assetId)),
          )
        ).flat();
        const taxables = await buildTaxables(
          existingOfRateAssets,
          pendingSells.map((p) => ({ tempId: p.tempId, input: p.input })),
          rateAssetIds,
          currencyLookup(assetsById),
          createTradeDateConverter(fxWriteError),
        );
        realizations = realizationsById(taxables);
      }

      const proposed: SourcedCashMovement[] = [];
      for (const { index, tempId, input } of pendingSells) {
        const executedAtIso = new Date(input.executedAt).toISOString();
        const baseEur =
          input.taxRatePct !== undefined ? (realizations.get(tempId)?.realizedPnlEur ?? 0) : 0;
        const taxEur = manualTaxEur({
          taxAmountEur: input.taxAmountEur ?? null,
          taxRatePct: input.taxRatePct ?? null,
          baseEur,
        });
        const row: PlannedRowTax = {
          tax: { mode: 'manual_per_trade', country: null, amountEur: taxEur },
          movement: null,
        };
        if (taxEur !== null && taxEur > 0) {
          const sourceId = await resolveSourceId(input.cashSourceId);
          row.movement = {
            kind: 'tax_withholding',
            amountEur: -taxEur,
            sourceId,
            note: NOTE_MANUAL_WITHHELD,
            taxYear: viennaYearOf(executedAtIso),
          };
          proposed.push({
            kind: 'tax_withholding',
            amountEur: -taxEur,
            occurredAt: executedAtIso,
            sourceId,
          });
        }
        rows[index] = row;
      }
      return { rows, extras: [], proposed };
    }

    // ── Country-specific (AT | DE): the active country's engine settles the
    // new sells; frozen rows keep their own regime, and a year's held tax is
    // always the SUM of both countries' independent targets (§16 cutover) ───
    const country = effectiveCountry(settings);
    const [allTxns, dividendRows, movements] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    const involveDe = country === TAX_COUNTRY_DE || portfolioHasDeRows(allTxns, dividendRows);

    // Years whose pools this batch touches: the years of its sells, plus —
    // when the batch (back)dates buys of an asset — the years of that asset's
    // existing CS sells, whose recomputed gains may have shifted.
    const batchBuyAssets = new Set(inputs.filter((i) => i.side === 'buy').map((i) => i.assetId));
    const affectedYears = new Set<number>(
      pendingSells.map((p) => viennaYearOf(new Date(p.input.executedAt).toISOString())),
    );
    for (const t of allTxns) {
      if (t.side === 'sell' && t.taxMode === 'country_specific' && batchBuyAssets.has(t.assetId)) {
        affectedYears.add(viennaYearOfDate(t.executedAt));
      }
    }
    // DE additions (V5-P4): under FIFO, ANY batch trade of an asset can shift
    // that asset's DE sells' lot consumption (sells consume lots too, unlike
    // the moving average) — and a changed DE year changes its pot-outs, which
    // ripples into every later country-specific year. Close the affected set
    // downstream; a year whose combined target did not move settles to a zero
    // correction and posts nothing.
    if (involveDe) {
      const batchAssets = new Set(inputs.map((i) => i.assetId));
      for (const t of allTxns) {
        if (isDeSell(t) && batchAssets.has(t.assetId)) {
          affectedYears.add(viennaYearOfDate(t.executedAt));
        }
      }
      if (affectedYears.size > 0) {
        const minYear = Math.min(...affectedYears);
        const csYears = countrySpecificYears(allTxns, dividendRows, movements, viennaYearOfDate);
        for (const year of csYears) {
          if (year > minYear) affectedYears.add(year);
        }
      }
    }

    // Assets whose EUR replay the affected pools need: every batch-sell asset,
    // every asset with an existing CS sell in an affected year, and — with DE
    // involved — every DE-sell asset anywhere (the pot chain spans all prior
    // years).
    const neededAssetIds = new Set(pendingSells.map((p) => p.input.assetId));
    for (const t of allTxns) {
      if (t.side !== 'sell' || t.taxMode !== 'country_specific') continue;
      if (affectedYears.has(viennaYearOfDate(t.executedAt)) || (involveDe && isDeSell(t))) {
        neededAssetIds.add(t.assetId);
      }
    }

    // Pools span the whole portfolio, so needed assets may lie outside the
    // batch — load the missing rows for their currencies.
    const mergedAssets = new Map(assetsById);
    const missingAssetIds = [...neededAssetIds].filter((id) => !mergedAssets.has(id));
    if (missingAssetIds.length > 0) {
      for (const [id, row] of await loadAssets(missingAssetIds)) mergedAssets.set(id, row);
    }
    const taxables = await buildTaxables(
      allTxns,
      inputs.map((input, index) => ({ tempId: `pending-${index}`, input })),
      neededAssetIds,
      currencyLookup(mergedAssets),
      createTradeDateConverter(fxWriteError),
    );
    const realizations = realizationsById(taxables);
    const deRealizations = involveDe
      ? realizationsById(taxables, 'fifo')
      : new Map<string, SellRealizationEur>();
    const deView = buildDeView(allTxns, dividendRows, deRealizations, mergedAssets);
    // Pending DE events join the pot chain year by year as the ascending loop
    // settles them, so a later year's pot-ins see the earlier years' new rows.
    const pendingDeEvents = new Map<number, DeTaxableEvent[]>();
    const deEventsWithPending = (): Map<number, DeTaxableEvent[]> =>
      deEventsByYear(deView, pendingDeEvents);

    const extras: BatchCashMovement[] = [];
    const proposed: SourcedCashMovement[] = [];
    const nowIso = new Date(now()).toISOString();

    for (const year of [...affectedYears].sort((a, b) => a - b)) {
      const yearSells = pendingSells
        .filter((p) => viennaYearOf(new Date(p.input.executedAt).toISOString()) === year)
        .sort(
          (a, b) =>
            Date.parse(a.input.executedAt) - Date.parse(b.input.executedAt) || a.index - b.index,
        );
      const heldEur = heldForYear(allTxns, dividendRows, movements, year);

      let correctionDeltaEur: number;
      let newEventDeltasEur: number[];
      if (country === TAX_COUNTRY_AT) {
        // The DE component (frozen DE rows only — an AT batch never adds DE
        // events, but its backdated trades may have re-shaped DE lot bases;
        // the recomputed FIFO realizations already reflect that).
        const deTarget = involveDe ? deTargetForYear(deEventsWithPending(), year) : 0;
        const pool = existingAtPool(allTxns, dividendRows, realizations, year);
        const settlement = settleAtYear({
          ...pool,
          heldEur: floorCents(heldEur - deTarget),
          newEvents: yearSells.map((p) => {
            const realization = realizations.get(p.tempId);
            if (!realization) {
              throw new Error(`Tax engine: no realization for pending sell ${p.tempId}`);
            }
            return { kind: 'sell_gain' as const, amountEur: realization.realizedPnlEur };
          }),
        });
        correctionDeltaEur = settlement.correctionDeltaEur;
        newEventDeltasEur = settlement.newEventDeltasEur;
      } else {
        // DE: the AT component stays put; pots chain over frozen rows plus the
        // already-settled pending events of earlier years.
        const atTarget = atTargetForYear(allTxns, dividendRows, realizations, year);
        const events = deEventsWithPending();
        const potIns = dePotsInForYear(events, year);
        const newEvents: DeTaxableEvent[] = yearSells.map((p) => {
          const realization = deRealizations.get(p.tempId);
          if (!realization) {
            throw new Error(`Tax engine: no FIFO realization for pending sell ${p.tempId}`);
          }
          return {
            kind: 'sell_gain' as const,
            category: deView.categoryOf(p.input.assetId),
            amountEur: realization.realizedPnlEur,
          };
        });
        const settlement = settleDeYear({
          aktienPotInEur: potIns.aktienEur,
          sonstigePotInEur: potIns.sonstigeEur,
          existingEvents: events.get(year) ?? [],
          heldEur: floorCents(heldEur - atTarget),
          newEvents,
        });
        correctionDeltaEur = settlement.correctionDeltaEur;
        newEventDeltasEur = settlement.newEventDeltasEur;
        if (newEvents.length > 0) pendingDeEvents.set(year, newEvents);
      }

      const correctionSpec = taxMovementForDelta(correctionDeltaEur);
      if (correctionSpec) {
        const sourceId = await correctionSourceId(portfolioId);
        extras.push({
          kind: correctionSpec.kind,
          amountEur: correctionSpec.amountEur,
          sourceId,
          note: correctionNote(country),
          taxYear: year,
          executedAt: new Date(now()),
        });
        proposed.push({
          kind: correctionSpec.kind,
          amountEur: correctionSpec.amountEur,
          occurredAt: nowIso,
          sourceId,
        });
      }

      for (const [i, pendingSell] of yearSells.entries()) {
        const deltaEur = newEventDeltasEur[i]!;
        const executedAtIso = new Date(pendingSell.input.executedAt).toISOString();
        const row: PlannedRowTax = {
          tax: { mode: 'country_specific', country, amountEur: deltaEur },
          movement: null,
        };
        const spec = taxMovementForDelta(deltaEur);
        if (spec) {
          const sourceId = await resolveSourceId(pendingSell.input.cashSourceId);
          row.movement = {
            kind: spec.kind,
            amountEur: spec.amountEur,
            sourceId,
            note: settlementNote(country, spec.kind),
            taxYear: year,
          };
          proposed.push({
            kind: spec.kind,
            amountEur: spec.amountEur,
            occurredAt: executedAtIso,
            sourceId,
          });
        }
        rows[pendingSell.index] = row;
      }
    }

    return { rows, extras, proposed };
  }

  // ── Delete corrections ─────────────────────────────────────────────────────

  async function planTransactionDeleteCorrections(
    portfolioId: string,
    transaction: TransactionRecord,
  ): Promise<NewCashMovement[]> {
    const isCsSell = transaction.side === 'sell' && transaction.taxMode === 'country_specific';
    const [allTxns, dividendRows, movements] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);

    // Simulate the post-delete world: the row and its movements are gone.
    const remainingTxns = allTxns.filter((t) => t.id !== transaction.id);
    const remainingMovements = movements.filter((m) => m.transactionId !== transaction.id);

    const deletedWasDe = isCsSell && rowEngineCountry(transaction.taxCountry) === TAX_COUNTRY_DE;
    const involveDe = deletedWasDe || portfolioHasDeRows(remainingTxns, dividendRows);

    // Affected years: the deleted CS sell's own year, plus — when a buy is
    // removed — the years of its asset's CS sells (their recomputed gains
    // shift). With DE involved, ANY removed trade of the asset can shift its
    // DE sells' lot consumption (FIFO), and a changed DE year changes its
    // pot-outs — which ripples into every later country-specific year.
    const affectedYears = new Set<number>();
    if (isCsSell) affectedYears.add(viennaYearOfDate(transaction.executedAt));
    if (transaction.side === 'buy') {
      for (const t of remainingTxns) {
        if (
          t.assetId === transaction.assetId &&
          t.side === 'sell' &&
          t.taxMode === 'country_specific'
        ) {
          affectedYears.add(viennaYearOfDate(t.executedAt));
        }
      }
    }
    if (involveDe) {
      for (const t of remainingTxns) {
        if (isDeSell(t) && t.assetId === transaction.assetId) {
          affectedYears.add(viennaYearOfDate(t.executedAt));
        }
      }
      if (affectedYears.size > 0) {
        const minYear = Math.min(...affectedYears);
        const csYears = countrySpecificYears(
          remainingTxns,
          dividendRows,
          remainingMovements,
          viennaYearOfDate,
        );
        for (const year of csYears) {
          if (year > minYear) affectedYears.add(year);
        }
      }
    }
    if (affectedYears.size === 0) return [];

    const neededAssetIds = new Set<string>();
    for (const t of remainingTxns) {
      if (t.side !== 'sell' || t.taxMode !== 'country_specific') continue;
      if (affectedYears.has(viennaYearOfDate(t.executedAt)) || (involveDe && isDeSell(t))) {
        neededAssetIds.add(t.assetId);
      }
    }

    let realizations = new Map<string, SellRealizationEur>();
    let deRealizations = new Map<string, SellRealizationEur>();
    let assetsById = new Map<string, AssetRow>();
    if (neededAssetIds.size > 0) {
      assetsById = await loadAssets(remainingTxns.map((t) => t.assetId));
      const taxables = await buildTaxables(
        remainingTxns,
        [],
        neededAssetIds,
        currencyLookup(assetsById),
        createTradeDateConverter(fxWriteError),
      );
      realizations = realizationsById(taxables);
      if (involveDe) deRealizations = realizationsById(taxables, 'fifo');
    }
    const deView = buildDeView(remainingTxns, dividendRows, deRealizations, assetsById);
    const frozenDeEvents = involveDe ? deEventsByYear(deView) : new Map<number, DeTaxableEvent[]>();

    // Each year settles append-only against its combined post-delete target
    // (AT pool target + DE year target — the two components never mix).
    const corrections: NewCashMovement[] = [];
    for (const year of [...affectedYears].sort((a, b) => a - b)) {
      const targetEur = floorCents(
        atTargetForYear(remainingTxns, dividendRows, realizations, year) +
          (involveDe ? deTargetForYear(frozenDeEvents, year) : 0),
      );
      const heldEur = heldForYear(remainingTxns, dividendRows, remainingMovements, year);
      const spec = taxMovementForDelta(floorCents(targetEur - heldEur));
      if (spec) {
        corrections.push(
          correctionMovement(
            spec,
            await correctionSourceId(portfolioId),
            year,
            correctionNote(deletedWasDe ? TAX_COUNTRY_DE : TAX_COUNTRY_AT),
          ),
        );
      }
    }
    return corrections;
  }

  // ── Dividends ──────────────────────────────────────────────────────────────

  async function resolveFlowSource(portfolioId: string, sourceId: string | undefined) {
    if (sourceId === undefined) return cashSourceRepo.getOrCreateMain(portfolioId);
    const source = await cashSourceRepo.findByIdForPortfolio(portfolioId, sourceId);
    if (!source) throw notFound('Cash source not found.', 'CASH_SOURCE_NOT_FOUND');
    if (source.archivedAt) {
      throw badRequest(
        'This cash source is archived. Restore it before recording new movements.',
        'CASH_SOURCE_ARCHIVED',
      );
    }
    return source;
  }

  async function cashBalances(portfolioId: string): Promise<{
    balanceBySource: Map<string, number>;
    totalEur: number;
  }> {
    const records = await cashMovementRepo.listForPortfolio(portfolioId);
    const raw = cashBalancesBySource(records.map(toDomainMovement));
    const balanceBySource = new Map<string, number>();
    for (const [sourceId, balance] of raw) balanceBySource.set(sourceId, floorCents(balance));
    return { balanceBySource, totalEur: floorCents(cashBalance(records.map(toDomainMovement))) };
  }

  async function recordDividend(
    userId: string,
    portfolioId: string,
    input: CreateDividendRequest,
    opts?: { source?: string },
  ): Promise<CreateDividendResponse> {
    await requireOwnedPortfolio(userId, portfolioId);
    // Source tag (V5-P0c): `manual` unless the CSV apply path passes a broker.
    // (`source` below is the cash SOURCE — a different concept, V3-P3.)
    const sourceTag = opts?.source ?? 'manual';

    const assetRows = await portfolioRepo.assetsByIds([input.assetId]);
    const asset = assetRows[0];
    if (!asset || (asset.ownerId !== null && asset.ownerId !== userId)) {
      throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
    }
    // A dividend belongs to a *holding* (§13.3 V3-P4c): the asset must have
    // been transacted in this portfolio.
    const assetTxns = await transactionRepo.listForAsset(portfolioId, input.assetId);
    if (assetTxns.length === 0) {
      throw badRequest(
        'Dividends can only be recorded on assets this portfolio holds.',
        'DIVIDEND_ASSET_NOT_HELD',
      );
    }

    const settings = await effectiveSettings(userId);
    assertManualEntryAllowed(settings, input, 'dividend');

    const source = await resolveFlowSource(portfolioId, input.cashSourceId);
    const executedAt = input.executedAt ? new Date(input.executedAt) : new Date(now());
    const executedAtIso = executedAt.toISOString();
    const year = viennaYearOf(executedAtIso);
    // Cash is whole-cent money (#322): quantize the entered gross.
    const grossEur = floorCents(input.grossAmountEur);
    if (grossEur <= 0) {
      throw badRequest('The dividend amount rounds to €0.00.', 'DIVIDEND_AMOUNT_TOO_SMALL');
    }

    let taxAmountEur: number | null = null;
    let taxCountry: string | null = null;
    let rowSettlement: TaxMovementSpec | null = null;
    const extras: NewCashMovement[] = [];

    if (settings.mode === 'manual_per_trade') {
      taxAmountEur = manualTaxEur({
        taxAmountEur: input.taxAmountEur ?? null,
        taxRatePct: input.taxRatePct ?? null,
        baseEur: grossEur,
      });
      if (taxAmountEur !== null && taxAmountEur > 0) {
        rowSettlement = { kind: 'tax_withholding', amountEur: -taxAmountEur };
      }
    } else if (settings.mode === 'country_specific') {
      const country = effectiveCountry(settings);
      taxCountry = country;
      const [allTxns, dividendRows, movements] = await Promise.all([
        transactionRepo.listForPortfolio(portfolioId),
        taxRepo.listForPortfolio(portfolioId),
        cashMovementRepo.listForPortfolio(portfolioId),
      ]);
      const involveDe = country === TAX_COUNTRY_DE || portfolioHasDeRows(allTxns, dividendRows);

      const neededAssetIds = new Set<string>();
      for (const t of allTxns) {
        if (t.side !== 'sell' || t.taxMode !== 'country_specific') continue;
        if (viennaYearOfDate(t.executedAt) === year || (involveDe && isDeSell(t))) {
          neededAssetIds.add(t.assetId);
        }
      }
      let realizations = new Map<string, SellRealizationEur>();
      let deRealizations = new Map<string, SellRealizationEur>();
      let assetsById = new Map<string, AssetRow>();
      if (neededAssetIds.size > 0) {
        assetsById = await loadAssets(allTxns.map((t) => t.assetId));
        const taxables = await buildTaxables(
          allTxns,
          [],
          neededAssetIds,
          currencyLookup(assetsById),
          createTradeDateConverter(fxWriteError),
        );
        realizations = realizationsById(taxables);
        if (involveDe) deRealizations = realizationsById(taxables, 'fifo');
      }
      const deView = buildDeView(allTxns, dividendRows, deRealizations, assetsById);
      const frozenDeEvents = involveDe
        ? deEventsByYear(deView)
        : new Map<number, DeTaxableEvent[]>();
      const heldEur = heldForYear(allTxns, dividendRows, movements, year);

      let correctionDeltaEur: number;
      let deltaEur: number;
      if (country === TAX_COUNTRY_AT) {
        const deTarget = involveDe ? deTargetForYear(frozenDeEvents, year) : 0;
        const pool = existingAtPool(allTxns, dividendRows, realizations, year);
        const settlement = settleAtYear({
          ...pool,
          heldEur: floorCents(heldEur - deTarget),
          newEvents: [{ kind: 'dividend', amountEur: grossEur }],
        });
        correctionDeltaEur = settlement.correctionDeltaEur;
        deltaEur = settlement.newEventDeltasEur[0]!;
      } else {
        const atTarget = atTargetForYear(allTxns, dividendRows, realizations, year);
        const potIns = dePotsInForYear(frozenDeEvents, year);
        const settlement = settleDeYear({
          aktienPotInEur: potIns.aktienEur,
          sonstigePotInEur: potIns.sonstigeEur,
          existingEvents: frozenDeEvents.get(year) ?? [],
          heldEur: floorCents(heldEur - atTarget),
          newEvents: [{ kind: 'dividend', amountEur: grossEur }],
        });
        correctionDeltaEur = settlement.correctionDeltaEur;
        deltaEur = settlement.newEventDeltasEur[0]!;
      }
      const correctionSpec = taxMovementForDelta(correctionDeltaEur);
      if (correctionSpec) {
        extras.push(
          correctionMovement(
            correctionSpec,
            await correctionSourceId(portfolioId),
            year,
            correctionNote(country),
          ),
        );
      }
      // A backdated DE dividend can consume pot balances earlier years handed
      // down — re-settle every LATER country-specific year against its new
      // combined target (zero-delta years post nothing).
      if (country === TAX_COUNTRY_DE) {
        const newEvent: DeTaxableEvent = { kind: 'dividend', amountEur: grossEur };
        const withNew = deEventsByYear(deView, new Map([[year, [newEvent]]]));
        const csYears = countrySpecificYears(allTxns, dividendRows, movements, viennaYearOfDate);
        for (const y of csYears) {
          if (y <= year) continue;
          const targetEur = floorCents(
            atTargetForYear(allTxns, dividendRows, realizations, y) + deTargetForYear(withNew, y),
          );
          const heldY = heldForYear(allTxns, dividendRows, movements, y);
          const spec = taxMovementForDelta(floorCents(targetEur - heldY));
          if (spec) {
            extras.push(
              correctionMovement(
                spec,
                await correctionSourceId(portfolioId),
                y,
                NOTE_DE_CORRECTION,
              ),
            );
          }
        }
      }
      taxAmountEur = deltaEur;
      rowSettlement = taxMovementForDelta(deltaEur);
    }

    // The gross inflow first, its settlement second (same timestamp — input
    // order breaks the tie, so the inflow funds the withholding), corrections
    // last at "now".
    const movements: (NewCashMovement & { linkDividend?: boolean })[] = [
      {
        sourceId: source.id,
        kind: 'dividend',
        amountEur: grossEur,
        executedAt,
        note: input.note ?? null,
        linkDividend: true,
      },
    ];
    if (rowSettlement) {
      movements.push({
        sourceId: source.id,
        kind: rowSettlement.kind,
        amountEur: rowSettlement.amountEur,
        executedAt,
        note:
          settings.mode === 'manual_per_trade'
            ? NOTE_MANUAL_WITHHELD
            : settlementNote(
                taxCountry === TAX_COUNTRY_DE ? TAX_COUNTRY_DE : TAX_COUNTRY_AT,
                rowSettlement.kind,
              ),
        taxYear: year,
        linkDividend: true,
      });
    }
    movements.push(...extras);

    const existing = await cashMovementRepo.listForPortfolio(portfolioId);
    assertCashSolvent(existing.map(toDomainMovement), movements.map(newToDomainMovement));

    const inserted = await taxRepo.insertDividend(
      portfolioId,
      {
        assetId: input.assetId,
        cashSourceId: source.id,
        grossAmountEur: grossEur,
        executedAt,
        note: input.note ?? null,
        taxMode: settings.mode,
        taxCountry,
        taxAmountEur,
        source: sourceTag,
      },
      movements,
    );
    // Earliest affected day (§16 rule 5): the (possibly backdated) dividend's
    // own day — its gross + settlement legs share it; corrections post at now.
    const affectedFrom = movements
      .map((m) => dayOfDate(m.executedAt))
      .reduce((a, b) => (a < b ? a : b));
    await invalidateHistory(portfolioId, affectedFrom);

    const { balanceBySource, totalEur } = await cashBalances(portfolioId);
    return {
      dividend: dividendToDto(inserted.dividend, asset),
      movements: inserted.movements.map((row) =>
        movementToDto({
          id: row.id,
          portfolioId: row.portfolioId,
          sourceId: row.sourceId,
          kind: row.kind,
          amountEur: Number(row.amountEur),
          transactionId: row.transactionId ?? null,
          transferId: row.transferId ?? null,
          counterpartSourceId: row.counterpartSourceId ?? null,
          dividendId: row.dividendId ?? null,
          taxYear: row.taxYear ?? null,
          executedAt: row.executedAt,
          note: row.note ?? null,
          source: row.source,
          createdAt: row.createdAt,
        }),
      ),
      sourceBalanceEur: balanceBySource.get(source.id) ?? 0,
      balanceEur: totalEur,
    };
  }

  async function listDividends(
    userId: string,
    portfolioId: string,
    opts?: { source?: string },
  ): Promise<DividendListResponse> {
    await requireOwnedPortfolio(userId, portfolioId);
    const all = await taxRepo.listForPortfolio(portfolioId);
    // Source-tag filter (V5-P0c): return only dividends carrying this exact tag.
    const rows = opts?.source ? all.filter((r) => r.source === opts.source) : all;
    const assetsById = await loadAssets(rows.map((r) => r.assetId));
    const dividends = [...rows]
      .sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime() || (a.id < b.id ? 1 : -1))
      .map((r) => {
        const asset = assetsById.get(r.assetId);
        if (!asset) throw new Error(`Asset ${r.assetId} missing while listing dividends`);
        return dividendToDto(r, asset);
      });
    return { dividends };
  }

  async function deleteDividend(
    userId: string,
    portfolioId: string,
    dividendId: string,
  ): Promise<void> {
    await requireOwnedPortfolio(userId, portfolioId);
    const dividend = await taxRepo.findByIdForPortfolio(portfolioId, dividendId);
    if (!dividend) throw notFound('Dividend not found.', 'DIVIDEND_NOT_FOUND');

    const [allTxns, dividendRows, movements] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    const remainingDividends = dividendRows.filter((d) => d.id !== dividendId);
    const remainingMovements = movements.filter((m) => m.dividendId !== dividendId);

    // A country-specific dividend's removal re-settles its year against the
    // remaining rows — and, for a DE dividend, every later CS year: the gross
    // it contributed may have been consuming pot balances that now carry
    // further (the combined AT+DE target catches both components).
    const corrections: NewCashMovement[] = [];
    if (dividend.taxMode === 'country_specific') {
      const year = viennaYearOfDate(dividend.executedAt);
      const deletedWasDe = rowEngineCountry(dividend.taxCountry) === TAX_COUNTRY_DE;
      const involveDe = deletedWasDe || portfolioHasDeRows(allTxns, remainingDividends);

      const affectedYears = new Set<number>([year]);
      if (involveDe) {
        const csYears = countrySpecificYears(
          allTxns,
          remainingDividends,
          remainingMovements,
          viennaYearOfDate,
        );
        for (const y of csYears) {
          if (y > year) affectedYears.add(y);
        }
      }

      const neededAssetIds = new Set<string>();
      for (const t of allTxns) {
        if (t.side !== 'sell' || t.taxMode !== 'country_specific') continue;
        if (affectedYears.has(viennaYearOfDate(t.executedAt)) || (involveDe && isDeSell(t))) {
          neededAssetIds.add(t.assetId);
        }
      }
      let realizations = new Map<string, SellRealizationEur>();
      let deRealizations = new Map<string, SellRealizationEur>();
      let assetsById = new Map<string, AssetRow>();
      if (neededAssetIds.size > 0) {
        assetsById = await loadAssets(allTxns.map((t) => t.assetId));
        const taxables = await buildTaxables(
          allTxns,
          [],
          neededAssetIds,
          currencyLookup(assetsById),
          createTradeDateConverter(fxWriteError),
        );
        realizations = realizationsById(taxables);
        if (involveDe) deRealizations = realizationsById(taxables, 'fifo');
      }
      const deView = buildDeView(allTxns, remainingDividends, deRealizations, assetsById);
      const frozenDeEvents = involveDe
        ? deEventsByYear(deView)
        : new Map<number, DeTaxableEvent[]>();

      for (const y of [...affectedYears].sort((a, b) => a - b)) {
        const targetEur = floorCents(
          atTargetForYear(allTxns, remainingDividends, realizations, y) +
            (involveDe ? deTargetForYear(frozenDeEvents, y) : 0),
        );
        const heldEur = heldForYear(allTxns, remainingDividends, remainingMovements, y);
        const spec = taxMovementForDelta(floorCents(targetEur - heldEur));
        if (spec) {
          corrections.push(
            correctionMovement(
              spec,
              await correctionSourceId(portfolioId),
              y,
              correctionNote(deletedWasDe ? TAX_COUNTRY_DE : TAX_COUNTRY_AT),
            ),
          );
        }
      }
    }

    // Removing the gross inflow (and adding corrections) must never strand a
    // later outflow: replay the remaining history first (no silent negatives).
    try {
      projectCashLedgerBySource([
        ...remainingMovements.map(toDomainMovement),
        ...corrections.map(newToDomainMovement),
      ]);
    } catch (err) {
      if (err instanceof InsufficientCashError) {
        throw badRequest(
          'Deleting this dividend would overdraw your cash balance on a later date. Add cash or remove the dependent movements first.',
          'CASH_LEDGER_WOULD_GO_NEGATIVE',
          { availableEur: err.balanceEur, shortfallEur: err.shortfallEur },
        );
      }
      throw err;
    }

    const deleted = await taxRepo.deleteForPortfolio(portfolioId, dividendId);
    if (!deleted) throw notFound('Dividend not found.', 'DIVIDEND_NOT_FOUND');
    for (const correction of corrections) {
      await cashMovementRepo.insert(portfolioId, correction);
    }
    // The removed dividend's day, or an earlier-dated correction (§16 rule 6).
    const affectedFrom = [
      dayOfDate(dividend.executedAt),
      ...corrections.map((c) => dayOfDate(c.executedAt)),
    ].reduce((a, b) => (a < b ? a : b));
    await invalidateHistory(portfolioId, affectedFrom);
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  interface ReportState {
    transactions: TransactionRecord[];
    dividendRows: DividendRecord[];
    movements: CashMovementRecord[];
    realizations: Map<string, SellRealizationEur>;
    /** FIFO realizations — populated exactly when the portfolio has DE rows. */
    deRealizations: Map<string, SellRealizationEur>;
    /** Per-year DE events of the frozen DE rows (empty without DE rows). */
    frozenDeEvents: Map<number, DeTaxableEvent[]>;
    assetsById: Map<string, AssetRow>;
  }

  async function loadReportState(portfolioId: string): Promise<ReportState> {
    const [transactions, dividendRows, movements] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    // Realized P/L is a financial fact across ALL sells regardless of tax
    // mode; every asset with a sell needs its EUR replay.
    const neededAssetIds = new Set(
      transactions.filter((t) => t.side === 'sell').map((t) => t.assetId),
    );
    const assetsById = await loadAssets([
      ...transactions.map((t) => t.assetId),
      ...dividendRows.map((d) => d.assetId),
    ]);
    const involveDe = portfolioHasDeRows(transactions, dividendRows);
    let realizations = new Map<string, SellRealizationEur>();
    let deRealizations = new Map<string, SellRealizationEur>();
    if (neededAssetIds.size > 0) {
      const taxables = await buildTaxables(
        transactions,
        [],
        neededAssetIds,
        currencyLookup(assetsById),
        createTradeDateConverter(fxReadError),
      );
      realizations = realizationsById(taxables);
      if (involveDe) deRealizations = realizationsById(taxables, 'fifo');
    }
    const frozenDeEvents = involveDe
      ? deEventsByYear(buildDeView(transactions, dividendRows, deRealizations, assetsById))
      : new Map<number, DeTaxableEvent[]>();
    return {
      transactions,
      dividendRows,
      movements,
      realizations,
      deRealizations,
      frozenDeEvents,
      assetsById,
    };
  }

  /**
   * The realization of one sell as the report states it: a DE-frozen sell
   * shows its FIFO realization (that IS the taxed truth next to its frozen
   * tax); every other sell keeps the moving-average view — for AT rows that
   * is the taxed truth, and for untaxed rows the pre-V5-P4 financial fact.
   */
  function reportRealization(
    state: ReportState,
    t: TransactionRecord,
  ): SellRealizationEur | undefined {
    return isDeSell(t) ? state.deRealizations.get(t.id) : state.realizations.get(t.id);
  }

  /**
   * The DE year-end block — present exactly when the year has DE-taxed rows.
   * Returns `undefined` (key omitted) otherwise, so a portfolio without DE
   * rows keeps the exact pre-V5-P4 wire shape.
   */
  function deSummaryForYear(state: ReportState, year: number): TaxYearSummary['de'] {
    const hasDeInYear =
      state.transactions.some((t) => isDeSell(t) && viennaYearOfDate(t.executedAt) === year) ||
      state.dividendRows.some((d) => isDeDividend(d) && viennaYearOfDate(d.executedAt) === year);
    if (!hasDeInYear) return undefined;
    const { potIns, outcome } = deYearStateForYear(state.frozenDeEvents, year);
    return {
      allowanceUsedEur: floorCents(outcome.allowanceUsedEur),
      allowanceRemainingEur: floorCents(outcome.allowanceRemainingEur),
      aktienPotInEur: floorCents(potIns.aktienEur),
      aktienPotOutEur: floorCents(outcome.aktienPotOutEur),
      sonstigePotInEur: floorCents(potIns.sonstigeEur),
      sonstigePotOutEur: floorCents(outcome.sonstigePotOutEur),
      kapestEur: outcome.kapestEur,
      soliEur: outcome.soliEur,
    };
  }

  function yearSummary(state: ReportState, year: number): TaxYearSummary {
    let realizedPnlEur = 0;
    for (const t of state.transactions) {
      if (t.side !== 'sell' || viennaYearOfDate(t.executedAt) !== year) continue;
      realizedPnlEur += reportRealization(state, t)?.realizedPnlEur ?? 0;
    }
    let dividendsGrossEur = 0;
    for (const d of state.dividendRows) {
      if (viennaYearOfDate(d.executedAt) === year) dividendsGrossEur += d.grossAmountEur;
    }
    let taxWithheldEur = 0;
    let taxRefundedEur = 0;
    for (const m of state.movements) {
      if (m.taxYear !== year) continue;
      if (m.kind === 'tax_withholding') taxWithheldEur += -m.amountEur;
      else if (m.kind === 'tax_refund') taxRefundedEur += m.amountEur;
    }
    taxWithheldEur = floorCents(taxWithheldEur);
    taxRefundedEur = floorCents(taxRefundedEur);
    const de = deSummaryForYear(state, year);
    return {
      year,
      realizedPnlEur,
      dividendsGrossEur,
      taxWithheldEur,
      taxRefundedEur,
      taxNetEur: floorCents(taxWithheldEur - taxRefundedEur),
      // Omit the key entirely for non-DE years (exact pre-V5-P4 shape).
      ...(de !== undefined ? { de } : {}),
    };
  }

  function reportYears(state: ReportState): number[] {
    const years = new Set<number>();
    for (const t of state.transactions) {
      if (t.side === 'sell') years.add(viennaYearOfDate(t.executedAt));
    }
    for (const d of state.dividendRows) years.add(viennaYearOfDate(d.executedAt));
    for (const m of state.movements) {
      if (m.taxYear !== null) years.add(m.taxYear);
    }
    return [...years].sort((a, b) => b - a);
  }

  async function getYearReports(userId: string, portfolioId: string): Promise<TaxYearListResponse> {
    await requireOwnedPortfolio(userId, portfolioId);
    const state = await loadReportState(portfolioId);
    return { years: reportYears(state).map((year) => yearSummary(state, year)) };
  }

  async function getYearReport(
    userId: string,
    portfolioId: string,
    year: number,
  ): Promise<TaxYearReportResponse> {
    await requireOwnedPortfolio(userId, portfolioId);
    const state = await loadReportState(portfolioId);

    const byAsset = new Map<string, { sells: TransactionRecord[]; dividends: DividendRecord[] }>();
    const bucket = (assetId: string) => {
      let entry = byAsset.get(assetId);
      if (!entry) {
        entry = { sells: [], dividends: [] };
        byAsset.set(assetId, entry);
      }
      return entry;
    };
    for (const t of state.transactions) {
      if (t.side === 'sell' && viennaYearOfDate(t.executedAt) === year) {
        bucket(t.assetId).sells.push(t);
      }
    }
    for (const d of state.dividendRows) {
      if (viennaYearOfDate(d.executedAt) === year) bucket(d.assetId).dividends.push(d);
    }

    const positions: TaxYearPosition[] = [];
    for (const [assetId, entry] of byAsset) {
      const asset = state.assetsById.get(assetId);
      if (!asset) throw new Error(`Asset ${assetId} missing while building the year report`);
      let realizedPnlEur = 0;
      let taxEur = 0;
      const sells = entry.sells
        .sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime())
        .map((t) => {
          const realization = reportRealization(state, t);
          if (!realization) {
            throw new Error(`Realization missing for sell ${t.id} in the year report`);
          }
          realizedPnlEur += realization.realizedPnlEur;
          taxEur += t.taxAmountEur ?? 0;
          return {
            transactionId: t.id,
            executedAt: t.executedAt.toISOString(),
            quantity: t.quantity,
            proceedsEur: realization.proceedsEur,
            costBasisEur: realization.costBasisEur,
            realizedPnlEur: realization.realizedPnlEur,
            taxMode: t.taxMode,
            taxAmountEur: t.taxAmountEur,
          };
        });
      let dividendsGrossEur = 0;
      const dividends = entry.dividends
        .sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime())
        .map((d) => {
          dividendsGrossEur += d.grossAmountEur;
          taxEur += d.taxAmountEur ?? 0;
          return {
            dividendId: d.id,
            executedAt: d.executedAt.toISOString(),
            grossAmountEur: d.grossAmountEur,
            taxMode: d.taxMode,
            taxAmountEur: d.taxAmountEur,
          };
        });
      positions.push({
        asset: assetToDto(asset),
        realizedPnlEur,
        dividendsGrossEur,
        taxEur: floorCents(taxEur),
        sells,
        dividends,
      });
    }
    positions.sort((a, b) => a.asset.symbol.localeCompare(b.asset.symbol));

    return { year, summary: yearSummary(state, year), positions };
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  function toSettingsResponse(record: UserTaxSettingsRecord): TaxSettingsResponse {
    return {
      mode: record.mode,
      country: toContractCountry(record.country),
    };
  }

  return {
    async getSettings(userId) {
      return toSettingsResponse(await effectiveSettings(userId));
    },

    async updateSettings(userId, input) {
      // The contract already pins country ⟺ country_specific; normalise here
      // so the stored pair can never drift (DB CHECK is the last resort).
      const record = await taxRepo.setUserTaxSettings(userId, {
        mode: input.mode,
        country: input.mode === 'country_specific' ? (input.country ?? TAX_COUNTRY_AT) : null,
      });
      return toSettingsResponse(record);
    },

    getEffectiveSettings: effectiveSettings,
    planTransactionTaxes,
    planTransactionDeleteCorrections,
    recordDividend,
    listDividends,
    deleteDividend,
    getYearReports,
    getYearReport,
  };
}

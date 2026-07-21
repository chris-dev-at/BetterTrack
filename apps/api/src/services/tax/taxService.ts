import {
  customTaxParamsSchema,
  type CashMovement as CashMovementDto,
  type CreateDividendRequest,
  type CreateDividendResponse,
  type Dividend as DividendDto,
  type DividendListResponse,
  type PortfolioTaxSettingsResponse,
  type TaxSettingsResponse,
  type TaxYearListResponse,
  type TaxYearPosition,
  type TaxYearReportResponse,
  type TaxYearSummary,
  type TransactionInput,
  type UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import type { AssetRow } from '../../data/schema';
import { resolvePortfolioSetting } from '../../domain/settingsScope';
import type { PortfolioSettingsRepository } from '../../data/repositories/portfolioSettingsRepository';
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
  settleCustomYear,
  settleDeYear,
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  taxMovementForDelta,
  viennaYearOf,
  type CostBasisStrategy,
  type CustomTaxableEvent,
  type CustomTaxParams,
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
import {
  customCarryIntoYear,
  customChainSensitive,
  customGroups,
  customGroupTargetForYear,
  customParamsKey,
  isCustomDividend,
  isCustomFifoSell,
  isCustomSell,
  mergeCustomEvents,
  portfolioHasCustomRows,
  type CustomGroup,
  type CustomRowView,
} from './customState';
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
  /** Per-portfolio setting overrides (issue #636): the override layer of the scoping cascade. */
  portfolioSettingsRepo: PortfolioSettingsRepository;
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
   * The batch's V5-P0c source tag (`manual` | `import:<broker>` | …). The
   * configurable manual default applies to `manual` rows only — imported
   * broker history already settled its taxes at the broker, so an entry-less
   * imported row must not have today's default frozen onto it. Absent = manual
   * (every non-import caller records by hand).
   */
  source?: string;
  /**
   * Resolves a cash source for a settlement: the explicit id (must be an
   * active source of this portfolio) or the portfolio's Main. Supplied by the
   * portfolio service so both share one resolution (and its caching).
   */
  resolveSourceId: (explicitId: string | undefined) => Promise<string>;
}

export interface TaxService {
  /**
   * Settings → Taxes: the caller's USER-LEVEL default (+ country); `none` when
   * never set. Since #636 this is the "default for new portfolios" — the middle
   * layer of the per-portfolio scoping cascade, not a portfolio's own value.
   */
  getSettings(userId: string): Promise<TaxSettingsResponse>;
  /** Update the user-level default; `country` exactly with `country_specific` (AT | DE). */
  updateSettings(userId: string, input: UpdateTaxSettingsRequest): Promise<TaxSettingsResponse>;
  /**
   * The settings that ACTUALLY apply to a portfolio (issue #636), resolved
   * through the scoping cascade `override ?? user default ?? system('none')`.
   * `portfolioId` omitted resolves the user default only (no override layer).
   */
  getEffectiveSettings(userId: string, portfolioId?: string): Promise<UserTaxSettingsRecord>;
  /**
   * `GET /portfolios/:id/settings/tax` (issue #636): the portfolio's tax
   * treatment resolved through the cascade, plus its own override (or null when
   * inheriting), the user default, and which layer `effective` came from.
   */
  getPortfolioTaxSettings(
    userId: string,
    portfolioId: string,
  ): Promise<PortfolioTaxSettingsResponse>;
  /** `PUT /portfolios/:id/settings/tax`: pin a per-portfolio override; returns the resolved view. */
  setPortfolioTaxOverride(
    userId: string,
    portfolioId: string,
    input: UpdateTaxSettingsRequest,
  ): Promise<PortfolioTaxSettingsResponse>;
  /** `DELETE /portfolios/:id/settings/tax`: drop the override (reset-to-default); returns the resolved view. */
  clearPortfolioTaxOverride(
    userId: string,
    portfolioId: string,
  ): Promise<PortfolioTaxSettingsResponse>;
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
const NOTE_CUSTOM_WITHHELD = 'Tax withheld (custom rules)';
const NOTE_CUSTOM_REFUNDED = 'Tax refunded (custom rules)';
const NOTE_CUSTOM_CORRECTION = 'Tax year correction (custom rules)';

type EngineCountry = typeof TAX_COUNTRY_AT | typeof TAX_COUNTRY_DE;
/** The settlement regime a movement belongs to: a country's engine or custom. */
type SettleRegime = EngineCountry | 'custom';

const settlementNote = (regime: SettleRegime, kind: TaxMovementSpec['kind']): string =>
  regime === 'custom'
    ? kind === 'tax_withholding'
      ? NOTE_CUSTOM_WITHHELD
      : NOTE_CUSTOM_REFUNDED
    : regime === TAX_COUNTRY_DE
      ? kind === 'tax_withholding'
        ? NOTE_DE_WITHHELD
        : NOTE_DE_REFUNDED
      : kind === 'tax_withholding'
        ? NOTE_AT_WITHHELD
        : NOTE_AT_REFUNDED;

const correctionNote = (regime: SettleRegime): string =>
  regime === 'custom'
    ? NOTE_CUSTOM_CORRECTION
    : regime === TAX_COUNTRY_DE
      ? NOTE_DE_CORRECTION
      : NOTE_AT_CORRECTION;

const isTaxMovementKind = (kind: CashMovementRecord['kind']): boolean =>
  kind === 'tax_withholding' || kind === 'tax_refund';

/** The setting key the tax override lives under in `portfolio_settings` (#636). */
const PORTFOLIO_SETTING_KEY_TAX = 'tax';
/** The system default — the bottom of the scoping cascade (pre-tax-engine behaviour). */
const TAX_SYSTEM_DEFAULT: UserTaxSettingsRecord = {
  mode: 'none',
  country: null,
  manualDefaultAmountEur: null,
  manualDefaultRatePct: null,
  customParams: null,
};

/** A finite non-negative number, else null (override-value hygiene). */
const asNonNegative = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Narrow a raw `portfolio_settings` value (jsonb) into a tax record, normalising
 * the mode-dependent fields exactly as writes do (country iff `country_specific`,
 * custom params iff `custom`, manual default — amount or rate, never both — iff
 * `manual_per_trade`). A shape we did not write reads as "no override" rather
 * than throwing — the cascade then falls through to the user default.
 */
function parseTaxOverride(raw: unknown): UserTaxSettingsRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const mode = (raw as { mode?: unknown }).mode;
  if (
    mode !== 'none' &&
    mode !== 'manual_per_trade' &&
    mode !== 'country_specific' &&
    mode !== 'custom'
  ) {
    return null;
  }
  const rawCountry = (raw as { country?: unknown }).country;
  const country =
    rawCountry === TAX_COUNTRY_AT || rawCountry === TAX_COUNTRY_DE ? rawCountry : null;
  if (mode === 'custom') {
    // An override without a valid parameter set is unusable — treat as absent.
    const parsed = customTaxParamsSchema.safeParse((raw as { custom?: unknown }).custom);
    if (!parsed.success) return null;
    return { ...TAX_SYSTEM_DEFAULT, mode, customParams: parsed.data };
  }
  const record: UserTaxSettingsRecord = {
    ...TAX_SYSTEM_DEFAULT,
    mode,
    country: mode === 'country_specific' ? (country ?? TAX_COUNTRY_AT) : null,
  };
  if (mode === 'manual_per_trade') {
    const amount = asNonNegative(
      (raw as { manualDefaultAmountEur?: unknown }).manualDefaultAmountEur,
    );
    const rate = asNonNegative((raw as { manualDefaultRatePct?: unknown }).manualDefaultRatePct);
    record.manualDefaultAmountEur = amount;
    record.manualDefaultRatePct = amount === null && rate !== null && rate <= 100 ? rate : null;
  }
  return record;
}

/**
 * Normalise an update body into the stored record — mode-dependent fields can
 * never drift from the mode (the contract already pins this; the DB CHECKs are
 * the last resort). Shared by the user-default write and the portfolio override.
 */
function settingsRecordFromInput(input: UpdateTaxSettingsRequest): UserTaxSettingsRecord {
  return {
    mode: input.mode,
    country: input.mode === 'country_specific' ? (input.country ?? TAX_COUNTRY_AT) : null,
    manualDefaultAmountEur:
      input.mode === 'manual_per_trade' ? (input.manualDefaultAmountEur ?? null) : null,
    manualDefaultRatePct:
      input.mode === 'manual_per_trade' ? (input.manualDefaultRatePct ?? null) : null,
    customParams: input.mode === 'custom' ? (input.custom ?? null) : null,
  };
}

export function createTaxService(deps: TaxServiceDeps): TaxService {
  const { taxRepo, portfolioSettingsRepo, transactionRepo, cashMovementRepo, cashSourceRepo } =
    deps;
  const { portfolioRepo, currencyService, snapshots } = deps;
  const now = deps.now ?? Date.now;

  // ── Shared plumbing ────────────────────────────────────────────────────────

  async function requireOwnedPortfolio(userId: string, portfolioId: string): Promise<void> {
    const portfolio = await portfolioRepo.findByIdForUser(userId, portfolioId);
    if (!portfolio) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
  }

  /** A portfolio's own tax override, or null when it inherits (issue #636). */
  async function readTaxOverride(portfolioId: string): Promise<UserTaxSettingsRecord | null> {
    return parseTaxOverride(
      await portfolioSettingsRepo.getSetting(portfolioId, PORTFOLIO_SETTING_KEY_TAX),
    );
  }

  /**
   * The settings that apply to a portfolio (issue #636): the scoping cascade
   * `override ?? user default ?? system('none')`, resolved live so a portfolio
   * with no override tracks the user's current default. With no `portfolioId`
   * (legacy callers) only the user default and system layers apply.
   */
  async function effectiveSettings(
    userId: string,
    portfolioId?: string,
  ): Promise<UserTaxSettingsRecord> {
    const [userDefault, override] = await Promise.all([
      taxRepo.getUserTaxSettings(userId),
      portfolioId ? readTaxOverride(portfolioId) : Promise.resolve(null),
    ]);
    return resolvePortfolioSetting(override, userDefault, TAX_SYSTEM_DEFAULT).value;
  }

  /** The resolved per-portfolio tax view for the HTTP layer (issue #636). */
  async function getPortfolioTaxSettings(
    userId: string,
    portfolioId: string,
  ): Promise<PortfolioTaxSettingsResponse> {
    await requireOwnedPortfolio(userId, portfolioId);
    const [userDefault, override] = await Promise.all([
      taxRepo.getUserTaxSettings(userId),
      readTaxOverride(portfolioId),
    ]);
    const resolved = resolvePortfolioSetting(override, userDefault, TAX_SYSTEM_DEFAULT);
    return {
      effective: toSettingsResponse(resolved.value),
      override: override ? toSettingsResponse(override) : null,
      userDefault: toSettingsResponse(userDefault ?? TAX_SYSTEM_DEFAULT),
      source: resolved.source,
    };
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

  /** A row settled by an engine (country-specific or custom) — never manual. */
  const isEngineTaxed = (taxMode: TransactionRecord['taxMode']): boolean =>
    taxMode === 'country_specific' || taxMode === 'custom';

  /**
   * The tax currently **held** for one Vienna year of one portfolio: the sum
   * of the frozen tax on the year's engine-taxed rows (AT/DE/custom — their
   * attached settlement movements mirror those 1:1 — created atomically,
   * immutable, cascading together) plus the unattached year corrections among
   * the movements. Manual-mode rows are excluded: engine pools contain only
   * rows taxed by an engine (§16), and manual withholdings are never refunded.
   */
  function heldForYear(
    transactions: readonly TransactionRecord[],
    dividendRows: readonly DividendRecord[],
    movements: readonly CashMovementRecord[],
    year: number,
  ): number {
    let held = 0;
    for (const t of transactions) {
      if (t.side !== 'sell' || !isEngineTaxed(t.taxMode)) continue;
      if (viennaYearOfDate(t.executedAt) !== year) continue;
      held += t.taxAmountEur ?? 0;
    }
    for (const d of dividendRows) {
      if (!isEngineTaxed(d.taxMode)) continue;
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
   * Every Vienna year carrying ANY engine-settled state (AT/DE/custom rows or
   * unattached corrections), ascending — the candidate set for the downstream
   * ripple when a chained regime's earlier year changes.
   */
  function engineTaxedYears(
    transactions: readonly TransactionRecord[],
    dividendRows: readonly DividendRecord[],
    movements: readonly CashMovementRecord[],
  ): number[] {
    const years = new Set(
      countrySpecificYears(transactions, dividendRows, movements, viennaYearOfDate),
    );
    for (const t of transactions) {
      if (isCustomSell(t)) years.add(viennaYearOfDate(t.executedAt));
    }
    for (const d of dividendRows) {
      if (isCustomDividend(d)) years.add(viennaYearOfDate(d.executedAt));
    }
    return [...years].sort((a, b) => a - b);
  }

  /** The active custom parameter set; corrupt settings fail loud (we wrote them). */
  function activeCustomParams(settings: UserTaxSettingsRecord): CustomTaxParams {
    const parsed = customTaxParamsSchema.safeParse(settings.customParams);
    if (!parsed.success) {
      throw new Error('Tax engine: custom mode is active without a readable parameter set');
    }
    return parsed.data;
  }

  /** Assemble the {@link CustomRowView} the customState derivations run over. */
  function buildCustomView(
    transactions: readonly TransactionRecord[],
    dividendRows: readonly DividendRecord[],
    realizations: ReadonlyMap<string, SellRealizationEur>,
    fifoRealizations: ReadonlyMap<string, SellRealizationEur>,
  ): CustomRowView {
    return {
      transactions,
      dividendRows,
      realizationsFor: (strategy: CostBasisStrategy) =>
        strategy === 'fifo' ? fifoRealizations : realizations,
      yearOf: viennaYearOfDate,
    };
  }

  /**
   * The custom component of a year's held-tax target: the sum of every frozen
   * parameter group's independent target, optionally excluding the ACTIVE
   * group (whose component `settleCustomYear` steers itself on write paths).
   */
  function customTargetForYear(
    groups: ReadonlyMap<string, CustomGroup>,
    year: number,
    excludeKey?: string,
  ): number {
    let total = 0;
    for (const group of groups.values()) {
      if (group.key === excludeKey) continue;
      total += customGroupTargetForYear(group, year);
    }
    return floorCents(total);
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
    // Issue #636: resolve the mode that applies to THIS portfolio (override ??
    // user default ?? none). It still freezes onto each row at recording time.
    const settings = await effectiveSettings(userId, portfolioId);

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

    // ── Manual per trade: literal recording, zero automation. The V5-P4c
    // configurable default fills in where no explicit entry arrived — an
    // explicit entry (including an explicit 0) always wins, and with no
    // default configured the behavior is byte-identical pre-V5-P4. Manually
    // recorded rows only: imported broker history settled its taxes at the
    // broker, so a non-`manual` batch never receives the default. ───────────
    if (settings.mode === 'manual_per_trade') {
      const defaultApplies = (planInput.source ?? 'manual') === 'manual';
      /** The amount/rate that applies to one sell: explicit entry, else the default. */
      const effectiveEntry = (input: TransactionInput) => {
        const hasExplicit = input.taxAmountEur !== undefined || input.taxRatePct !== undefined;
        if (hasExplicit) {
          return { taxAmountEur: input.taxAmountEur ?? null, taxRatePct: input.taxRatePct ?? null };
        }
        return defaultApplies
          ? {
              taxAmountEur: settings.manualDefaultAmountEur,
              taxRatePct: settings.manualDefaultRatePct,
            }
          : { taxAmountEur: null, taxRatePct: null };
      };
      // Realized gains are needed only as the base of a RATE entry; convert
      // only those assets so an amount-only entry never depends on FX.
      const rateAssetIds = new Set(
        pendingSells
          .filter((p) => effectiveEntry(p.input).taxRatePct !== null)
          .map((p) => p.input.assetId),
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
        const entry = effectiveEntry(input);
        const baseEur =
          entry.taxRatePct !== null ? (realizations.get(tempId)?.realizedPnlEur ?? 0) : 0;
        const taxEur = manualTaxEur({ ...entry, baseEur });
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

    // ── Engine modes: country-specific (AT | DE) or custom (V5-P4c). The
    // active regime's engine settles the new sells; frozen rows keep their own
    // regime, and a year's held tax is always the SUM of every regime's
    // independent target — AT pool + DE year + one component per frozen custom
    // parameter group (§16 cutover, generalized). ───────────────────────────
    const isCustomMode = settings.mode === 'custom';
    const activeParams = isCustomMode ? activeCustomParams(settings) : null;
    const activeKey = activeParams ? customParamsKey(activeParams) : undefined;
    const country: EngineCountry | null = isCustomMode ? null : effectiveCountry(settings);
    const regime: SettleRegime = isCustomMode ? 'custom' : country!;
    const [allTxns, dividendRows, movements] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    const involveDe = country === TAX_COUNTRY_DE || portfolioHasDeRows(allTxns, dividendRows);
    const involveCustom = isCustomMode || portfolioHasCustomRows(allTxns, dividendRows);
    // Regimes whose state chains across the whole history: DE (FIFO lots +
    // pot carry) and any custom group that keeps FIFO lots or carries state
    // over year boundaries. They widen the affected set below.
    const involveChain =
      involveDe || (involveCustom && customChainSensitive(allTxns, dividendRows, activeParams));

    // Years whose pools this batch touches: the years of its sells, plus —
    // when the batch (back)dates buys of an asset — the years of that asset's
    // existing engine-taxed sells, whose recomputed gains may have shifted.
    const batchBuyAssets = new Set(inputs.filter((i) => i.side === 'buy').map((i) => i.assetId));
    const affectedYears = new Set<number>(
      pendingSells.map((p) => viennaYearOf(new Date(p.input.executedAt).toISOString())),
    );
    for (const t of allTxns) {
      if (t.side === 'sell' && isEngineTaxed(t.taxMode) && batchBuyAssets.has(t.assetId)) {
        affectedYears.add(viennaYearOfDate(t.executedAt));
      }
    }
    // FIFO/chain additions (V5-P4): under FIFO, ANY batch trade of an asset can
    // shift that asset's lot consumption (sells consume lots too, unlike the
    // moving average) — and a changed year of a chained regime changes its
    // carry-outs, which ripples into every later engine-taxed year. Close the
    // affected set downstream; a year whose combined target did not move
    // settles to a zero correction and posts nothing.
    if (involveChain) {
      const batchAssets = new Set(inputs.map((i) => i.assetId));
      for (const t of allTxns) {
        if ((isDeSell(t) || isCustomFifoSell(t)) && batchAssets.has(t.assetId)) {
          affectedYears.add(viennaYearOfDate(t.executedAt));
        }
      }
      if (affectedYears.size > 0) {
        const minYear = Math.min(...affectedYears);
        for (const year of engineTaxedYears(allTxns, dividendRows, movements)) {
          if (year > minYear) affectedYears.add(year);
        }
      }
    }

    // Assets whose EUR replay the affected pools need: every batch-sell asset,
    // every asset with an existing engine-taxed sell in an affected year, and —
    // with a chain-spanning regime involved — every DE/custom-sell asset
    // anywhere (carry chains span all prior years, and the custom grouping
    // derivation replays every custom sell).
    const neededAssetIds = new Set(pendingSells.map((p) => p.input.assetId));
    for (const t of allTxns) {
      if (t.side !== 'sell' || !isEngineTaxed(t.taxMode)) continue;
      if (
        affectedYears.has(viennaYearOfDate(t.executedAt)) ||
        (involveDe && isDeSell(t)) ||
        (involveCustom && isCustomSell(t))
      ) {
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
    const fifoRealizations =
      involveDe || involveCustom
        ? realizationsById(taxables, 'fifo')
        : new Map<string, SellRealizationEur>();
    const deView = buildDeView(allTxns, dividendRows, fifoRealizations, mergedAssets);
    // Pending DE events join the pot chain year by year as the ascending loop
    // settles them, so a later year's pot-ins see the earlier years' new rows.
    const pendingDeEvents = new Map<number, DeTaxableEvent[]>();
    const deEventsWithPending = (): Map<number, DeTaxableEvent[]> =>
      deEventsByYear(deView, pendingDeEvents);
    // The frozen custom parameter groups; pending custom events chain the same
    // way through the ACTIVE group as the ascending loop settles them.
    const frozenGroups = involveCustom
      ? customGroups(buildCustomView(allTxns, dividendRows, realizations, fifoRealizations))
      : new Map<string, CustomGroup>();
    const pendingCustomEvents = new Map<number, CustomTaxableEvent[]>();

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
      // The frozen custom groups' components — every group when a country
      // engine settles; all but the ACTIVE group when custom settles (that one
      // is steered by settleCustomYear itself).
      const customTarget = involveCustom
        ? customTargetForYear(frozenGroups, year, isCustomMode ? activeKey : undefined)
        : 0;

      let correctionDeltaEur: number;
      let newEventDeltasEur: number[];
      if (isCustomMode) {
        // Custom: AT/DE components stay put (their recomputed targets reflect
        // any batch backdating); the active group's carry chains over its
        // frozen rows plus the already-settled pending events of earlier years.
        const atTarget = atTargetForYear(allTxns, dividendRows, realizations, year);
        const deTarget = involveDe ? deTargetForYear(deEventsWithPending(), year) : 0;
        const params = activeParams!;
        const activeEvents = mergeCustomEvents(
          frozenGroups.get(activeKey!)?.eventsByYear,
          pendingCustomEvents,
        );
        const newEvents: CustomTaxableEvent[] = yearSells.map((p) => {
          const realization = (params.costBasis === 'fifo' ? fifoRealizations : realizations).get(
            p.tempId,
          );
          if (!realization) {
            throw new Error(`Tax engine: no ${params.costBasis} realization for ${p.tempId}`);
          }
          return { kind: 'sell_gain' as const, amountEur: realization.realizedPnlEur };
        });
        const settlement = settleCustomYear({
          params,
          carry: customCarryIntoYear(params, activeEvents, year),
          existingEvents: frozenGroups.get(activeKey!)?.eventsByYear.get(year) ?? [],
          heldEur: floorCents(heldEur - atTarget - deTarget - customTarget),
          newEvents,
        });
        correctionDeltaEur = settlement.correctionDeltaEur;
        newEventDeltasEur = settlement.newEventDeltasEur;
        if (newEvents.length > 0) {
          pendingCustomEvents.set(year, [...(pendingCustomEvents.get(year) ?? []), ...newEvents]);
        }
      } else if (country === TAX_COUNTRY_AT) {
        // The DE + custom components (frozen rows only — an AT batch never adds
        // their events, but its backdated trades may have re-shaped their lot
        // bases; the recomputed realizations already reflect that).
        const deTarget = involveDe ? deTargetForYear(deEventsWithPending(), year) : 0;
        const pool = existingAtPool(allTxns, dividendRows, realizations, year);
        const settlement = settleAtYear({
          ...pool,
          heldEur: floorCents(heldEur - deTarget - customTarget),
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
        // DE: the AT + custom components stay put; pots chain over frozen rows
        // plus the already-settled pending events of earlier years.
        const atTarget = atTargetForYear(allTxns, dividendRows, realizations, year);
        const events = deEventsWithPending();
        const potIns = dePotsInForYear(events, year);
        const newEvents: DeTaxableEvent[] = yearSells.map((p) => {
          const realization = fifoRealizations.get(p.tempId);
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
          heldEur: floorCents(heldEur - atTarget - customTarget),
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
          note: correctionNote(regime),
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
          tax: isCustomMode
            ? { mode: 'custom', country: null, amountEur: deltaEur, params: activeParams }
            : { mode: 'country_specific', country, amountEur: deltaEur },
          movement: null,
        };
        const spec = taxMovementForDelta(deltaEur);
        if (spec) {
          const sourceId = await resolveSourceId(pendingSell.input.cashSourceId);
          row.movement = {
            kind: spec.kind,
            amountEur: spec.amountEur,
            sourceId,
            note: settlementNote(regime, spec.kind),
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
    const deletedWasCustom = isCustomSell(transaction);
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
    const involveCustom = deletedWasCustom || portfolioHasCustomRows(remainingTxns, dividendRows);
    const involveChain =
      involveDe || (involveCustom && customChainSensitive(remainingTxns, dividendRows, null));

    // Affected years: the deleted engine-taxed sell's own year, plus — when a
    // buy is removed — the years of its asset's engine-taxed sells (their
    // recomputed gains shift). With a chained regime involved, ANY removed
    // trade of the asset can shift its FIFO sells' lot consumption, and a
    // changed year changes its carry-outs — which ripples into every later
    // engine-taxed year.
    const affectedYears = new Set<number>();
    if (isCsSell || deletedWasCustom) {
      affectedYears.add(viennaYearOfDate(transaction.executedAt));
    }
    if (transaction.side === 'buy') {
      for (const t of remainingTxns) {
        if (t.assetId === transaction.assetId && t.side === 'sell' && isEngineTaxed(t.taxMode)) {
          affectedYears.add(viennaYearOfDate(t.executedAt));
        }
      }
    }
    if (involveChain) {
      for (const t of remainingTxns) {
        if ((isDeSell(t) || isCustomFifoSell(t)) && t.assetId === transaction.assetId) {
          affectedYears.add(viennaYearOfDate(t.executedAt));
        }
      }
      if (affectedYears.size > 0) {
        const minYear = Math.min(...affectedYears);
        for (const year of engineTaxedYears(remainingTxns, dividendRows, remainingMovements)) {
          if (year > minYear) affectedYears.add(year);
        }
      }
    }
    if (affectedYears.size === 0) return [];

    const neededAssetIds = new Set<string>();
    for (const t of remainingTxns) {
      if (t.side !== 'sell' || !isEngineTaxed(t.taxMode)) continue;
      if (
        affectedYears.has(viennaYearOfDate(t.executedAt)) ||
        (involveDe && isDeSell(t)) ||
        (involveCustom && isCustomSell(t))
      ) {
        neededAssetIds.add(t.assetId);
      }
    }

    let realizations = new Map<string, SellRealizationEur>();
    let fifoRealizations = new Map<string, SellRealizationEur>();
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
      if (involveDe || involveCustom) fifoRealizations = realizationsById(taxables, 'fifo');
    }
    const deView = buildDeView(remainingTxns, dividendRows, fifoRealizations, assetsById);
    const frozenDeEvents = involveDe ? deEventsByYear(deView) : new Map<number, DeTaxableEvent[]>();
    const frozenGroups = involveCustom
      ? customGroups(buildCustomView(remainingTxns, dividendRows, realizations, fifoRealizations))
      : new Map<string, CustomGroup>();

    // The regime the corrections are labeled with: an engine-taxed deleted row
    // names its own; a deleted BUY has none — it reshapes its asset's
    // engine-taxed sells, so label by theirs (custom over DE over AT when
    // mixed; the amount is the combined reconciliation either way).
    let noteRegime: SettleRegime = deletedWasCustom
      ? 'custom'
      : deletedWasDe
        ? TAX_COUNTRY_DE
        : TAX_COUNTRY_AT;
    if (transaction.side === 'buy') {
      const reshaped = remainingTxns.filter(
        (t) => t.assetId === transaction.assetId && t.side === 'sell' && isEngineTaxed(t.taxMode),
      );
      if (reshaped.some(isCustomSell)) noteRegime = 'custom';
      else if (reshaped.some(isDeSell)) noteRegime = TAX_COUNTRY_DE;
    }

    // Each year settles append-only against its combined post-delete target
    // (AT pool + DE year + per-custom-group targets — components never mix).
    // The signed delta includes refund-off custom groups (§16): a reshape is a
    // data correction, exempt from the ratchet, so held lands exactly on the
    // combined replay target here just as on the write path.
    const corrections: NewCashMovement[] = [];
    for (const year of [...affectedYears].sort((a, b) => a - b)) {
      const targetEur = floorCents(
        atTargetForYear(remainingTxns, dividendRows, realizations, year) +
          (involveDe ? deTargetForYear(frozenDeEvents, year) : 0) +
          (involveCustom ? customTargetForYear(frozenGroups, year) : 0),
      );
      const heldEur = heldForYear(remainingTxns, dividendRows, remainingMovements, year);
      const spec = taxMovementForDelta(floorCents(targetEur - heldEur));
      if (spec) {
        corrections.push(
          correctionMovement(
            spec,
            await correctionSourceId(portfolioId),
            year,
            correctionNote(noteRegime),
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

    // Issue #636: the mode that applies to THIS portfolio (override ?? default).
    const settings = await effectiveSettings(userId, portfolioId);
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
    let taxParams: CustomTaxParams | null = null;
    let rowSettlement: TaxMovementSpec | null = null;
    const extras: NewCashMovement[] = [];

    if (settings.mode === 'manual_per_trade') {
      // The V5-P4c configurable default applies where no explicit entry
      // arrived; an explicit entry (including 0) wins, blank default = today's
      // behavior byte-identically. Manually recorded dividends only: an
      // imported broker dividend settled its tax at the broker, so a
      // non-`manual` source tag never receives the default.
      const hasExplicit = input.taxAmountEur !== undefined || input.taxRatePct !== undefined;
      const defaultApplies = sourceTag === 'manual';
      taxAmountEur = manualTaxEur({
        taxAmountEur: hasExplicit
          ? (input.taxAmountEur ?? null)
          : defaultApplies
            ? settings.manualDefaultAmountEur
            : null,
        taxRatePct: hasExplicit
          ? (input.taxRatePct ?? null)
          : defaultApplies
            ? settings.manualDefaultRatePct
            : null,
        baseEur: grossEur,
      });
      if (taxAmountEur !== null && taxAmountEur > 0) {
        rowSettlement = { kind: 'tax_withholding', amountEur: -taxAmountEur };
      }
    } else if (settings.mode === 'country_specific' || settings.mode === 'custom') {
      const isCustomMode = settings.mode === 'custom';
      const params = isCustomMode ? activeCustomParams(settings) : null;
      const activeKey = params ? customParamsKey(params) : undefined;
      const country = isCustomMode ? null : effectiveCountry(settings);
      taxCountry = country;
      taxParams = params;
      const [allTxns, dividendRows, movements] = await Promise.all([
        transactionRepo.listForPortfolio(portfolioId),
        taxRepo.listForPortfolio(portfolioId),
        cashMovementRepo.listForPortfolio(portfolioId),
      ]);
      const involveDe = country === TAX_COUNTRY_DE || portfolioHasDeRows(allTxns, dividendRows);
      const involveCustom = isCustomMode || portfolioHasCustomRows(allTxns, dividendRows);
      const involveChain =
        involveDe || (involveCustom && customChainSensitive(allTxns, dividendRows, params));

      // A dividend entering a chained regime (DE pots; a custom set that
      // carries state) re-settles every LATER engine-taxed year (the ripple
      // loop below), whose targets need those years' sell realizations
      // replayed too — not just the dividend's own year.
      const chainRipples = country === TAX_COUNTRY_DE || (isCustomMode && involveChain);
      const rippleYears = chainRipples
        ? engineTaxedYears(allTxns, dividendRows, movements).filter((y) => y > year)
        : [];

      const neededAssetIds = new Set<string>();
      for (const t of allTxns) {
        if (t.side !== 'sell' || !isEngineTaxed(t.taxMode)) continue;
        const txnYear = viennaYearOfDate(t.executedAt);
        if (
          txnYear === year ||
          rippleYears.includes(txnYear) ||
          (involveDe && isDeSell(t)) ||
          (involveCustom && isCustomSell(t))
        ) {
          neededAssetIds.add(t.assetId);
        }
      }
      let realizations = new Map<string, SellRealizationEur>();
      let fifoRealizations = new Map<string, SellRealizationEur>();
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
        if (involveDe || involveCustom) fifoRealizations = realizationsById(taxables, 'fifo');
      }
      const deView = buildDeView(allTxns, dividendRows, fifoRealizations, assetsById);
      const frozenDeEvents = involveDe
        ? deEventsByYear(deView)
        : new Map<number, DeTaxableEvent[]>();
      const frozenGroups = involveCustom
        ? customGroups(buildCustomView(allTxns, dividendRows, realizations, fifoRealizations))
        : new Map<string, CustomGroup>();
      const heldEur = heldForYear(allTxns, dividendRows, movements, year);
      const customTarget = involveCustom
        ? customTargetForYear(frozenGroups, year, isCustomMode ? activeKey : undefined)
        : 0;

      let correctionDeltaEur: number;
      let deltaEur: number;
      let carryOutRipples = false;
      if (isCustomMode) {
        const atTarget = atTargetForYear(allTxns, dividendRows, realizations, year);
        const deTarget = involveDe ? deTargetForYear(frozenDeEvents, year) : 0;
        const activeGroup = frozenGroups.get(activeKey!);
        const settlement = settleCustomYear({
          params: params!,
          carry: customCarryIntoYear(params!, activeGroup?.eventsByYear ?? new Map(), year),
          existingEvents: activeGroup?.eventsByYear.get(year) ?? [],
          heldEur: floorCents(heldEur - atTarget - deTarget - customTarget),
          newEvents: [{ kind: 'dividend', amountEur: grossEur }],
        });
        correctionDeltaEur = settlement.correctionDeltaEur;
        deltaEur = settlement.newEventDeltasEur[0]!;
        carryOutRipples = true;
      } else if (country === TAX_COUNTRY_AT) {
        const deTarget = involveDe ? deTargetForYear(frozenDeEvents, year) : 0;
        const pool = existingAtPool(allTxns, dividendRows, realizations, year);
        const settlement = settleAtYear({
          ...pool,
          heldEur: floorCents(heldEur - deTarget - customTarget),
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
          heldEur: floorCents(heldEur - atTarget - customTarget),
          newEvents: [{ kind: 'dividend', amountEur: grossEur }],
        });
        correctionDeltaEur = settlement.correctionDeltaEur;
        deltaEur = settlement.newEventDeltasEur[0]!;
        carryOutRipples = true;
      }
      const regime: SettleRegime = isCustomMode ? 'custom' : country!;
      const correctionSpec = taxMovementForDelta(correctionDeltaEur);
      if (correctionSpec) {
        extras.push(
          correctionMovement(
            correctionSpec,
            await correctionSourceId(portfolioId),
            year,
            correctionNote(regime),
          ),
        );
      }
      // A backdated dividend entering a chained regime can consume carry
      // balances earlier years handed down — re-settle every LATER
      // engine-taxed year against its new combined target (zero-delta years
      // post nothing).
      if (carryOutRipples && rippleYears.length > 0) {
        const withNewDe =
          country === TAX_COUNTRY_DE
            ? deEventsByYear(
                deView,
                new Map([[year, [{ kind: 'dividend', amountEur: grossEur } as DeTaxableEvent]]]),
              )
            : frozenDeEvents;
        // The active custom group with the new dividend folded into its year.
        const withNewActive: CustomGroup | null = isCustomMode
          ? {
              key: activeKey!,
              params: params!,
              eventsByYear: mergeCustomEvents(
                frozenGroups.get(activeKey!)?.eventsByYear,
                new Map([
                  [year, [{ kind: 'dividend', amountEur: grossEur } as CustomTaxableEvent]],
                ]),
              ),
            }
          : null;
        for (const y of rippleYears) {
          const customY = involveCustom
            ? floorCents(
                customTargetForYear(frozenGroups, y, isCustomMode ? activeKey : undefined) +
                  (withNewActive ? customGroupTargetForYear(withNewActive, y) : 0),
              )
            : 0;
          const targetEur = floorCents(
            atTargetForYear(allTxns, dividendRows, realizations, y) +
              (involveDe ? deTargetForYear(withNewDe, y) : 0) +
              customY,
          );
          const heldY = heldForYear(allTxns, dividendRows, movements, y);
          const spec = taxMovementForDelta(floorCents(targetEur - heldY));
          if (spec) {
            extras.push(
              correctionMovement(
                spec,
                await correctionSourceId(portfolioId),
                y,
                correctionNote(regime),
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
                settings.mode === 'custom'
                  ? 'custom'
                  : taxCountry === TAX_COUNTRY_DE
                    ? TAX_COUNTRY_DE
                    : TAX_COUNTRY_AT,
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
        taxParams,
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

    // An engine-taxed dividend's removal re-settles its year against the
    // remaining rows — and, when a chained regime is involved, every later
    // engine-taxed year: the gross it contributed may have been consuming
    // carry balances that now chain further (the combined AT+DE+custom target
    // catches every component).
    const corrections: NewCashMovement[] = [];
    if (dividend.taxMode === 'country_specific' || dividend.taxMode === 'custom') {
      const year = viennaYearOfDate(dividend.executedAt);
      const deletedWasCustom = dividend.taxMode === 'custom';
      const deletedWasDe =
        !deletedWasCustom && rowEngineCountry(dividend.taxCountry) === TAX_COUNTRY_DE;
      const involveDe = deletedWasDe || portfolioHasDeRows(allTxns, remainingDividends);
      const involveCustom = deletedWasCustom || portfolioHasCustomRows(allTxns, remainingDividends);
      const involveChain =
        involveDe ||
        (involveCustom && customChainSensitive(allTxns, remainingDividends, null)) ||
        // The deleted dividend's own set may chain — its gross fed carry.
        (deletedWasCustom && customChainSensitive([], [dividend], null));

      const affectedYears = new Set<number>([year]);
      if (involveChain) {
        for (const y of engineTaxedYears(allTxns, remainingDividends, remainingMovements)) {
          if (y > year) affectedYears.add(y);
        }
      }

      const neededAssetIds = new Set<string>();
      for (const t of allTxns) {
        if (t.side !== 'sell' || !isEngineTaxed(t.taxMode)) continue;
        if (
          affectedYears.has(viennaYearOfDate(t.executedAt)) ||
          (involveDe && isDeSell(t)) ||
          (involveCustom && isCustomSell(t))
        ) {
          neededAssetIds.add(t.assetId);
        }
      }
      let realizations = new Map<string, SellRealizationEur>();
      let fifoRealizations = new Map<string, SellRealizationEur>();
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
        if (involveDe || involveCustom) fifoRealizations = realizationsById(taxables, 'fifo');
      }
      const deView = buildDeView(allTxns, remainingDividends, fifoRealizations, assetsById);
      const frozenDeEvents = involveDe
        ? deEventsByYear(deView)
        : new Map<number, DeTaxableEvent[]>();
      const frozenGroups = involveCustom
        ? customGroups(buildCustomView(allTxns, remainingDividends, realizations, fifoRealizations))
        : new Map<string, CustomGroup>();

      for (const y of [...affectedYears].sort((a, b) => a - b)) {
        const targetEur = floorCents(
          atTargetForYear(allTxns, remainingDividends, realizations, y) +
            (involveDe ? deTargetForYear(frozenDeEvents, y) : 0) +
            (involveCustom ? customTargetForYear(frozenGroups, y) : 0),
        );
        const heldEur = heldForYear(allTxns, remainingDividends, remainingMovements, y);
        const spec = taxMovementForDelta(floorCents(targetEur - heldEur));
        if (spec) {
          corrections.push(
            correctionMovement(
              spec,
              await correctionSourceId(portfolioId),
              y,
              correctionNote(
                deletedWasCustom ? 'custom' : deletedWasDe ? TAX_COUNTRY_DE : TAX_COUNTRY_AT,
              ),
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
    /** FIFO realizations — populated when the portfolio has DE or FIFO-custom rows. */
    deRealizations: Map<string, SellRealizationEur>;
    /** Sells frozen under a FIFO-based custom parameter set (V5-P4c). */
    customFifoSellIds: Set<string>;
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
    const customFifoSellIds = new Set(
      transactions.filter((t) => isCustomFifoSell(t)).map((t) => t.id),
    );
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
      if (involveDe || customFifoSellIds.size > 0) {
        deRealizations = realizationsById(taxables, 'fifo');
      }
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
      customFifoSellIds,
      frozenDeEvents,
      assetsById,
    };
  }

  /**
   * The realization of one sell as the report states it: a DE-frozen sell —
   * or one frozen under a FIFO-based custom parameter set (V5-P4c) — shows
   * its FIFO realization (that IS the taxed truth next to its frozen tax);
   * every other sell keeps the moving-average view — for AT rows that is the
   * taxed truth, and for untaxed rows the pre-V5-P4 financial fact.
   */
  function reportRealization(
    state: ReportState,
    t: TransactionRecord,
  ): SellRealizationEur | undefined {
    return isDeSell(t) || state.customFifoSellIds.has(t.id)
      ? state.deRealizations.get(t.id)
      : state.realizations.get(t.id);
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
    // V5-P4c fields are OMITTED when absent so pre-V5-P4 responses (and every
    // non-custom, default-less mode) stay byte-identical.
    const custom =
      record.mode === 'custom' ? customTaxParamsSchema.safeParse(record.customParams) : null;
    return {
      mode: record.mode,
      country: toContractCountry(record.country),
      ...(custom?.success ? { custom: custom.data } : {}),
      ...(record.manualDefaultAmountEur !== null
        ? { manualDefaultAmountEur: record.manualDefaultAmountEur }
        : {}),
      ...(record.manualDefaultRatePct !== null
        ? { manualDefaultRatePct: record.manualDefaultRatePct }
        : {}),
    };
  }

  return {
    async getSettings(userId) {
      return toSettingsResponse(await effectiveSettings(userId));
    },

    async updateSettings(userId, input) {
      const record = await taxRepo.setUserTaxSettings(userId, settingsRecordFromInput(input));
      return toSettingsResponse(record);
    },

    getEffectiveSettings: effectiveSettings,
    getPortfolioTaxSettings,

    async setPortfolioTaxOverride(userId, portfolioId, input) {
      await requireOwnedPortfolio(userId, portfolioId);
      // Normalise exactly as the user-default write does, so the stored
      // override can never carry stray mode-dependent fields. The jsonb value
      // stores custom params under `custom` (the wire shape parseTaxOverride
      // reads back).
      const record = settingsRecordFromInput(input);
      const value = {
        mode: record.mode,
        country: record.country,
        ...(record.customParams !== null ? { custom: record.customParams } : {}),
        ...(record.manualDefaultAmountEur !== null
          ? { manualDefaultAmountEur: record.manualDefaultAmountEur }
          : {}),
        ...(record.manualDefaultRatePct !== null
          ? { manualDefaultRatePct: record.manualDefaultRatePct }
          : {}),
      };
      await portfolioSettingsRepo.setSetting(portfolioId, PORTFOLIO_SETTING_KEY_TAX, value);
      return getPortfolioTaxSettings(userId, portfolioId);
    },

    async clearPortfolioTaxOverride(userId, portfolioId) {
      await requireOwnedPortfolio(userId, portfolioId);
      await portfolioSettingsRepo.deleteSetting(portfolioId, PORTFOLIO_SETTING_KEY_TAX);
      return getPortfolioTaxSettings(userId, portfolioId);
    },

    planTransactionTaxes,
    planTransactionDeleteCorrections,
    recordDividend,
    listDividends,
    deleteDividend,
    getYearReports,
    getYearReport,
  };
}

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
  dePotCategoryForAssetType,
  manualTaxEur,
  realizedSellsEur,
  settleAtYear,
  settleCustomYear,
  settleDeYear,
  settleFiYear,
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  TAX_COUNTRY_FI,
  taxMovementForDelta,
  viennaYearOf,
  type CostBasisStrategy,
  type CustomTaxableEvent,
  type CustomTaxParams,
  type DePotCategory,
  type DeTaxableEvent,
  type SellRealizationEur,
  type SupportedTaxCountry,
  type TaxableTransaction,
  type TaxMovementSpec,
} from '../../domain/tax';
import {
  deEventsByYear,
  dePotsInForYear,
  deTargetForYear,
  deYearStateForYear,
  fiTargetForYear,
  isDeDividend,
  isDeSell,
  isFiDividend,
  isFiSell,
  portfolioHasDeRows,
  portfolioHasFiRows,
  rowEngineCountry,
  type DeRowView,
} from './countryState';
import {
  closedYearSlice,
  isDerivableDividend,
  isDerivableSell,
  openCountryOf,
  openDerivableYears,
  openRegimeOf,
  openRegimeStrategy,
  settleOpenYears,
  type NewOpenEvent,
  type OpenRegime,
  type OpenYearRowView,
  type OpenYearSettlement,
} from './openYear';
import {
  customCarryIntoYear,
  customGroups,
  customParamsKey,
  isCustomFifoSell,
  isCustomSell,
  mergeCustomEvents,
  type CustomGroup,
  type CustomRowView,
} from './customState';
import {
  atTargetForYear,
  buildFrozenComponentState,
  closedReshapeCorrections,
  customTargetForYear,
  existingAtPool,
  heldForYear,
  isEngineTaxed,
  lockedResidueForYear,
  scopeClosedMutation,
  viennaYearOfDate,
  type FrozenComponentState,
} from './closedSettlement';
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
 *  - **A closed year's open-era state is locked (#635).** Every closed-year
 *    mutation settles the year by the CHANGE in its standalone frozen
 *    decomposition (ΔF): the residue `held − Σ standalone frozen targets` is
 *    computed on the PRE-mutation state and carried into the post-mutation
 *    target, so whatever joint-pool state the live derivation reached —
 *    healed rows, deliberate refunds, allowance/threshold coupling frozen
 *    into attached marginals — survives by construction and is never
 *    reconciled away (see {@link lockedResidueForYear}).
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
   * after the delete): removing an engine-taxed sell — or a buy that feeds
   * sells' bases — re-shapes year pools, and each affected year settles
   * append-only against the simulated post-delete state (open years under the
   * CURRENT regime — #635 live model — hence the `userId` for settings).
   */
  planTransactionDeleteCorrections(
    userId: string,
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
const NOTE_FI_WITHHELD = 'Capital-income tax withheld (FI)';
const NOTE_FI_REFUNDED = 'Capital-income tax refunded (FI)';
const NOTE_FI_CORRECTION = 'Tax year correction (FI)';
const NOTE_OFF_CORRECTION = 'Tax year correction (tax tracking off)';
/**
 * Open-year LIVE-derivation corrections (#635) carry their own note strings,
 * distinct from the closed-year machinery's, so the cash history states which
 * corrections the live derivation posted (a mode switch healing a year reads
 * differently from a backdated-trade reconciliation). Descriptive only: the
 * closed-year lock derives each year's residue from held-vs-decomposition
 * state ({@link lockedResidueForYear}), never from these markers — attached
 * joint-pool marginals carry open-era state too, and notes could not see it.
 */
const NOTE_AT_LIVE_CORRECTION = 'Live tax correction (AT)';
const NOTE_DE_LIVE_CORRECTION = 'Live tax correction (DE)';
const NOTE_FI_LIVE_CORRECTION = 'Live tax correction (FI)';
const NOTE_CUSTOM_LIVE_CORRECTION = 'Live tax correction (custom rules)';

type EngineCountry = SupportedTaxCountry;
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
      : regime === TAX_COUNTRY_FI
        ? kind === 'tax_withholding'
          ? NOTE_FI_WITHHELD
          : NOTE_FI_REFUNDED
        : kind === 'tax_withholding'
          ? NOTE_AT_WITHHELD
          : NOTE_AT_REFUNDED;

const correctionNote = (regime: SettleRegime): string =>
  regime === 'custom'
    ? NOTE_CUSTOM_CORRECTION
    : regime === TAX_COUNTRY_DE
      ? NOTE_DE_CORRECTION
      : regime === TAX_COUNTRY_FI
        ? NOTE_FI_CORRECTION
        : NOTE_AT_CORRECTION;

/** The correction note of an open-year regime (`none` backs engine tax out). */
const openCorrectionNote = (regime: OpenRegime): string =>
  regime.kind === 'none'
    ? NOTE_OFF_CORRECTION
    : regime.kind === 'custom'
      ? NOTE_CUSTOM_LIVE_CORRECTION
      : regime.kind === 'country' && regime.country === TAX_COUNTRY_DE
        ? NOTE_DE_LIVE_CORRECTION
        : regime.kind === 'country' && regime.country === TAX_COUNTRY_FI
          ? NOTE_FI_LIVE_CORRECTION
          : NOTE_AT_LIVE_CORRECTION;

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
    openCountryOf(settings.country);

  /** A stored 2-char country narrowed to the contract enum (`AT`|`DE`|`FI`|null). */
  const toContractCountry = (country: string | null): EngineCountry | null =>
    country === TAX_COUNTRY_AT || country === TAX_COUNTRY_DE || country === TAX_COUNTRY_FI
      ? country
      : null;

  /** The first OPEN Vienna year (#635): the current year at `now`. Years before it are closed. */
  const openFromYearNow = (): number => viennaYearOf(new Date(now()).toISOString());

  /** The open-year regime of the resolved settings ({@link openRegimeOf}). */
  const openRegimeForSettings = (settings: UserTaxSettingsRecord): OpenRegime =>
    openRegimeOf(settings, activeCustomParams);

  /** Assemble the {@link OpenYearRowView} the open-year derivation runs over. */
  function buildOpenView(
    transactions: readonly TransactionRecord[],
    dividendRows: readonly DividendRecord[],
    realizations: ReadonlyMap<string, SellRealizationEur>,
    fifoRealizations: ReadonlyMap<string, SellRealizationEur>,
    assetsById: ReadonlyMap<string, AssetRow>,
  ): OpenYearRowView {
    return {
      transactions,
      dividendRows,
      realizationsFor: (strategy: CostBasisStrategy) =>
        strategy === 'fifo' ? fifoRealizations : realizations,
      categoryOf: categoryLookup(assetsById),
      yearOf: viennaYearOfDate,
    };
  }

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

  /**
   * #656 round 4: a batch recorded under a NON-ENGINE mode (`none` /
   * `manual_per_trade`) still reshapes engine-frozen history — its (back)dated
   * buys re-base the moving average under existing engine-taxed sells, and any
   * batch trade of a DE/FI/custom-FIFO asset shifts that asset's frozen sells'
   * lot consumption. The engine write path and the delete path settle such
   * years append-only; without this pass a non-engine write would silently
   * drift held away from the frozen decomposition, and the year's next touch
   * would absorb the drift into the locked residue
   * ({@link lockedResidueForYear}) permanently.
   *
   * Each affected closed-machinery year settles by exactly the CHANGE in its
   * standalone frozen decomposition — the centralized
   * {@link closedReshapeCorrections} (#669): with no new engine rows and no
   * cascaded movements, both held terms cancel and the correction reduces to
   * `ΔF = Σ F_after − Σ F_before`, so the year's locked open-era state
   * survives by construction. `manual` treats every year as closed-machinery
   * (`openFrom = ∞`, mirroring {@link planTransactionDeleteCorrections});
   * `none` settles closed years only — its open years re-derive to the
   * tracking-off target on the next read.
   */
  async function planNonEngineReshapeCorrections(
    portfolioId: string,
    inputs: readonly TransactionInput[],
    assetsById: ReadonlyMap<string, AssetRow>,
    openFrom: number,
  ): Promise<{ extras: BatchCashMovement[]; proposed: SourcedCashMovement[] }> {
    const batchAssets = new Set(inputs.map((i) => i.assetId));
    const allTxns = await transactionRepo.listForPortfolio(portfolioId);
    // Fast path: every affected-year source below requires an engine-frozen
    // sell of a batch asset (lots and averages are per asset), so a portfolio
    // without one skips the remaining loads entirely.
    const touchesEngineSells = allTxns.some(
      (t) => t.side === 'sell' && isEngineTaxed(t.taxMode) && batchAssets.has(t.assetId),
    );
    if (!touchesEngineSells) return { extras: [], proposed: [] };
    const [dividendRows, movements] = await Promise.all([
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    // The choke point (#669): a non-engine batch adds no engine rows, so both
    // sides share the row set — its trades enter only through the recomputed
    // realizations of the mutated assets.
    const rows = { transactions: allTxns, dividendRows };
    const scope = scopeClosedMutation({
      before: rows,
      after: rows,
      movements,
      mutationYears: [],
      mutatedAssetIds: batchAssets,
      openFrom,
    });
    if (scope.years.length === 0) return { extras: [], proposed: [] };
    const { involveDe, involveFi, involveCustom } = scope;

    // The EUR replay both sides need: engine sells of the affected years plus
    // — with a chained regime involved — every DE/custom-sell asset anywhere.
    const yearsSet = new Set(scope.years);
    const neededAssetIds = new Set<string>();
    for (const t of allTxns) {
      if (t.side !== 'sell' || !isEngineTaxed(t.taxMode)) continue;
      if (
        yearsSet.has(viennaYearOfDate(t.executedAt)) ||
        (involveDe && isDeSell(t)) ||
        (involveCustom && isCustomSell(t))
      ) {
        neededAssetIds.add(t.assetId);
      }
    }
    const mergedAssets = new Map(assetsById);
    const missingAssetIds = [...neededAssetIds].filter((id) => !mergedAssets.has(id));
    if (missingAssetIds.length > 0) {
      for (const [id, row] of await loadAssets(missingAssetIds)) mergedAssets.set(id, row);
    }
    // One FX pass serves both sides: the post state includes the pending
    // trades (they shift lots/averages even though they carry no engine tax),
    // the baseline filters them back out.
    const postTaxables = await buildTaxables(
      allTxns,
      inputs.map((input, index) => ({ tempId: `pending-${index}`, input })),
      neededAssetIds,
      currencyLookup(mergedAssets),
      createTradeDateConverter(fxWriteError),
    );
    const pendingIds = new Set(inputs.map((_, index) => `pending-${index}`));
    const baselineTaxables = postTaxables.filter((t) => !pendingIds.has(t.id));

    const componentState = (taxables: readonly TaxableTransaction[]): FrozenComponentState => {
      const realizations = realizationsById(taxables);
      const fifo =
        involveDe || involveFi || involveCustom
          ? realizationsById(taxables, 'fifo')
          : new Map<string, SellRealizationEur>();
      return buildFrozenComponentState({
        transactions: allTxns,
        dividendRows,
        realizations,
        fifoRealizations: fifo,
        categoryOf: categoryLookup(mergedAssets),
        involveDe,
        involveFi,
        involveCustom,
      });
    };
    const before = componentState(baselineTaxables);
    const after = componentState(postTaxables);

    // Labeled like a deleted buy's reshape: by the reshaped rows' regime
    // (custom over DE over FI over AT when mixed).
    const reshaped = allTxns.filter(
      (t) => t.side === 'sell' && isEngineTaxed(t.taxMode) && batchAssets.has(t.assetId),
    );
    let noteRegime: SettleRegime = TAX_COUNTRY_AT;
    if (reshaped.some(isCustomSell)) noteRegime = 'custom';
    else if (reshaped.some(isDeSell)) noteRegime = TAX_COUNTRY_DE;
    else if (reshaped.some(isFiSell)) noteRegime = TAX_COUNTRY_FI;

    const extras: BatchCashMovement[] = [];
    const proposed: SourcedCashMovement[] = [];
    const nowIso = new Date(now()).toISOString();
    for (const { year, deltaEur } of closedReshapeCorrections({
      years: scope.years,
      before,
      movementsBefore: movements,
      after,
      movementsAfter: movements,
    })) {
      const spec = taxMovementForDelta(deltaEur);
      if (!spec) continue;
      const sourceId = await correctionSourceId(portfolioId);
      extras.push({
        kind: spec.kind,
        amountEur: spec.amountEur,
        sourceId,
        note: correctionNote(noteRegime),
        taxYear: year,
        executedAt: new Date(now()),
      });
      proposed.push({ kind: spec.kind, amountEur: spec.amountEur, occurredAt: nowIso, sourceId });
    }
    return { extras, proposed };
  }

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
      // #656 round 4: untaxed rows can still reshape engine-frozen CLOSED
      // years — settle those by ΔF (open years re-derive on the next read).
      const reshape = await planNonEngineReshapeCorrections(
        portfolioId,
        inputs,
        assetsById,
        openFromYearNow(),
      );
      return { rows, extras: reshape.extras, proposed: reshape.proposed };
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
      // #656 round 4: manual derives nothing, so EVERY year is closed-
      // machinery (`openFrom = ∞`, mirroring the delete path) — settle the
      // batch's engine-frozen reshapes by ΔF before returning.
      const reshape = await planNonEngineReshapeCorrections(
        portfolioId,
        inputs,
        assetsById,
        Number.POSITIVE_INFINITY,
      );
      return {
        rows,
        extras: reshape.extras,
        proposed: [...proposed, ...reshape.proposed],
      };
    }

    // ── Engine modes: country-specific (AT | DE | FI) or custom (V5-P4c).
    // #635 live model: OPEN years (>= the current Vienna year) re-derive in
    // full under the ACTIVE regime — every derivable row of the year enters
    // the settlement regardless of the mode frozen onto it at entry. CLOSED
    // years keep the recording-time coexistence machinery: a year's held tax
    // is the SUM of every frozen regime's independent target — AT pool + DE
    // year + FI pool + one component per frozen custom parameter group. ─────
    const isCustomMode = settings.mode === 'custom';
    const activeParams = isCustomMode ? activeCustomParams(settings) : null;
    const activeKey = activeParams ? customParamsKey(activeParams) : undefined;
    const country: EngineCountry | null = isCustomMode ? null : effectiveCountry(settings);
    const regime: SettleRegime = isCustomMode ? 'custom' : country!;
    const openRegime: OpenRegime = isCustomMode
      ? { kind: 'custom', params: activeParams! }
      : { kind: 'country', country: country! };
    const openFrom = openFromYearNow();
    const openStrategy = openRegimeStrategy(openRegime);
    const [allTxns, dividendRows, movements] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    // The choke point (#669): affected CLOSED years + involved regimes from
    // mode-independent facts — the batch's sell years, its mutated assets
    // (realizations are per-asset: a (back)dated trade reshapes its asset's
    // moving average and FIFO lot consumption under engine-frozen sells in
    // any year), and the chain-sensitive ripple. No per-regime gate here.
    const batchAssets = new Set(inputs.map((i) => i.assetId));
    const sideRows = { transactions: allTxns, dividendRows };
    const scope = scopeClosedMutation({
      before: sideRows,
      after: sideRows,
      movements,
      mutationYears: pendingSells.map((p) =>
        viennaYearOf(new Date(p.input.executedAt).toISOString()),
      ),
      mutatedAssetIds: batchAssets,
      recordingRegime: openRegime,
      openFrom,
    });
    const { involveDe, involveFi, involveCustom } = scope;
    const closedYears = scope.years;

    // Open years (#635 live model): the years the batch sells into, plus
    // every derivable open-year sell of a mutated asset (the batch's trades
    // shift its lot consumption / moving average regardless of frozen mode).
    const openSeeds = new Set<number>(
      pendingSells
        .map((p) => viennaYearOf(new Date(p.input.executedAt).toISOString()))
        .filter((y) => y >= openFrom),
    );
    for (const t of allTxns) {
      if (!isDerivableSell(t) || !batchAssets.has(t.assetId)) continue;
      const year = viennaYearOfDate(t.executedAt);
      if (year >= openFrom) openSeeds.add(year);
    }
    // #635 chain integrity: once ANY open year settles — or a closed chained
    // year changed (its carry-outs cross the boundary) — settle EVERY
    // derivable open year, so the DE/custom carry chain stays whole. A year
    // whose target did not move settles to a zero correction and posts nothing.
    if (openSeeds.size > 0 || (scope.chainSensitive && closedYears.length > 0)) {
      const derivableView = { transactions: allTxns, dividendRows, yearOf: viennaYearOfDate };
      for (const year of openDerivableYears(derivableView, movements, openFrom)) {
        openSeeds.add(year);
      }
    }

    // Assets whose EUR replay the affected pools need: every batch-sell asset,
    // every asset with an existing engine-taxed sell in an affected year (or a
    // derivable sell in an affected OPEN year — #635), and — with a
    // chain-spanning regime involved — every DE/custom-sell asset anywhere
    // (carry chains span all prior years, and the custom grouping derivation
    // replays every custom sell).
    const closedYearsSet = new Set(closedYears);
    const neededAssetIds = new Set(pendingSells.map((p) => p.input.assetId));
    for (const t of allTxns) {
      if (t.side !== 'sell') continue;
      const year = viennaYearOfDate(t.executedAt);
      const derivableOpen = year >= openFrom && isDerivableSell(t);
      if (!derivableOpen && !isEngineTaxed(t.taxMode)) continue;
      if (
        closedYearsSet.has(year) ||
        openSeeds.has(year) ||
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
      involveDe || involveFi || involveCustom || openStrategy === 'fifo'
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

    const yearSellsOf = (year: number) =>
      pendingSells
        .filter((p) => viennaYearOf(new Date(p.input.executedAt).toISOString()) === year)
        .sort(
          (a, b) =>
            Date.parse(a.input.executedAt) - Date.parse(b.input.executedAt) || a.index - b.index,
        );
    /** Freeze one settled pending sell onto its row (+ settlement movement). */
    const assignSellRow = async (
      pendingSell: { index: number; tempId: string; input: TransactionInput },
      deltaEur: number,
      year: number,
    ): Promise<void> => {
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
    };
    const pushCorrection = async (
      correctionDeltaEur: number,
      year: number,
      note: string = correctionNote(regime),
    ): Promise<void> => {
      const correctionSpec = taxMovementForDelta(correctionDeltaEur);
      if (!correctionSpec) return;
      const sourceId = await correctionSourceId(portfolioId);
      extras.push({
        kind: correctionSpec.kind,
        amountEur: correctionSpec.amountEur,
        sourceId,
        note,
        taxYear: year,
        executedAt: new Date(now()),
      });
      proposed.push({
        kind: correctionSpec.kind,
        amountEur: correctionSpec.amountEur,
        occurredAt: nowIso,
        sourceId,
      });
    };

    // ── Closed years: recording-time coexistence semantics (pre-#635), plus
    // the year's locked residue — settlements apply exactly the CHANGE in the
    // standalone frozen decomposition ({@link lockedResidueForYear}). The
    // baseline side uses realizations WITHOUT the pending batch: its
    // (back)dated trades reshape existing rows' gains, and that reshape is
    // precisely the delta a correction may carry. ───────────────────────────
    let closedBaseline: FrozenComponentState | null = null;
    if (closedYears.length > 0) {
      const pendingIds = new Set(inputs.map((_, index) => `pending-${index}`));
      const baselineTaxables = taxables.filter((t) => !pendingIds.has(t.id));
      const baselineRealizations = realizationsById(baselineTaxables);
      const baselineFifo =
        involveDe || involveFi || involveCustom
          ? realizationsById(baselineTaxables, 'fifo')
          : new Map<string, SellRealizationEur>();
      closedBaseline = buildFrozenComponentState({
        transactions: allTxns,
        dividendRows,
        realizations: baselineRealizations,
        fifoRealizations: baselineFifo,
        categoryOf: categoryLookup(mergedAssets),
        involveDe,
        involveFi,
        involveCustom,
      });
    }
    for (const year of closedYears) {
      const yearSells = yearSellsOf(year);
      const heldEur = heldForYear(allTxns, dividendRows, movements, year);
      const residueEur = lockedResidueForYear(closedBaseline!, movements, year);
      // The frozen custom groups' components — every group when a country
      // engine settles; all but the ACTIVE group when custom settles (that one
      // is steered by settleCustomYear itself).
      const customTarget = involveCustom
        ? customTargetForYear(frozenGroups, year, isCustomMode ? activeKey : undefined)
        : 0;
      // The FI component of a closed year (#635): the frozen FI rows' pool
      // target — steered by settleFiYear itself when FI is the active country.
      const fiTargetOf = (): number =>
        involveFi
          ? fiTargetForYear(allTxns, dividendRows, fifoRealizations, year, viennaYearOfDate)
          : 0;
      const fiTarget = country === TAX_COUNTRY_FI ? 0 : fiTargetOf();

      let correctionDeltaEur: number;
      let newEventDeltasEur: number[];
      if (isCustomMode) {
        // Custom: AT/DE/FI components stay put (their recomputed targets
        // reflect any batch backdating); the active group's carry chains over
        // its frozen rows plus already-settled pending events of earlier years.
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
          heldEur: floorCents(heldEur - atTarget - deTarget - fiTarget - customTarget - residueEur),
          newEvents,
        });
        correctionDeltaEur = settlement.correctionDeltaEur;
        newEventDeltasEur = settlement.newEventDeltasEur;
        if (newEvents.length > 0) {
          pendingCustomEvents.set(year, [...(pendingCustomEvents.get(year) ?? []), ...newEvents]);
        }
      } else if (country === TAX_COUNTRY_AT) {
        // The DE + FI + custom components (frozen rows only — an AT batch never
        // adds their events, but its backdated trades may have re-shaped their
        // lot bases; the recomputed realizations already reflect that).
        const deTarget = involveDe ? deTargetForYear(deEventsWithPending(), year) : 0;
        const pool = existingAtPool(allTxns, dividendRows, realizations, year);
        const settlement = settleAtYear({
          ...pool,
          heldEur: floorCents(heldEur - deTarget - fiTarget - customTarget - residueEur),
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
      } else if (country === TAX_COUNTRY_FI) {
        // FI (#635): pool-style like AT over the frozen FI rows, FIFO gains,
        // progressive target; the AT/DE/custom components stay put.
        const atTarget = atTargetForYear(allTxns, dividendRows, realizations, year);
        const deTarget = involveDe ? deTargetForYear(deEventsWithPending(), year) : 0;
        const existingGainsEur: number[] = [];
        const existingDividendsEur: number[] = [];
        for (const t of allTxns) {
          if (!isFiSell(t) || viennaYearOfDate(t.executedAt) !== year) continue;
          const realization = fifoRealizations.get(t.id);
          if (!realization) {
            throw new Error(`Tax engine: no FIFO realization for FI sell ${t.id}`);
          }
          existingGainsEur.push(realization.realizedPnlEur);
        }
        for (const d of dividendRows) {
          if (isFiDividend(d) && viennaYearOfDate(d.executedAt) === year) {
            existingDividendsEur.push(d.grossAmountEur);
          }
        }
        const settlement = settleFiYear({
          existingGainsEur,
          existingDividendsEur,
          heldEur: floorCents(heldEur - atTarget - deTarget - customTarget - residueEur),
          newEvents: yearSells.map((p) => {
            const realization = fifoRealizations.get(p.tempId);
            if (!realization) {
              throw new Error(`Tax engine: no FIFO realization for pending sell ${p.tempId}`);
            }
            return { kind: 'sell_gain' as const, amountEur: realization.realizedPnlEur };
          }),
        });
        correctionDeltaEur = settlement.correctionDeltaEur;
        newEventDeltasEur = settlement.newEventDeltasEur;
      } else {
        // DE: the AT + FI + custom components stay put; pots chain over frozen
        // rows plus the already-settled pending events of earlier years.
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
          heldEur: floorCents(heldEur - atTarget - fiTarget - customTarget - residueEur),
          newEvents,
        });
        correctionDeltaEur = settlement.correctionDeltaEur;
        newEventDeltasEur = settlement.newEventDeltasEur;
        if (newEvents.length > 0) pendingDeEvents.set(year, newEvents);
      }

      await pushCorrection(correctionDeltaEur, year);
      for (const [i, pendingSell] of yearSells.entries()) {
        await assignSellRow(pendingSell, newEventDeltasEur[i]!, year);
      }
    }

    // ── Open years (#635): full live re-derivation under the active regime. ─
    const openYearsToSettle = [...openSeeds].sort((a, b) => a - b);
    if (openYearsToSettle.length > 0) {
      const openView = buildOpenView(
        allTxns,
        dividendRows,
        realizations,
        fifoRealizations,
        mergedAssets,
      );
      const openYearSells = new Map<number, ReturnType<typeof yearSellsOf>>();
      const newEventsByYear = new Map<number, NewOpenEvent[]>();
      for (const year of openYearsToSettle) {
        const yearSells = yearSellsOf(year);
        openYearSells.set(year, yearSells);
        if (yearSells.length > 0) {
          newEventsByYear.set(
            year,
            yearSells.map((p) => ({
              kind: 'sell_gain' as const,
              tempId: p.tempId,
              assetId: p.input.assetId,
            })),
          );
        }
      }
      const settlements = settleOpenYears({
        regime: openRegime,
        view: openView,
        years: openYearsToSettle,
        heldOf: (year) => heldForYear(allTxns, dividendRows, movements, year),
        closedDeEvents: involveDe ? closedYearSlice(deEventsWithPending(), openFrom) : undefined,
        closedCustomEvents: isCustomMode
          ? closedYearSlice(
              mergeCustomEvents(frozenGroups.get(activeKey!)?.eventsByYear, pendingCustomEvents),
              openFrom,
            )
          : undefined,
        newEventsByYear,
      });
      for (const settlement of settlements) {
        await pushCorrection(
          settlement.correctionDeltaEur,
          settlement.year,
          openCorrectionNote(openRegime),
        );
        const yearSells = openYearSells.get(settlement.year) ?? [];
        for (const [i, pendingSell] of yearSells.entries()) {
          await assignSellRow(pendingSell, settlement.newEventDeltasEur[i]!, settlement.year);
        }
      }
    }

    return { rows, extras, proposed };
  }

  // ── Delete corrections ─────────────────────────────────────────────────────

  async function planTransactionDeleteCorrections(
    userId: string,
    portfolioId: string,
    transaction: TransactionRecord,
  ): Promise<NewCashMovement[]> {
    const isCsSell = transaction.side === 'sell' && transaction.taxMode === 'country_specific';
    const deletedWasCustom = isCustomSell(transaction);
    // #635: open years re-settle under the CURRENT regime (live model); a
    // `manual` regime derives nothing, so its open years keep the frozen
    // coexistence semantics exactly like closed years.
    const settings = await effectiveSettings(userId, portfolioId);
    const openRegime = openRegimeForSettings(settings);
    const openFrom = openRegime.kind === 'manual' ? Number.POSITIVE_INFINITY : openFromYearNow();
    const openStrategy = openRegimeStrategy(openRegime);
    const [allTxns, dividendRows, movements] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);

    // Simulate the post-delete world: the row and its movements are gone.
    const remainingTxns = allTxns.filter((t) => t.id !== transaction.id);
    const remainingMovements = movements.filter((m) => m.transactionId !== transaction.id);

    const deletedWasDe = isCsSell && rowEngineCountry(transaction.taxCountry) === TAX_COUNTRY_DE;
    const deletedWasFi = isCsSell && rowEngineCountry(transaction.taxCountry) === TAX_COUNTRY_FI;

    // The choke point (#669): affected CLOSED years + involved regimes from
    // mode-independent facts — the deleted row's year, its asset's engine-
    // frozen sells on either side (their recomputed gains / FIFO lots shift),
    // and the chain-sensitive ripple. The delete adds no engine events, so
    // no recording regime enters the scoping.
    const deletedYear = viennaYearOfDate(transaction.executedAt);
    const scope = scopeClosedMutation({
      before: { transactions: allTxns, dividendRows },
      after: { transactions: remainingTxns, dividendRows },
      movements,
      mutationYears: [deletedYear],
      mutatedAssetIds: new Set([transaction.assetId]),
      openFrom,
    });
    const { involveDe, involveFi, involveCustom } = scope;

    // Open years (#635): the deleted derivable row's own open year, plus
    // every derivable open-year sell of the asset (its moving average / lot
    // consumption shifts), widened to all derivable open years once any
    // settles or a closed chained year changed.
    const openSeeds = new Set<number>();
    if (
      transaction.side === 'sell' &&
      transaction.taxMode !== 'manual_per_trade' &&
      deletedYear >= openFrom
    ) {
      openSeeds.add(deletedYear);
    }
    for (const t of remainingTxns) {
      if (t.assetId !== transaction.assetId || !isDerivableSell(t)) continue;
      const year = viennaYearOfDate(t.executedAt);
      if (year >= openFrom) openSeeds.add(year);
    }
    // #635 chain integrity: once any open year re-settles, settle all of them.
    if (openSeeds.size > 0 || (scope.chainSensitive && scope.years.length > 0)) {
      const derivableView = {
        transactions: remainingTxns,
        dividendRows,
        yearOf: viennaYearOfDate,
      };
      for (const year of openDerivableYears(derivableView, remainingMovements, openFrom)) {
        openSeeds.add(year);
      }
    }
    if (scope.years.length === 0 && openSeeds.size === 0) return [];

    const closedYearsSet = new Set(scope.years);
    const neededAssetIds = new Set<string>();
    // The pre-delete baseline needs the deleted row's own realization when it
    // was engine-frozen — its standalone contribution is part of the delta.
    if (isCsSell || deletedWasCustom) neededAssetIds.add(transaction.assetId);
    for (const t of remainingTxns) {
      if (t.side !== 'sell') continue;
      const year = viennaYearOfDate(t.executedAt);
      const derivableOpen = year >= openFrom && isDerivableSell(t);
      if (!derivableOpen && !isEngineTaxed(t.taxMode)) continue;
      if (
        closedYearsSet.has(year) ||
        openSeeds.has(year) ||
        (involveDe && isDeSell(t)) ||
        (involveCustom && isCustomSell(t))
      ) {
        neededAssetIds.add(t.assetId);
      }
    }

    let realizations = new Map<string, SellRealizationEur>();
    let fifoRealizations = new Map<string, SellRealizationEur>();
    let baselineRealizations = new Map<string, SellRealizationEur>();
    let baselineFifo = new Map<string, SellRealizationEur>();
    let assetsById = new Map<string, AssetRow>();
    if (neededAssetIds.size > 0) {
      assetsById = await loadAssets(allTxns.map((t) => t.assetId));
      // One FX pass over the PRE-delete rows serves both sides: filtering the
      // deleted row out replays exactly the post-delete realizations.
      const baselineTaxables = await buildTaxables(
        allTxns,
        [],
        neededAssetIds,
        currencyLookup(assetsById),
        createTradeDateConverter(fxWriteError),
      );
      const taxables = baselineTaxables.filter((t) => t.id !== transaction.id);
      realizations = realizationsById(taxables);
      baselineRealizations = realizationsById(baselineTaxables);
      if (involveDe || involveFi || involveCustom || openStrategy === 'fifo') {
        fifoRealizations = realizationsById(taxables, 'fifo');
        baselineFifo = realizationsById(baselineTaxables, 'fifo');
      }
    }
    // The POST-delete decomposition and the PRE-delete baseline the closed
    // years' locked residue reads from — both through the one shared builder.
    const categoryOf = categoryLookup(assetsById);
    const afterState = buildFrozenComponentState({
      transactions: remainingTxns,
      dividendRows,
      realizations,
      fifoRealizations,
      categoryOf,
      involveDe,
      involveFi,
      involveCustom,
    });
    const closedBaseline = buildFrozenComponentState({
      transactions: allTxns,
      dividendRows,
      realizations: baselineRealizations,
      fifoRealizations: baselineFifo,
      categoryOf,
      involveDe,
      involveFi,
      involveCustom,
    });

    // The regime the closed-year corrections are labeled with: an engine-taxed
    // deleted row names its own; a deleted BUY has none — it reshapes its
    // asset's engine-taxed sells, so label by theirs (custom over DE over AT
    // when mixed; the amount is the combined reconciliation either way).
    let noteRegime: SettleRegime = deletedWasCustom
      ? 'custom'
      : deletedWasDe
        ? TAX_COUNTRY_DE
        : deletedWasFi
          ? TAX_COUNTRY_FI
          : TAX_COUNTRY_AT;
    if (transaction.side === 'buy') {
      const reshaped = remainingTxns.filter(
        (t) => t.assetId === transaction.assetId && t.side === 'sell' && isEngineTaxed(t.taxMode),
      );
      if (reshaped.some(isCustomSell)) noteRegime = 'custom';
      else if (reshaped.some(isDeSell)) noteRegime = TAX_COUNTRY_DE;
      else if (reshaped.some(isFiSell)) noteRegime = TAX_COUNTRY_FI;
    }

    // Closed years settle through the centralized reshape settlement (#669):
    // held shifts by exactly the decomposition's change plus the attached tax
    // the delete cascaded away — algebraically the combined post-delete
    // frozen target (components never mix) plus the year's locked residue.
    // The signed delta includes refund-off custom groups (§16): a reshape is
    // a data correction, exempt from the ratchet.
    const corrections: NewCashMovement[] = [];
    for (const { year, deltaEur } of closedReshapeCorrections({
      years: scope.years,
      before: closedBaseline,
      movementsBefore: movements,
      after: afterState,
      movementsAfter: remainingMovements,
    })) {
      const spec = taxMovementForDelta(deltaEur);
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

    // Open years (#635): live re-derivation over the remaining rows.
    const openYearsToSettle = [...openSeeds].sort((a, b) => a - b);
    if (openYearsToSettle.length > 0 && openRegime.kind !== 'manual') {
      const openView = buildOpenView(
        remainingTxns,
        dividendRows,
        realizations,
        fifoRealizations,
        assetsById,
      );
      const settlements = settleOpenYears({
        regime: openRegime,
        view: openView,
        years: openYearsToSettle,
        heldOf: (year) => heldForYear(remainingTxns, dividendRows, remainingMovements, year),
        closedDeEvents:
          openRegime.kind === 'country' && openRegime.country === TAX_COUNTRY_DE
            ? closedYearSlice(afterState.deEvents, openFrom)
            : undefined,
        closedCustomEvents:
          openRegime.kind === 'custom'
            ? closedYearSlice(
                afterState.customGroups.get(customParamsKey(openRegime.params))?.eventsByYear ??
                  new Map<number, CustomTaxableEvent[]>(),
                openFrom,
              )
            : undefined,
      });
      for (const settlement of settlements) {
        const spec = taxMovementForDelta(settlement.correctionDeltaEur);
        if (spec) {
          corrections.push(
            correctionMovement(
              spec,
              await correctionSourceId(portfolioId),
              settlement.year,
              openCorrectionNote(openRegime),
            ),
          );
        }
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
      const openRegime: OpenRegime = isCustomMode
        ? { kind: 'custom', params: params! }
        : { kind: 'country', country: country! };
      const openFrom = openFromYearNow();
      const openStrategy = openRegimeStrategy(openRegime);
      const [allTxns, dividendRows, movements] = await Promise.all([
        transactionRepo.listForPortfolio(portfolioId),
        taxRepo.listForPortfolio(portfolioId),
        cashMovementRepo.listForPortfolio(portfolioId),
      ]);
      const regime: SettleRegime = isCustomMode ? 'custom' : country!;
      // The choke point (#669): the dividend's own (steered) year plus —
      // with chain-sensitive state involved — every later engine-settled
      // CLOSED year (a backdated gross may consume carry balances earlier
      // years handed down); open years re-settle through the live
      // derivation instead (#635). A dividend reshapes no realizations, so
      // both sides share the rows and no mutated assets enter the scoping.
      const sideRows = { transactions: allTxns, dividendRows };
      const scope = scopeClosedMutation({
        before: sideRows,
        after: sideRows,
        movements,
        mutationYears: [year],
        mutatedAssetIds: new Set<string>(),
        recordingRegime: openRegime,
        openFrom,
      });
      const { involveDe, involveFi, involveCustom } = scope;
      const rippleYears = scope.years.filter((y) => y !== year);
      // The open years the write re-settles: every derivable open year when
      // the dividend lands in an open year (its marginal delta needs the live
      // pool) or when a closed chained year's carry-outs may cross the
      // boundary.
      const derivableView = { transactions: allTxns, dividendRows, yearOf: viennaYearOfDate };
      const openYearsToSettle =
        year >= openFrom || (scope.chainSensitive && scope.years.length > 0)
          ? [
              ...new Set([
                ...openDerivableYears(derivableView, movements, openFrom),
                ...(year >= openFrom ? [year] : []),
              ]),
            ]
          : [];

      const neededAssetIds = new Set<string>();
      for (const t of allTxns) {
        if (t.side !== 'sell') continue;
        const txnYear = viennaYearOfDate(t.executedAt);
        const derivableOpen = txnYear >= openFrom && isDerivableSell(t);
        if (!derivableOpen && !isEngineTaxed(t.taxMode)) continue;
        if (
          txnYear === year ||
          scope.years.includes(txnYear) ||
          (derivableOpen && openYearsToSettle.includes(txnYear)) ||
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
        if (involveDe || involveFi || involveCustom || openStrategy === 'fifo') {
          fifoRealizations = realizationsById(taxables, 'fifo');
        }
      }
      const deView = buildDeView(allTxns, dividendRows, fifoRealizations, assetsById);
      const frozenDeEvents = involveDe
        ? deEventsByYear(deView)
        : new Map<number, DeTaxableEvent[]>();
      const frozenGroups = involveCustom
        ? customGroups(buildCustomView(allTxns, dividendRows, realizations, fifoRealizations))
        : new Map<string, CustomGroup>();

      let deltaEur: number;
      if (year >= openFrom) {
        // ── The dividend lands in an OPEN year (#635): live settle across
        // all open years; its marginal delta comes out of the derivation. ──
        const openView = buildOpenView(
          allTxns,
          dividendRows,
          realizations,
          fifoRealizations,
          assetsById,
        );
        const settlements = settleOpenYears({
          regime: openRegime,
          view: openView,
          years: openYearsToSettle,
          heldOf: (y) => heldForYear(allTxns, dividendRows, movements, y),
          closedDeEvents:
            country === TAX_COUNTRY_DE ? closedYearSlice(frozenDeEvents, openFrom) : undefined,
          closedCustomEvents: isCustomMode
            ? closedYearSlice(
                frozenGroups.get(activeKey!)?.eventsByYear ??
                  new Map<number, CustomTaxableEvent[]>(),
                openFrom,
              )
            : undefined,
          newEventsByYear: new Map([[year, [{ kind: 'dividend' as const, amountEur: grossEur }]]]),
        });
        deltaEur = 0;
        for (const settlement of settlements) {
          if (settlement.year === year) deltaEur = settlement.newEventDeltasEur[0]!;
          const correctionSpec = taxMovementForDelta(settlement.correctionDeltaEur);
          if (correctionSpec) {
            extras.push(
              correctionMovement(
                correctionSpec,
                await correctionSourceId(portfolioId),
                settlement.year,
                openCorrectionNote(openRegime),
              ),
            );
          }
        }
      } else {
        // ── Backdated into a CLOSED year: recording-time coexistence
        // machinery (frozen AT/DE/FI/custom components, pre-#635) plus the
        // year's locked residue. A dividend reshapes no realizations, so the
        // current maps ARE the pre-mutation baseline. ──────────────────────
        const closedBaseline: FrozenComponentState = {
          transactions: allTxns,
          dividendRows,
          realizations,
          fifoRealizations,
          deEvents: frozenDeEvents,
          customGroups: frozenGroups,
          involveDe,
          involveFi,
          involveCustom,
        };
        const heldEur = heldForYear(allTxns, dividendRows, movements, year);
        const residueEur = lockedResidueForYear(closedBaseline, movements, year);
        const customTarget = involveCustom
          ? customTargetForYear(frozenGroups, year, isCustomMode ? activeKey : undefined)
          : 0;
        const fiTargetClosed = (): number =>
          involveFi
            ? fiTargetForYear(allTxns, dividendRows, fifoRealizations, year, viennaYearOfDate)
            : 0;

        let correctionDeltaEur: number;
        if (isCustomMode) {
          const atTarget = atTargetForYear(allTxns, dividendRows, realizations, year);
          const deTarget = involveDe ? deTargetForYear(frozenDeEvents, year) : 0;
          const activeGroup = frozenGroups.get(activeKey!);
          const settlement = settleCustomYear({
            params: params!,
            carry: customCarryIntoYear(params!, activeGroup?.eventsByYear ?? new Map(), year),
            existingEvents: activeGroup?.eventsByYear.get(year) ?? [],
            heldEur: floorCents(
              heldEur - atTarget - deTarget - fiTargetClosed() - customTarget - residueEur,
            ),
            newEvents: [{ kind: 'dividend', amountEur: grossEur }],
          });
          correctionDeltaEur = settlement.correctionDeltaEur;
          deltaEur = settlement.newEventDeltasEur[0]!;
        } else if (country === TAX_COUNTRY_AT) {
          const deTarget = involveDe ? deTargetForYear(frozenDeEvents, year) : 0;
          const pool = existingAtPool(allTxns, dividendRows, realizations, year);
          const settlement = settleAtYear({
            ...pool,
            heldEur: floorCents(heldEur - deTarget - fiTargetClosed() - customTarget - residueEur),
            newEvents: [{ kind: 'dividend', amountEur: grossEur }],
          });
          correctionDeltaEur = settlement.correctionDeltaEur;
          deltaEur = settlement.newEventDeltasEur[0]!;
        } else if (country === TAX_COUNTRY_FI) {
          const atTarget = atTargetForYear(allTxns, dividendRows, realizations, year);
          const deTarget = involveDe ? deTargetForYear(frozenDeEvents, year) : 0;
          const existingGainsEur: number[] = [];
          const existingDividendsEur: number[] = [];
          for (const t of allTxns) {
            if (!isFiSell(t) || viennaYearOfDate(t.executedAt) !== year) continue;
            const realization = fifoRealizations.get(t.id);
            if (!realization) {
              throw new Error(`Tax engine: no FIFO realization for FI sell ${t.id}`);
            }
            existingGainsEur.push(realization.realizedPnlEur);
          }
          for (const d of dividendRows) {
            if (isFiDividend(d) && viennaYearOfDate(d.executedAt) === year) {
              existingDividendsEur.push(d.grossAmountEur);
            }
          }
          const settlement = settleFiYear({
            existingGainsEur,
            existingDividendsEur,
            heldEur: floorCents(heldEur - atTarget - deTarget - customTarget - residueEur),
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
            heldEur: floorCents(heldEur - atTarget - fiTargetClosed() - customTarget - residueEur),
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
              correctionNote(regime),
            ),
          );
        }
        // A backdated dividend entering a chained regime can consume carry
        // balances earlier years handed down — re-settle every LATER
        // engine-settled CLOSED year through the centralized reshape
        // settlement (#669) against the decomposition with the new gross
        // folded into its regime (zero-delta years post nothing).
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
        const withNewGroups = withNewActive
          ? new Map([...frozenGroups, [withNewActive.key, withNewActive]])
          : frozenGroups;
        if (rippleYears.length > 0) {
          const afterWithNew: FrozenComponentState = {
            ...closedBaseline,
            deEvents: withNewDe,
            customGroups: withNewGroups,
          };
          for (const { year: y, deltaEur } of closedReshapeCorrections({
            years: rippleYears,
            before: closedBaseline,
            movementsBefore: movements,
            after: afterWithNew,
            movementsAfter: movements,
          })) {
            const spec = taxMovementForDelta(deltaEur);
            if (!spec) continue;
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
        // Carry crossing the open boundary (#635): the open years re-derive
        // with the backdated dividend folded into the closed chain.
        if (openYearsToSettle.length > 0) {
          const openView = buildOpenView(
            allTxns,
            dividendRows,
            realizations,
            fifoRealizations,
            assetsById,
          );
          const settlements = settleOpenYears({
            regime: openRegime,
            view: openView,
            years: openYearsToSettle,
            heldOf: (y) => heldForYear(allTxns, dividendRows, movements, y),
            closedDeEvents:
              country === TAX_COUNTRY_DE ? closedYearSlice(withNewDe, openFrom) : undefined,
            closedCustomEvents:
              isCustomMode && withNewActive
                ? closedYearSlice(withNewActive.eventsByYear, openFrom)
                : undefined,
          });
          for (const settlement of settlements) {
            const spec = taxMovementForDelta(settlement.correctionDeltaEur);
            if (spec) {
              extras.push(
                correctionMovement(
                  spec,
                  await correctionSourceId(portfolioId),
                  settlement.year,
                  openCorrectionNote(openRegime),
                ),
              );
            }
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
    // engine-taxed CLOSED year: the gross it contributed may have been
    // consuming carry balances that now chain further (the combined
    // AT+DE+FI+custom target catches every component). Open years re-settle
    // through the live derivation (#635) — a derivable dividend's removal
    // re-shapes the open pool even when it was frozen 'none'.
    const settings = await effectiveSettings(userId, portfolioId);
    const openRegime = openRegimeForSettings(settings);
    const openFrom = openRegime.kind === 'manual' ? Number.POSITIVE_INFINITY : openFromYearNow();
    const openStrategy = openRegimeStrategy(openRegime);
    const corrections: NewCashMovement[] = [];
    const year = viennaYearOfDate(dividend.executedAt);
    const wasEngine = dividend.taxMode === 'country_specific' || dividend.taxMode === 'custom';
    const openDelete = year >= openFrom && isDerivableDividend(dividend);
    if (wasEngine || openDelete) {
      const deletedWasCustom = dividend.taxMode === 'custom';
      const deletedWasDe =
        !deletedWasCustom && wasEngine && rowEngineCountry(dividend.taxCountry) === TAX_COUNTRY_DE;
      const deletedWasFi =
        !deletedWasCustom && wasEngine && rowEngineCountry(dividend.taxCountry) === TAX_COUNTRY_FI;

      // The choke point (#669): the deleted dividend's own year plus — with
      // chain-sensitive state involved (the deleted row's own frozen set
      // counts: its gross fed carry) — every later engine-settled closed
      // year. A dividend touches no realizations, so no mutated assets.
      const scope = scopeClosedMutation({
        before: { transactions: allTxns, dividendRows },
        after: { transactions: allTxns, dividendRows: remainingDividends },
        movements,
        mutationYears: [year],
        mutatedAssetIds: new Set<string>(),
        openFrom,
      });
      const { involveDe, involveFi, involveCustom } = scope;
      // Open years re-settle when the deleted dividend was itself open, or a
      // closed chained year's carry-outs may cross the boundary.
      const derivableView = {
        transactions: allTxns,
        dividendRows: remainingDividends,
        yearOf: viennaYearOfDate,
      };
      const openYearsToSettle =
        openDelete || (scope.chainSensitive && scope.years.length > 0)
          ? openDerivableYears(derivableView, remainingMovements, openFrom)
          : [];

      const closedYearsSet = new Set(scope.years);
      const neededAssetIds = new Set<string>();
      for (const t of allTxns) {
        if (t.side !== 'sell') continue;
        const txnYear = viennaYearOfDate(t.executedAt);
        const derivableOpen = txnYear >= openFrom && isDerivableSell(t);
        if (!derivableOpen && !isEngineTaxed(t.taxMode)) continue;
        if (
          closedYearsSet.has(txnYear) ||
          (derivableOpen && openYearsToSettle.includes(txnYear)) ||
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
        if (involveDe || involveFi || involveCustom || openStrategy === 'fifo') {
          fifoRealizations = realizationsById(taxables, 'fifo');
        }
      }
      // The POST-delete decomposition and the PRE-delete baseline (deleted
      // dividend still in) the closed years' locked residue reads from —
      // realizations are dividend-agnostic, so both sides share them.
      const categoryOf = categoryLookup(assetsById);
      const afterState = buildFrozenComponentState({
        transactions: allTxns,
        dividendRows: remainingDividends,
        realizations,
        fifoRealizations,
        categoryOf,
        involveDe,
        involveFi,
        involveCustom,
      });
      const closedBaseline = buildFrozenComponentState({
        transactions: allTxns,
        dividendRows,
        realizations,
        fifoRealizations,
        categoryOf,
        involveDe,
        involveFi,
        involveCustom,
      });

      for (const { year: y, deltaEur } of closedReshapeCorrections({
        years: scope.years,
        before: closedBaseline,
        movementsBefore: movements,
        after: afterState,
        movementsAfter: remainingMovements,
      })) {
        const spec = taxMovementForDelta(deltaEur);
        if (!spec) continue;
        corrections.push(
          correctionMovement(
            spec,
            await correctionSourceId(portfolioId),
            y,
            correctionNote(
              deletedWasCustom
                ? 'custom'
                : deletedWasDe
                  ? TAX_COUNTRY_DE
                  : deletedWasFi
                    ? TAX_COUNTRY_FI
                    : TAX_COUNTRY_AT,
            ),
          ),
        );
      }

      if (openYearsToSettle.length > 0 && openRegime.kind !== 'manual') {
        const openView = buildOpenView(
          allTxns,
          remainingDividends,
          realizations,
          fifoRealizations,
          assetsById,
        );
        const settlements = settleOpenYears({
          regime: openRegime,
          view: openView,
          years: openYearsToSettle,
          heldOf: (y) => heldForYear(allTxns, remainingDividends, remainingMovements, y),
          closedDeEvents:
            openRegime.kind === 'country' && openRegime.country === TAX_COUNTRY_DE
              ? closedYearSlice(afterState.deEvents, openFrom)
              : undefined,
          closedCustomEvents:
            openRegime.kind === 'custom'
              ? closedYearSlice(
                  afterState.customGroups.get(customParamsKey(openRegime.params))?.eventsByYear ??
                    new Map<number, CustomTaxableEvent[]>(),
                  openFrom,
                )
              : undefined,
        });
        for (const settlement of settlements) {
          const spec = taxMovementForDelta(settlement.correctionDeltaEur);
          if (spec) {
            corrections.push(
              correctionMovement(
                spec,
                await correctionSourceId(portfolioId),
                settlement.year,
                openCorrectionNote(openRegime),
              ),
            );
          }
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
    /** FIFO realizations — populated when DE/FI/FIFO-custom rows or a FIFO regime exist. */
    deRealizations: Map<string, SellRealizationEur>;
    /** Sells frozen under a FIFO-based custom parameter set (V5-P4c). */
    customFifoSellIds: Set<string>;
    /** Per-year DE events of the frozen DE rows (empty without DE rows). */
    frozenDeEvents: Map<number, DeTaxableEvent[]>;
    assetsById: Map<string, AssetRow>;
    /** #635: the current open-year regime and its realization strategy. */
    openRegime: OpenRegime;
    openStrategy: CostBasisStrategy | null;
    /** First live year for DERIVATION (∞ under the manual regime). */
    openFrom: number;
    /** First non-locked year for the report flag (always the current Vienna year). */
    lockedBefore: number;
    /** Live settlements of the open years (empty under the manual regime). */
    openSettlements: OpenYearSettlement[];
  }

  async function loadReportState(userId: string, portfolioId: string): Promise<ReportState> {
    const settings = await effectiveSettings(userId, portfolioId);
    const openRegime = openRegimeForSettings(settings);
    const lockedBefore = openFromYearNow();
    const openFrom = openRegime.kind === 'manual' ? Number.POSITIVE_INFINITY : lockedBefore;
    const openStrategy = openRegimeStrategy(openRegime);
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
    const involveFi = portfolioHasFiRows(transactions, dividendRows);
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
      if (involveDe || involveFi || customFifoSellIds.size > 0 || openStrategy === 'fifo') {
        deRealizations = realizationsById(taxables, 'fifo');
      }
    }
    const frozenDeEvents = involveDe
      ? deEventsByYear(buildDeView(transactions, dividendRows, deRealizations, assetsById))
      : new Map<number, DeTaxableEvent[]>();

    // #635: derive the open years' live state under the CURRENT regime — the
    // report's self-healing input (reconciled by {@link reconcileOpenYears}).
    let openSettlements: OpenYearSettlement[] = [];
    if (openRegime.kind !== 'manual') {
      const derivableView = { transactions, dividendRows, yearOf: viennaYearOfDate };
      const openYears = openDerivableYears(derivableView, movements, openFrom);
      if (openYears.length > 0) {
        const frozenGroups = customGroups(
          buildCustomView(transactions, dividendRows, realizations, deRealizations),
        );
        openSettlements = settleOpenYears({
          regime: openRegime,
          view: buildOpenView(transactions, dividendRows, realizations, deRealizations, assetsById),
          years: openYears,
          heldOf: (year) => heldForYear(transactions, dividendRows, movements, year),
          closedDeEvents:
            openRegime.kind === 'country' && openRegime.country === TAX_COUNTRY_DE
              ? closedYearSlice(frozenDeEvents, openFrom)
              : undefined,
          closedCustomEvents:
            openRegime.kind === 'custom'
              ? closedYearSlice(
                  frozenGroups.get(customParamsKey(openRegime.params))?.eventsByYear ??
                    new Map<number, CustomTaxableEvent[]>(),
                  openFrom,
                )
              : undefined,
        });
      }
    }
    return {
      transactions,
      dividendRows,
      movements,
      realizations,
      deRealizations,
      customFifoSellIds,
      frozenDeEvents,
      assetsById,
      openRegime,
      openStrategy,
      openFrom,
      lockedBefore,
      openSettlements,
    };
  }

  /**
   * Self-heal the open years on a report read (#635): post the unattached
   * corrections that steer each open year's held tax onto its live derived
   * target. A withholding correction takes cash out — it must never break the
   * ledger's no-negative invariant from a read path, so an insolvent one is
   * skipped (logged) and retried on the next read once cash is there; the
   * summary still reports the derived target. Refunds always post.
   *
   * Two concurrent reads may derive the same correction; the insert runs in
   * one advisory-locked transaction that re-reads the movements and posts a
   * year's correction only when its held tax still matches what the
   * settlement was derived against — the loser of the race skips and the
   * next read re-derives from the winner's state.
   */
  async function reconcileOpenYears(portfolioId: string, state: ReportState): Promise<void> {
    const pending = state.openSettlements.filter((s) => s.correctionDeltaEur !== 0);
    if (pending.length === 0) return;
    const sourceId = await correctionSourceId(portfolioId);
    const inserted = await cashMovementRepo.insertReconciled(portfolioId, (fresh) => {
      const domainExisting = fresh.map(toDomainMovement);
      const posted: NewCashMovement[] = [];
      for (const settlement of pending) {
        // Reconcile settlements carry no new events, so the held tax the
        // derivation saw is exactly `targetAfter − correction`.
        const heldAtDerivation = floorCents(
          settlement.targetAfterEur - settlement.correctionDeltaEur,
        );
        // The guard recomputes over the derivation's ROW snapshot against the
        // fresh movements, so it detects unattached-movement drift only: a
        // trade committed since derivation lands its frozen tax on the row
        // (not as an unattached movement), passes the guard, and this
        // correction posts against slightly-stale rows — the next read
        // re-derives from the merged state and self-heals.
        const heldNow = heldForYear(state.transactions, state.dividendRows, fresh, settlement.year);
        if (heldNow !== heldAtDerivation) {
          deps.logger?.warn(
            { portfolioId, year: settlement.year, heldNow, heldAtDerivation },
            'tax reconcile: year moved since derivation (concurrent write); skipped',
          );
          continue;
        }
        const spec = taxMovementForDelta(settlement.correctionDeltaEur);
        if (!spec) continue;
        const movement = correctionMovement(
          spec,
          sourceId,
          settlement.year,
          openCorrectionNote(state.openRegime),
        );
        if (spec.kind === 'tax_withholding') {
          try {
            projectCashLedgerBySource([
              ...domainExisting,
              ...posted.map(newToDomainMovement),
              newToDomainMovement(movement),
            ]);
          } catch (err) {
            if (err instanceof InsufficientCashError) {
              deps.logger?.warn(
                { portfolioId, year: settlement.year, deltaEur: settlement.correctionDeltaEur },
                'tax reconcile: withholding correction deferred (insufficient cash)',
              );
              continue;
            }
            throw err;
          }
        }
        posted.push(movement);
      }
      return posted;
    });
    if (inserted.length === 0) return;
    await invalidateHistory(
      portfolioId,
      inserted.map((m) => dayOfDate(m.executedAt)).reduce((a, b) => (a < b ? a : b)),
    );
    state.movements = await cashMovementRepo.listForPortfolio(portfolioId);
  }

  /**
   * Settings-change reconciliation (#635): re-derive + heal the open years
   * right after a per-portfolio tax write, so the new regime's corrections
   * post immediately. Deliberately non-fatal — an unavailable FX rate (or any
   * other read-side failure) must not fail the settings write itself; the
   * next report read retries the heal.
   */
  async function reconcilePortfolio(userId: string, portfolioId: string): Promise<void> {
    try {
      const state = await loadReportState(userId, portfolioId);
      await reconcileOpenYears(portfolioId, state);
    } catch (err) {
      deps.logger?.warn(
        { portfolioId, err },
        'tax reconcile after settings change failed; healing on the next report read',
      );
    }
  }

  /**
   * The realization of one sell as the report states it. Open-year derivable
   * sells show the ACTIVE regime's strategy (#635 — that is the taxed truth
   * of the live model). Frozen semantics elsewhere: a DE-frozen sell — or one
   * frozen under a FIFO-based custom parameter set — shows its FIFO
   * realization; every other sell keeps the moving-average view (for AT rows
   * the taxed truth, for untaxed rows the pre-V5-P4 financial fact).
   */
  function reportRealization(
    state: ReportState,
    t: TransactionRecord,
  ): SellRealizationEur | undefined {
    if (
      state.openStrategy !== null &&
      isDerivableSell(t) &&
      viennaYearOfDate(t.executedAt) >= state.openFrom
    ) {
      return state.openStrategy === 'fifo'
        ? state.deRealizations.get(t.id)
        : state.realizations.get(t.id);
    }
    return isDeSell(t) || state.customFifoSellIds.has(t.id)
      ? state.deRealizations.get(t.id)
      : state.realizations.get(t.id);
  }

  /**
   * The DE year-end block. Closed years: present exactly when the year has
   * DE-FROZEN rows (recording-time truth). Open years (#635): present exactly
   * when the ACTIVE regime is DE and the year has derivable rows — the block
   * then shows the LIVE derivation (pots/allowance over all derivable rows).
   */
  function deSummaryForYear(state: ReportState, year: number): TaxYearSummary['de'] {
    if (year >= state.openFrom) {
      if (state.openRegime.kind !== 'country' || state.openRegime.country !== TAX_COUNTRY_DE) {
        return undefined;
      }
      const hasDerivable =
        state.transactions.some(
          (t) => isDerivableSell(t) && viennaYearOfDate(t.executedAt) === year,
        ) ||
        state.dividendRows.some(
          (d) => isDerivableDividend(d) && viennaYearOfDate(d.executedAt) === year,
        );
      const deState = state.openSettlements.find((s) => s.year === year)?.deState;
      if (!hasDerivable || !deState) return undefined;
      return {
        allowanceUsedEur: floorCents(deState.outcome.allowanceUsedEur),
        allowanceRemainingEur: floorCents(deState.outcome.allowanceRemainingEur),
        aktienPotInEur: floorCents(deState.potIns.aktienEur),
        aktienPotOutEur: floorCents(deState.outcome.aktienPotOutEur),
        sonstigePotInEur: floorCents(deState.potIns.sonstigeEur),
        sonstigePotOutEur: floorCents(deState.outcome.sonstigePotOutEur),
        kapestEur: deState.outcome.kapestEur,
        soliEur: deState.outcome.soliEur,
      };
    }
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
    // #635: an open year's net tax IS the live derived target (plus the
    // manual-fact component) — normally identical to the movement sum after
    // reconciliation, and still the correct current figure when a withholding
    // correction had to be deferred for solvency.
    let taxNetEur = floorCents(taxWithheldEur - taxRefundedEur);
    const settlement = state.openSettlements.find((s) => s.year === year);
    if (settlement) {
      const engineHeldEur = heldForYear(
        state.transactions,
        state.dividendRows,
        state.movements,
        year,
      );
      taxNetEur = floorCents(taxNetEur - engineHeldEur + settlement.targetAfterEur);
    }
    const de = deSummaryForYear(state, year);
    return {
      year,
      realizedPnlEur,
      dividendsGrossEur,
      taxWithheldEur,
      taxRefundedEur,
      taxNetEur,
      // Omit the key entirely for non-DE years (exact pre-V5-P4 shape).
      ...(de !== undefined ? { de } : {}),
      // #635: closed years are locked (never re-derived); key omitted = live.
      ...(year < state.lockedBefore ? { locked: true } : {}),
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
    const state = await loadReportState(userId, portfolioId);
    await reconcileOpenYears(portfolioId, state);
    return { years: reportYears(state).map((year) => yearSummary(state, year)) };
  }

  async function getYearReport(
    userId: string,
    portfolioId: string,
    year: number,
  ): Promise<TaxYearReportResponse> {
    await requireOwnedPortfolio(userId, portfolioId);
    const state = await loadReportState(userId, portfolioId);
    await reconcileOpenYears(portfolioId, state);

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
      // #635 live model: the new regime applies to the open years NOW — post
      // the corrections immediately rather than waiting for a report read.
      await reconcilePortfolio(userId, portfolioId);
      return getPortfolioTaxSettings(userId, portfolioId);
    },

    async clearPortfolioTaxOverride(userId, portfolioId) {
      await requireOwnedPortfolio(userId, portfolioId);
      await portfolioSettingsRepo.deleteSetting(portfolioId, PORTFOLIO_SETTING_KEY_TAX);
      // #635: dropping the override re-derives the open years under the
      // inherited default.
      await reconcilePortfolio(userId, portfolioId);
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

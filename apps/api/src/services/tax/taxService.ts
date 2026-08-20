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
  type TaxYearChangesResponse,
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
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  TAX_COUNTRY_FI,
  taxMovementForDelta,
  viennaYearOf,
  type CostBasisStrategy,
  type CustomTaxParams,
  type DePotCategory,
  type DeTaxableEvent,
  type SellRealizationEur,
  type SupportedTaxCountry,
  type TaxableTransaction,
  type TaxMovementSpec,
} from '../../domain/tax';
import type { ParanoidModeGuard } from '../account/paranoidEnforcement';
import {
  deEventsByYear,
  deYearStateForYear,
  isDeDividend,
  isDeSell,
  portfolioHasDeRows,
  portfolioHasFiRows,
  type DeRowView,
} from './countryState';
import {
  heldForYear,
  isDerivableDividend,
  isDerivableSell,
  liveCountryOf,
  liveDerivableYears,
  liveRegimeOf,
  liveRegimeStrategy,
  settleLiveYears,
  viennaYearOfDate,
  type NewLiveEvent,
  type LiveRegime,
  type LiveYearRowView,
  type LiveYearSettlement,
} from './livingYear';
import { isCustomFifoSell } from './customState';
import {
  activeCustomParams,
  parseTaxOverride,
  PORTFOLIO_SETTING_KEY_TAX,
  settingsRecordFromInput,
  TAX_SYSTEM_DEFAULT,
} from './settings';
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
 * The load-bearing invariants, all enforced here on the way into the pure engine:
 *
 *  - **Living documentation.** Every automatic year is re-derived under the
 *    portfolio's current regime. Calendar rollover never changes mutability or
 *    calculation behavior; manual-per-trade rows remain literal user facts.
 *  - **Trade-date year, Vienna calendar.** Aggregation buckets by the trade's
 *    `executedAt` in Europe/Vienna; the AT pool of a year contains only rows
 *    that were themselves taxed under AT mode. The pool is **per portfolio**
 *    (a portfolio models one depot; the report is portfolio-scoped and tax
 *    cash stays in the portfolio's sources).
 *  - **Append-only settlement.** The tax *held* for a year is derived from
 *    movements (attached settlements mirror their row's recorded tax 1:1;
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
  /** Direct planning calls must fail closed as well as public tax routes. */
  paranoid?: Pick<ParanoidModeGuard, 'assertAllowed'>;
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
  /** MIRRORCHAIN replica apply (design §2): permit copy-local cash skew. */
  force?: boolean;
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
   * append-only against the simulated post-delete state (every year under the
   * CURRENT regime — #1399 living-document model — hence `userId` for settings).
   */
  planTransactionDeleteCorrections(
    userId: string,
    portfolioId: string,
    transaction: TransactionRecord,
    opts?: { force?: boolean },
  ): Promise<NewCashMovement[]>;
  /**
   * Record a dividend (V3-P4c): gross EUR into a source, tax-mode aware.
   * `opts.source` is the V5-P0c source tag stamped on the dividend and its cash
   * movements — `manual` by default, `import:<broker>` from the CSV apply path.
   * Server-assigned only (the HTTP body carries no source field). `opts.force`
   * is the MIRRORCHAIN replica-apply mode (design §2/§8): the cash overdraw
   * gate is waived — the copy taxes the replicated dividend under its OWN mode
   * (design §9), and its copy-local settlement may legitimately skew the source.
   */
  recordDividend(
    userId: string,
    portfolioId: string,
    input: CreateDividendRequest,
    opts?: { source?: string; force?: boolean },
  ): Promise<CreateDividendResponse>;
  /** The portfolio's dividends, newest pay date first; optional source-tag filter (V5-P0c). */
  listDividends(
    userId: string,
    portfolioId: string,
    opts?: { source?: string },
  ): Promise<DividendListResponse>;
  /**
   * Delete a dividend; movements cascade, AT years settle append-only.
   * `opts.force` (MIRRORCHAIN replica apply, design §2): waives the
   * ledger-would-go-negative gate so a replica follows the chain's total order.
   */
  deleteDividend(
    userId: string,
    portfolioId: string,
    dividendId: string,
    opts?: { force?: boolean },
  ): Promise<void>;
  /** Per-year summaries (realized P/L, dividends, taxes), newest first. */
  getYearReports(userId: string, portfolioId: string): Promise<TaxYearListResponse>;
  /** Account-wide living tax-documentation markers, newest first. */
  getYearChanges(userId: string): Promise<TaxYearChangesResponse>;
  /** One year with per-position drill-down. */
  getYearReport(userId: string, portfolioId: string, year: number): Promise<TaxYearReportResponse>;
}

/** Movement notes (stored data, mirroring the cash-link note precedent). */
const NOTE_AT_WITHHELD = 'KESt withheld (AT)';
const NOTE_AT_REFUNDED = 'KESt refunded (AT)';
const NOTE_AT_CORRECTION = 'Tax year correction (AT)';
const NOTE_DE_WITHHELD = 'KapESt + Soli withheld (DE)';
const NOTE_DE_REFUNDED = 'KapESt + Soli refunded (DE)';
const NOTE_MANUAL_WITHHELD = 'Tax withheld (manual entry)';
const NOTE_CUSTOM_WITHHELD = 'Tax withheld (custom rules)';
const NOTE_CUSTOM_REFUNDED = 'Tax refunded (custom rules)';
const NOTE_FI_WITHHELD = 'Capital-income tax withheld (FI)';
const NOTE_FI_REFUNDED = 'Capital-income tax refunded (FI)';
const NOTE_OFF_CORRECTION = 'Tax year correction (tax tracking off)';
/** Living-year corrections carry stable, descriptive cash-history notes. */
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

/** The correction note of a live regime (`none` backs automatic tax out). */
const liveCorrectionNote = (regime: LiveRegime): string =>
  regime.kind === 'none'
    ? NOTE_OFF_CORRECTION
    : regime.kind === 'custom'
      ? NOTE_CUSTOM_LIVE_CORRECTION
      : regime.kind === 'country' && regime.country === TAX_COUNTRY_DE
        ? NOTE_DE_LIVE_CORRECTION
        : regime.kind === 'country' && regime.country === TAX_COUNTRY_FI
          ? NOTE_FI_LIVE_CORRECTION
          : NOTE_AT_LIVE_CORRECTION;

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
    liveCountryOf(settings.country);

  /** A stored 2-char country narrowed to the contract enum (`AT`|`DE`|`FI`|null). */
  const toContractCountry = (country: string | null): EngineCountry | null =>
    country === TAX_COUNTRY_AT || country === TAX_COUNTRY_DE || country === TAX_COUNTRY_FI
      ? country
      : null;

  /** A row's recorded custom parameter snapshot narrowed to the contract shape. */
  const toContractCustomParams = (params: unknown): CustomTaxParams | null => {
    const parsed = customTaxParamsSchema.safeParse(params);
    return parsed.success ? parsed.data : null;
  };

  /** The live regime of the resolved settings ({@link liveRegimeOf}). */
  const liveRegimeForSettings = (settings: UserTaxSettingsRecord): LiveRegime =>
    liveRegimeOf(settings, activeCustomParams);

  /** Assemble the {@link LiveYearRowView} the living-year derivation runs over. */
  function buildLiveView(
    transactions: readonly TransactionRecord[],
    dividendRows: readonly DividendRecord[],
    realizations: ReadonlyMap<string, SellRealizationEur>,
    fifoRealizations: ReadonlyMap<string, SellRealizationEur>,
    assetsById: ReadonlyMap<string, AssetRow>,
  ): LiveYearRowView {
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

  function movementToDto(
    r: Omit<CashMovementRecord, 'amountEur'> & { amountEur: number | string },
  ): CashMovementDto {
    return {
      id: r.id,
      kind: r.kind,
      amountEur: Number(r.amountEur),
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
    await deps.paranoid?.assertAllowed(userId, 'portfolioServer');
    const settings = await effectiveSettings(userId, portfolioId);
    const rows: PlannedRowTax[] = inputs.map((input) => ({
      tax:
        input.side === 'sell' && settings.mode === 'none'
          ? { mode: 'none', country: null, amountEur: null }
          : null,
      movement: null,
    }));
    for (const input of inputs) assertManualEntryAllowed(settings, input, input.side);

    const pendingSells = inputs.flatMap((input, index) =>
      input.side === 'sell' ? [{ index, tempId: `pending-${index}`, input }] : [],
    );

    // Manual rows are literal facts. They never enter automatic derivation,
    // irrespective of their calendar year.
    if (settings.mode === 'manual_per_trade') {
      const defaultApplies = (planInput.source ?? 'manual') === 'manual';
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
      const rateAssetIds = new Set(
        pendingSells
          .filter(({ input }) => effectiveEntry(input).taxRatePct !== null)
          .map(({ input }) => input.assetId),
      );
      let realizations = new Map<string, SellRealizationEur>();
      if (rateAssetIds.size > 0) {
        const existing = (
          await Promise.all(
            [...rateAssetIds].map((assetId) => transactionRepo.listForAsset(portfolioId, assetId)),
          )
        ).flat();
        realizations = realizationsById(
          await buildTaxables(
            existing,
            pendingSells.map(({ tempId, input }) => ({ tempId, input })),
            rateAssetIds,
            currencyLookup(assetsById),
            createTradeDateConverter(fxWriteError),
          ),
        );
      }
      const proposed: SourcedCashMovement[] = [];
      for (const { index, tempId, input } of pendingSells) {
        const executedAt = new Date(input.executedAt).toISOString();
        const entry = effectiveEntry(input);
        const baseEur =
          entry.taxRatePct === null ? 0 : (realizations.get(tempId)?.realizedPnlEur ?? 0);
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
            taxYear: viennaYearOf(executedAt),
          };
          proposed.push({
            kind: 'tax_withholding',
            amountEur: -taxEur,
            occurredAt: executedAt,
            sourceId,
          });
        }
        rows[index] = row;
      }
      return { rows, extras: [], proposed };
    }

    const regime = liveRegimeForSettings(settings);
    if (regime.kind === 'manual') throw new Error('Manual tax regime reached automatic planner');
    const [transactions, dividendRows, movements] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    const strategy = liveRegimeStrategy(regime);
    const neededAssetIds = new Set([
      ...transactions.filter((row) => row.side === 'sell').map((row) => row.assetId),
      ...pendingSells.map(({ input }) => input.assetId),
    ]);
    const mergedAssets = new Map(assetsById);
    const missingAssets = [...neededAssetIds].filter((assetId) => !mergedAssets.has(assetId));
    for (const [assetId, asset] of await loadAssets(missingAssets))
      mergedAssets.set(assetId, asset);

    let movingAverage = new Map<string, SellRealizationEur>();
    let fifo = new Map<string, SellRealizationEur>();
    if (strategy !== null && neededAssetIds.size > 0) {
      const taxables = await buildTaxables(
        transactions,
        inputs.map((input, index) => ({ tempId: `pending-${index}`, input })),
        neededAssetIds,
        currencyLookup(mergedAssets),
        createTradeDateConverter(fxWriteError),
      );
      movingAverage = realizationsById(taxables);
      if (strategy === 'fifo') fifo = realizationsById(taxables, 'fifo');
    }

    const years = new Set(
      liveDerivableYears({ transactions, dividendRows, yearOf: viennaYearOfDate }, movements),
    );
    const sellsByYear = new Map<number, typeof pendingSells>();
    for (const pending of pendingSells) {
      const year = viennaYearOf(new Date(pending.input.executedAt).toISOString());
      years.add(year);
      const rowsForYear = sellsByYear.get(year) ?? [];
      rowsForYear.push(pending);
      sellsByYear.set(year, rowsForYear);
    }
    if (years.size === 0) return { rows, extras: [], proposed: [] };

    const newEventsByYear = new Map<number, NewLiveEvent[]>();
    for (const [year, sells] of sellsByYear) {
      newEventsByYear.set(
        year,
        sells.map(({ tempId, input }) => ({
          kind: 'sell_gain',
          tempId,
          assetId: input.assetId,
        })),
      );
    }
    const settlements = settleLiveYears({
      regime,
      view: buildLiveView(transactions, dividendRows, movingAverage, fifo, mergedAssets),
      years: [...years],
      heldOf: (year) => heldForYear(transactions, dividendRows, movements, year),
      newEventsByYear,
    });

    const extras: BatchCashMovement[] = [];
    const proposed: SourcedCashMovement[] = [];
    const correctionAt = new Date(now());
    for (const settlement of settlements) {
      const correction = taxMovementForDelta(settlement.correctionDeltaEur);
      if (correction) {
        const sourceId = await correctionSourceId(portfolioId);
        extras.push({
          kind: correction.kind,
          amountEur: correction.amountEur,
          sourceId,
          note: liveCorrectionNote(regime),
          taxYear: settlement.year,
          executedAt: correctionAt,
        });
        proposed.push({
          kind: correction.kind,
          amountEur: correction.amountEur,
          occurredAt: correctionAt.toISOString(),
          sourceId,
        });
      }
      const yearSells = sellsByYear.get(settlement.year) ?? [];
      for (const [eventIndex, pending] of yearSells.entries()) {
        if (regime.kind === 'none') continue;
        const deltaEur = settlement.newEventDeltasEur[eventIndex]!;
        const row: PlannedRowTax = {
          tax:
            regime.kind === 'custom'
              ? { mode: 'custom', country: null, amountEur: deltaEur, params: regime.params }
              : {
                  mode: 'country_specific',
                  country: regime.country,
                  amountEur: deltaEur,
                },
          movement: null,
        };
        const movement = taxMovementForDelta(deltaEur);
        if (movement) {
          const sourceId = await resolveSourceId(pending.input.cashSourceId);
          const movementRegime: SettleRegime = regime.kind === 'custom' ? 'custom' : regime.country;
          row.movement = {
            kind: movement.kind,
            amountEur: movement.amountEur,
            sourceId,
            note: settlementNote(movementRegime, movement.kind),
            taxYear: settlement.year,
          };
          proposed.push({
            kind: movement.kind,
            amountEur: movement.amountEur,
            occurredAt: new Date(pending.input.executedAt).toISOString(),
            sourceId,
          });
        }
        rows[pending.index] = row;
      }
    }
    return { rows, extras, proposed };
  }

  // ── Delete corrections ─────────────────────────────────────────────────────

  async function planTransactionDeleteCorrections(
    userId: string,
    portfolioId: string,
    transaction: TransactionRecord,
    _opts?: { force?: boolean },
  ): Promise<NewCashMovement[]> {
    const regime = liveRegimeForSettings(await effectiveSettings(userId, portfolioId));
    if (regime.kind === 'manual') return [];
    const [transactions, dividendRows, movements] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    const remainingTransactions = transactions.filter((row) => row.id !== transaction.id);
    const remainingMovements = movements.filter((row) => row.transactionId !== transaction.id);
    const strategy = liveRegimeStrategy(regime);
    const neededAssetIds = new Set(
      remainingTransactions.filter((row) => row.side === 'sell').map((row) => row.assetId),
    );
    const assetsById = await loadAssets([
      ...remainingTransactions.map((row) => row.assetId),
      ...dividendRows.map((row) => row.assetId),
    ]);
    let movingAverage = new Map<string, SellRealizationEur>();
    let fifo = new Map<string, SellRealizationEur>();
    if (strategy !== null && neededAssetIds.size > 0) {
      const taxables = await buildTaxables(
        remainingTransactions,
        [],
        neededAssetIds,
        currencyLookup(assetsById),
        createTradeDateConverter(fxWriteError),
      );
      movingAverage = realizationsById(taxables);
      if (strategy === 'fifo') fifo = realizationsById(taxables, 'fifo');
    }
    const years = new Set(
      liveDerivableYears(
        {
          transactions: remainingTransactions,
          dividendRows,
          yearOf: viennaYearOfDate,
        },
        remainingMovements,
      ),
    );
    years.add(viennaYearOfDate(transaction.executedAt));
    const settlements = settleLiveYears({
      regime,
      view: buildLiveView(remainingTransactions, dividendRows, movingAverage, fifo, assetsById),
      years: [...years],
      heldOf: (year) => heldForYear(remainingTransactions, dividendRows, remainingMovements, year),
    });
    const corrections: NewCashMovement[] = [];
    for (const settlement of settlements) {
      const spec = taxMovementForDelta(settlement.correctionDeltaEur);
      if (!spec) continue;
      corrections.push(
        correctionMovement(
          spec,
          await correctionSourceId(portfolioId),
          settlement.year,
          liveCorrectionNote(regime),
        ),
      );
    }
    return corrections;
  }

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
    opts?: { source?: string; force?: boolean },
  ): Promise<CreateDividendResponse> {
    await requireOwnedPortfolio(userId, portfolioId);
    const sourceTag = opts?.source ?? 'manual';
    const [asset] = await portfolioRepo.assetsByIds([input.assetId]);
    if (!asset || (asset.ownerId !== null && asset.ownerId !== userId)) {
      throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
    }
    if ((await transactionRepo.listForAsset(portfolioId, input.assetId)).length === 0) {
      throw badRequest(
        'Dividends can only be recorded on assets this portfolio holds.',
        'DIVIDEND_ASSET_NOT_HELD',
      );
    }

    const settings = await effectiveSettings(userId, portfolioId);
    assertManualEntryAllowed(settings, input, 'dividend');
    const source = await resolveFlowSource(portfolioId, input.cashSourceId);
    const executedAt = input.executedAt ? new Date(input.executedAt) : new Date(now());
    const year = viennaYearOf(executedAt.toISOString());
    const grossEur = floorCents(input.grossAmountEur);
    if (grossEur <= 0) {
      throw badRequest('The dividend amount rounds to €0.00.', 'DIVIDEND_AMOUNT_TOO_SMALL');
    }

    let taxAmountEur: number | null = null;
    let taxCountry: SupportedTaxCountry | null = null;
    let taxParams: CustomTaxParams | null = null;
    let rowSettlement: TaxMovementSpec | null = null;
    const extras: NewCashMovement[] = [];

    if (settings.mode === 'manual_per_trade') {
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
    } else if (settings.mode !== 'none') {
      const regime = liveRegimeForSettings(settings);
      if (regime.kind === 'manual' || regime.kind === 'none') {
        throw new Error('Invalid automatic dividend regime');
      }
      taxCountry = regime.kind === 'country' ? regime.country : null;
      taxParams = regime.kind === 'custom' ? regime.params : null;
      const [transactions, dividendRows, currentMovements] = await Promise.all([
        transactionRepo.listForPortfolio(portfolioId),
        taxRepo.listForPortfolio(portfolioId),
        cashMovementRepo.listForPortfolio(portfolioId),
      ]);
      const neededAssetIds = new Set(
        transactions.filter((row) => row.side === 'sell').map((row) => row.assetId),
      );
      const assetsById = await loadAssets([
        ...transactions.map((row) => row.assetId),
        ...dividendRows.map((row) => row.assetId),
        input.assetId,
      ]);
      let movingAverage = new Map<string, SellRealizationEur>();
      let fifo = new Map<string, SellRealizationEur>();
      if (neededAssetIds.size > 0) {
        const taxables = await buildTaxables(
          transactions,
          [],
          neededAssetIds,
          currencyLookup(assetsById),
          createTradeDateConverter(fxWriteError),
        );
        movingAverage = realizationsById(taxables);
        if (liveRegimeStrategy(regime) === 'fifo') fifo = realizationsById(taxables, 'fifo');
      }
      const years = new Set(
        liveDerivableYears(
          { transactions, dividendRows, yearOf: viennaYearOfDate },
          currentMovements,
        ),
      );
      years.add(year);
      const settlements = settleLiveYears({
        regime,
        view: buildLiveView(transactions, dividendRows, movingAverage, fifo, assetsById),
        years: [...years],
        heldOf: (settlementYear) =>
          heldForYear(transactions, dividendRows, currentMovements, settlementYear),
        newEventsByYear: new Map([[year, [{ kind: 'dividend', amountEur: grossEur }]]]),
      });
      for (const settlement of settlements) {
        const correction = taxMovementForDelta(settlement.correctionDeltaEur);
        if (correction) {
          extras.push(
            correctionMovement(
              correction,
              await correctionSourceId(portfolioId),
              settlement.year,
              liveCorrectionNote(regime),
            ),
          );
        }
        if (settlement.year === year) {
          taxAmountEur = settlement.newEventDeltasEur[0] ?? 0;
        }
      }
      rowSettlement = taxMovementForDelta(taxAmountEur ?? 0);
    }

    const newMovements: (NewCashMovement & { linkDividend?: boolean })[] = [
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
      const movementRegime: SettleRegime | null =
        settings.mode === 'custom'
          ? 'custom'
          : settings.mode === 'country_specific'
            ? effectiveCountry(settings)
            : null;
      newMovements.push({
        sourceId: source.id,
        kind: rowSettlement.kind,
        amountEur: rowSettlement.amountEur,
        executedAt,
        note:
          settings.mode === 'manual_per_trade'
            ? NOTE_MANUAL_WITHHELD
            : settlementNote(movementRegime!, rowSettlement.kind),
        taxYear: year,
        linkDividend: true,
      });
    }
    newMovements.push(...extras);

    const existing = await cashMovementRepo.listForPortfolio(portfolioId);
    if (!opts?.force) {
      assertCashSolvent(existing.map(toDomainMovement), newMovements.map(newToDomainMovement));
    }
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
      newMovements,
    );
    await invalidateHistory(
      portfolioId,
      newMovements
        .map((movement) => dayOfDate(movement.executedAt))
        .reduce((left, right) => (left < right ? left : right)),
    );
    const { balanceBySource, totalEur } = await cashBalances(portfolioId);
    return {
      dividend: dividendToDto(inserted.dividend, asset),
      movements: inserted.movements.map((row) => movementToDto(row)),
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
    opts?: { force?: boolean },
  ): Promise<void> {
    await requireOwnedPortfolio(userId, portfolioId);
    const dividend = await taxRepo.findByIdForPortfolio(portfolioId, dividendId);
    if (!dividend) throw notFound('Dividend not found.', 'DIVIDEND_NOT_FOUND');
    const [transactions, dividendRows, movements] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    const remainingDividends = dividendRows.filter((row) => row.id !== dividendId);
    const remainingMovements = movements.filter((row) => row.dividendId !== dividendId);
    const regime = liveRegimeForSettings(await effectiveSettings(userId, portfolioId));
    const corrections: NewCashMovement[] = [];

    if (regime.kind !== 'manual') {
      const strategy = liveRegimeStrategy(regime);
      const neededAssetIds = new Set(
        transactions.filter((row) => row.side === 'sell').map((row) => row.assetId),
      );
      const assetsById = await loadAssets([
        ...transactions.map((row) => row.assetId),
        ...remainingDividends.map((row) => row.assetId),
      ]);
      let movingAverage = new Map<string, SellRealizationEur>();
      let fifo = new Map<string, SellRealizationEur>();
      if (strategy !== null && neededAssetIds.size > 0) {
        const taxables = await buildTaxables(
          transactions,
          [],
          neededAssetIds,
          currencyLookup(assetsById),
          createTradeDateConverter(fxWriteError),
        );
        movingAverage = realizationsById(taxables);
        if (strategy === 'fifo') fifo = realizationsById(taxables, 'fifo');
      }
      const years = new Set(
        liveDerivableYears(
          {
            transactions,
            dividendRows: remainingDividends,
            yearOf: viennaYearOfDate,
          },
          remainingMovements,
        ),
      );
      years.add(viennaYearOfDate(dividend.executedAt));
      const settlements = settleLiveYears({
        regime,
        view: buildLiveView(transactions, remainingDividends, movingAverage, fifo, assetsById),
        years: [...years],
        heldOf: (year) => heldForYear(transactions, remainingDividends, remainingMovements, year),
      });
      for (const settlement of settlements) {
        const spec = taxMovementForDelta(settlement.correctionDeltaEur);
        if (!spec) continue;
        corrections.push(
          correctionMovement(
            spec,
            await correctionSourceId(portfolioId),
            settlement.year,
            liveCorrectionNote(regime),
          ),
        );
      }
    }

    if (!opts?.force) {
      try {
        projectCashLedgerBySource([
          ...remainingMovements.map(toDomainMovement),
          ...corrections.map(newToDomainMovement),
        ]);
      } catch (error) {
        if (error instanceof InsufficientCashError) {
          throw badRequest(
            'Deleting this dividend would overdraw your cash balance on a later date. Add cash or remove the dependent movements first.',
            'CASH_LEDGER_WOULD_GO_NEGATIVE',
            { availableEur: error.balanceEur, shortfallEur: error.shortfallEur },
          );
        }
        throw error;
      }
    }
    if (!(await taxRepo.deleteForPortfolioWithCorrections(portfolioId, dividendId, corrections))) {
      throw notFound('Dividend not found.', 'DIVIDEND_NOT_FOUND');
    }
    await invalidateHistory(
      portfolioId,
      [
        dayOfDate(dividend.executedAt),
        ...corrections.map((row) => dayOfDate(row.executedAt)),
      ].sort()[0]!,
    );
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
    /** Current automatic regime and its realization strategy. */
    liveRegime: LiveRegime;
    liveStrategy: CostBasisStrategy | null;
    /** Account-wide edit markers keyed by Vienna year. */
    lastChangedByYear: ReadonlyMap<number, string>;
    /** Live settlements of every automatic year (empty under the manual regime). */
    liveSettlements: LiveYearSettlement[];
  }

  async function loadReportState(userId: string, portfolioId: string): Promise<ReportState> {
    const settings = await effectiveSettings(userId, portfolioId);
    const liveRegime = liveRegimeForSettings(settings);
    const liveStrategy = liveRegimeStrategy(liveRegime);
    const [transactions, dividendRows, movements, yearChanges] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      taxRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
      taxRepo.listTaxYearChanges(userId),
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
      if (involveDe || involveFi || customFifoSellIds.size > 0 || liveStrategy === 'fifo') {
        deRealizations = realizationsById(taxables, 'fifo');
      }
    }
    const frozenDeEvents = involveDe
      ? deEventsByYear(buildDeView(transactions, dividendRows, deRealizations, assetsById))
      : new Map<number, DeTaxableEvent[]>();

    let liveSettlements: LiveYearSettlement[] = [];
    if (liveRegime.kind !== 'manual') {
      const derivableView = { transactions, dividendRows, yearOf: viennaYearOfDate };
      const liveYears = liveDerivableYears(derivableView, movements);
      if (liveYears.length > 0) {
        liveSettlements = settleLiveYears({
          regime: liveRegime,
          view: buildLiveView(transactions, dividendRows, realizations, deRealizations, assetsById),
          years: liveYears,
          heldOf: (year) => heldForYear(transactions, dividendRows, movements, year),
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
      liveRegime,
      liveStrategy,
      lastChangedByYear: new Map(
        yearChanges.flatMap((change) =>
          change.lastChangedAt === null
            ? []
            : [[change.year, change.lastChangedAt.toISOString()] as const],
        ),
      ),
      liveSettlements,
    };
  }

  /**
   * Self-heal every year on a report read: post the unattached corrections
   * that steer held tax onto the live derived
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
  async function reconcileLiveYears(portfolioId: string, state: ReportState): Promise<void> {
    const pending = state.liveSettlements.filter((s) => s.correctionDeltaEur !== 0);
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
          liveCorrectionNote(state.liveRegime),
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
   * Settings-change reconciliation: re-derive and heal every year
   * right after a per-portfolio tax write, so the new regime's corrections
   * post immediately. Deliberately non-fatal — an unavailable FX rate (or any
   * other read-side failure) must not fail the settings write itself; the
   * next report read retries the heal.
   */
  async function reconcilePortfolio(userId: string, portfolioId: string): Promise<void> {
    try {
      const state = await loadReportState(userId, portfolioId);
      await reconcileLiveYears(portfolioId, state);
    } catch (err) {
      deps.logger?.warn(
        { portfolioId, err },
        'tax reconcile after settings change failed; healing on the next report read',
      );
    }
  }

  /**
   * Automatic rows use the active regime's strategy in every year. Under the
   * literal manual regime, stored DE/custom facts retain their original basis.
   */
  function reportRealization(
    state: ReportState,
    t: TransactionRecord,
  ): SellRealizationEur | undefined {
    if (state.liveRegime.kind !== 'manual' && isDerivableSell(t)) {
      return state.liveStrategy === 'fifo'
        ? state.deRealizations.get(t.id)
        : state.realizations.get(t.id);
    }
    return isDeSell(t) || state.customFifoSellIds.has(t.id)
      ? state.deRealizations.get(t.id)
      : state.realizations.get(t.id);
  }

  /**
   * The DE year-end block follows the active live regime. Manual mode is the
   * sole literal-fact fallback and renders stored DE rows as recorded.
   */
  function deSummaryForYear(state: ReportState, year: number): TaxYearSummary['de'] {
    if (state.liveRegime.kind !== 'manual') {
      if (state.liveRegime.kind !== 'country' || state.liveRegime.country !== TAX_COUNTRY_DE) {
        return undefined;
      }
      const hasDerivable =
        state.transactions.some(
          (t) => isDerivableSell(t) && viennaYearOfDate(t.executedAt) === year,
        ) ||
        state.dividendRows.some(
          (d) => isDerivableDividend(d) && viennaYearOfDate(d.executedAt) === year,
        );
      const deState = state.liveSettlements.find((s) => s.year === year)?.deState;
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
    // A year's net tax is the live derived target (plus the
    // manual-fact component) — normally identical to the movement sum after
    // reconciliation, and still the correct current figure when a withholding
    // correction had to be deferred for solvency.
    let taxNetEur = floorCents(taxWithheldEur - taxRefundedEur);
    const settlement = state.liveSettlements.find((s) => s.year === year);
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
      lastChangedAt: state.lastChangedByYear.get(year) ?? null,
      realizedPnlEur,
      dividendsGrossEur,
      taxWithheldEur,
      taxRefundedEur,
      taxNetEur,
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
    const state = await loadReportState(userId, portfolioId);
    await reconcileLiveYears(portfolioId, state);
    return { years: reportYears(state).map((year) => yearSummary(state, year)) };
  }

  async function getYearReport(
    userId: string,
    portfolioId: string,
    year: number,
  ): Promise<TaxYearReportResponse> {
    await requireOwnedPortfolio(userId, portfolioId);
    const state = await loadReportState(userId, portfolioId);
    await reconcileLiveYears(portfolioId, state);

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
            // The row's frozen facts, never the portfolio's current settings —
            // the only lawful source for a client that has to reconstruct this
            // sell's tax basis (PD8 paranoid migration).
            taxMode: t.taxMode,
            taxAmountEur: t.taxAmountEur,
            taxCountry: toContractCountry(t.taxCountry),
            taxParams: toContractCustomParams(t.taxParams),
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
            taxCountry: toContractCountry(d.taxCountry),
            taxParams: toContractCustomParams(d.taxParams),
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

    async getYearChanges(userId) {
      const years = await taxRepo.listTaxYearDocumentation(userId);
      return {
        years: years.map((row) => ({
          year: row.year,
          lastChangedAt: row.lastChangedAt === null ? null : row.lastChangedAt.toISOString(),
        })),
      };
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
      // #1399: the new regime applies to every documented year immediately.
      await reconcilePortfolio(userId, portfolioId);
      return getPortfolioTaxSettings(userId, portfolioId);
    },

    async clearPortfolioTaxOverride(userId, portfolioId) {
      await requireOwnedPortfolio(userId, portfolioId);
      await portfolioSettingsRepo.deleteSetting(portfolioId, PORTFOLIO_SETTING_KEY_TAX);
      // #1399: dropping the override re-derives every year under the inherited default.
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

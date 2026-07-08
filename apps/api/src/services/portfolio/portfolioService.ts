import type {
  CashEntryRequest,
  CashMovement as CashMovementDto,
  CashMovementResponse,
  CashMovementsResponse,
  CashPreviewRequest,
  CashPreviewResponse,
  CashSource as CashSourceDto,
  CashSourceListResponse,
  CashTransferRequest,
  CashTransferResponse,
  CreateCashSourceRequest,
  CreatePortfolioRequest,
  SetCashBalanceRequest,
  SetCashBalanceResponse,
  UpdateCashSourceRequest,
  Holding as HoldingDto,
  HistoryRange,
  PortfolioHistoryOverlay,
  PortfolioHistoryRange,
  PortfolioPerformancePoint,
  PortfolioListResponse,
  PortfolioResponse,
  PortfolioSummary,
  PortfolioTotals,
  PricePoint as ProviderPricePoint,
  TransactionInput,
  TransactionListResponse,
  Transaction as TransactionDto,
  UpdatePortfolioRequest,
  UpdateTransactionRequest,
} from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { AssetRow } from '../../data/schema';
import { newId } from '../../data/ids';
import type {
  CashMovementRecord,
  CashMovementRepository,
} from '../../data/repositories/cashMovementRepository';
import type {
  CashSourceRecord,
  CashSourceRepository,
} from '../../data/repositories/cashSourceRepository';
import type { FriendshipRepository } from '../../data/repositories/friendshipRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type {
  LinkedCashMovement,
  NewTransaction,
  TransactionRecord,
  TransactionRepository,
} from '../../data/repositories/transactionRepository';
import {
  CASH_EPSILON,
  CASH_MOVEMENT_SIGN,
  cashBalance,
  cashBalancesBySource,
  CashLedgerError,
  externalCashFlowsForTwr,
  InsufficientCashError,
  netWorthSeries,
  pairedTransferMovements,
  projectCashLedgerBySource,
  roundCents,
  setBalanceMovement,
  type CashTransferLegs,
  type SourcedCashMovement,
} from '../../domain/cashLedger';
import {
  dailyCloseSeries,
  deriveHoldings,
  netFlowsOverTime,
  OversellError,
  rebasePerformance,
  reducePosition,
  timeWeightedReturn,
  valueOverTime,
  type FlowPoint,
  type Holding,
  type HoldingAssetInput,
  type PricePoint,
  type Transaction as DomainTransaction,
  type ValueOverTimeAsset,
} from '../../domain/holdings';
import { badRequest, conflict, notFound, unprocessable } from '../../errors';
import type { EventBus } from '../../events';
import type { Logger } from '../../logger';
import { rangeStartMs, type MarketDataService } from '../../providers';
import type { ReferenceBackfill } from '../assets/referenceBackfill';
import { FxRateUnavailableError, type CurrencyService } from '../currency/currencyService';

/**
 * Portfolio service (PROJECTPLAN.md §6.9). Owns the write-side validation and
 * the read-side derivations that turn the transaction ledger — the single
 * source of truth — into holdings, totals and the value-over-time series.
 *
 * The money-critical invariants all live here on the way in and out of the
 * pure `domain/holdings` core:
 *
 *  - **Negative-sell rejection** is enforced server-side by replaying the
 *    asset's full transaction set (existing + the pending change) through
 *    {@link reducePosition}; a sell that pushes the held quantity negative at any
 *    point in time throws {@link OversellError}, mapped to a 400 ("you only hold
 *    3.5 shares"). Validating against the whole timeline — not just the current
 *    holding — means a back-dated transaction is judged correctly.
 *  - **EUR conversion** routes exclusively through the {@link CurrencyService}
 *    keystone (§5.4); no FX math is done here.
 *  - **The value series is cached 1 h** and invalidated on every write (any
 *    transaction or value-point change), per §6.9.
 */

export interface PortfolioServiceDeps {
  portfolioRepo: PortfolioRepository;
  transactionRepo: TransactionRepository;
  cashMovementRepo: CashMovementRepository;
  cashSourceRepo: CashSourceRepository;
  /** Reads the owner's default portfolio visibility, applied at create (§6.9, V2-P9). */
  userRepo: UserRepository;
  marketData: MarketDataService;
  currencyService: CurrencyService;
  referenceBackfill: ReferenceBackfill;
  redis: Redis;
  /** Social graph — used to resolve the owner's friends when a portfolio is shared (§6.10). */
  friendshipRepo: FriendshipRepository;
  /** Domain event bus — `portfolio.shared` is published here on a friends-transition (§6.10). */
  events: EventBus;
  logger?: Logger;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

export interface PortfolioService {
  /**
   * The user's portfolios (§6.8/§7.2), auto-materialising the single default so
   * the list is never empty. Archived portfolios are excluded unless
   * `includeArchived` is set (§13.2 V2-P8).
   */
  listPortfolios(
    userId: string,
    opts?: { includeArchived?: boolean },
  ): Promise<PortfolioListResponse>;
  /** Create a named portfolio; 409 on a duplicate name (§13.2 V2-P8). */
  createPortfolio(userId: string, input: CreatePortfolioRequest): Promise<PortfolioSummary>;
  /**
   * Archive an owned portfolio (§13.2 V2-P8). Rejects (400) archiving the last
   * active portfolio so a user can never be left with zero usable portfolios;
   * 404 when the id is unknown or not the caller's; 400 when already archived.
   */
  archivePortfolio(userId: string, portfolioId: string): Promise<PortfolioSummary>;
  /** Restore an archived portfolio; 404/400 otherwise (§13.2 V2-P8). */
  restorePortfolio(userId: string, portfolioId: string): Promise<PortfolioSummary>;
  /** Rename / change visibility of an owned portfolio; 404 otherwise (§8). */
  updatePortfolio(
    userId: string,
    portfolioId: string,
    patch: UpdatePortfolioRequest,
  ): Promise<PortfolioSummary>;
  /** The default ("Main") portfolio id, materialised on first touch (§6.8). */
  getDefaultPortfolioId(userId: string): Promise<string>;
  listTransactions(
    userId: string,
    portfolioId: string,
    params: { cursor?: string; limit?: number },
  ): Promise<TransactionListResponse>;
  createTransactions(
    userId: string,
    portfolioId: string,
    inputs: TransactionInput[],
  ): Promise<TransactionDto[]>;
  updateTransaction(
    userId: string,
    portfolioId: string,
    id: string,
    patch: UpdateTransactionRequest,
  ): Promise<TransactionDto>;
  deleteTransaction(userId: string, portfolioId: string, id: string): Promise<void>;
  /**
   * Holdings + totals (§6.9), denominated in `opts.baseCurrency` (the caller's
   * per-user base, §5.4/V3-P10d; EUR when omitted). Conversion happens at read
   * time only — stored amounts stay native.
   */
  getPortfolio(
    userId: string,
    portfolioId: string,
    opts?: { baseCurrency?: string },
  ): Promise<PortfolioResponse>;
  /**
   * The portfolio's cash movements (all sources) + rolled-up balance + the
   * sources with per-source balances — the liquidity split (§14, #220, V3-P3).
   */
  getCashMovements(userId: string, portfolioId: string): Promise<CashMovementsResponse>;
  /** The portfolio's cash sources with balances, Main first (V3-P3). */
  listCashSources(
    userId: string,
    portfolioId: string,
    opts?: { includeArchived?: boolean },
  ): Promise<CashSourceListResponse>;
  /** Create a named cash source; 409 on a duplicate name (V3-P3). */
  createCashSource(
    userId: string,
    portfolioId: string,
    input: CreateCashSourceRequest,
  ): Promise<CashSourceDto>;
  /** Rename / relabel a cash source; 404/409 otherwise (V3-P3). */
  updateCashSource(
    userId: string,
    portfolioId: string,
    sourceId: string,
    patch: UpdateCashSourceRequest,
  ): Promise<CashSourceDto>;
  /**
   * Soft-archive a source (V3-P3). Main is never archivable, and only a source
   * whose balance is exactly €0.00 can be archived — an archived source never
   * hides money; its history stays queryable and inside every roll-up.
   */
  archiveCashSource(userId: string, portfolioId: string, sourceId: string): Promise<CashSourceDto>;
  /** Restore an archived source (V3-P3). */
  restoreCashSource(userId: string, portfolioId: string, sourceId: string): Promise<CashSourceDto>;
  /**
   * Transfer between two active sources (V3-P3): one atomic pair of
   * `transfer_out`/`transfer_in` movements — both histories carry it, net worth
   * is unchanged, and it is NEVER a TWR external flow.
   */
  transferCash(
    userId: string,
    portfolioId: string,
    input: CashTransferRequest,
  ): Promise<CashTransferResponse>;
  /**
   * "Set balance to X" (V3-P3, §16 2026-07-07): computes the signed delta from
   * the source's current balance and records it as a normal deposit/withdrawal
   * movement (audit trail intact); a zero delta records nothing.
   */
  setCashBalance(
    userId: string,
    portfolioId: string,
    sourceId: string,
    input: SetCashBalanceRequest,
  ): Promise<SetCashBalanceResponse>;
  /** Record an external cash deposit (§14) into a source (Main by default, V3-P3). */
  depositCash(
    userId: string,
    portfolioId: string,
    input: CashEntryRequest,
  ): Promise<CashMovementResponse>;
  /**
   * Record an external cash withdrawal from a source (Main by default);
   * rejects an overdraw of that source (§14/V3-P3, no silent negatives).
   */
  withdrawCash(
    userId: string,
    portfolioId: string,
    input: CashEntryRequest,
  ): Promise<CashMovementResponse>;
  /** Live "available → after" preview against one source's balance (§14, V3-P3). */
  previewCash(
    userId: string,
    portfolioId: string,
    input: CashPreviewRequest,
  ): Promise<CashPreviewResponse>;
  /**
   * The value/performance series (§6.9), denominated in `opts.baseCurrency`
   * (EUR when omitted). Non-EUR bases convert the cached EUR ingredients day
   * by day with **historical daily FX rates** — never one spot rate across
   * the curve — and derive the TWR from the converted values + flows, so a
   * USD user's performance is their true USD-terms performance (V3-P10d).
   */
  getHistory(
    userId: string,
    portfolioId: string,
    range: PortfolioHistoryRange,
    opts?: { overlay?: boolean; baseCurrency?: string },
  ): Promise<{
    range: PortfolioHistoryRange;
    baseCurrency: string;
    points: Array<{ date: string; valueEur: number }>;
    performance: PortfolioPerformancePoint[];
    assets?: PortfolioHistoryOverlay[];
  }>;
  /** Drop the cached value series for a portfolio (called on any write). */
  invalidateHistory(portfolioId: string): Promise<void>;
}

const DEFAULT_LIMIT = 50;
const HISTORY_TTL_SECONDS = 3600; // 1 h (§6.9).

/**
 * Redis key for the cached, full value-over-time payload of a portfolio.
 *
 * Versioned (`v5`): the cached *shape* changed with V3-P10d — the payload now
 * stores the raw EUR **ingredients** (net-worth points + external flows)
 * instead of a precomputed performance curve, so one cached entry serves every
 * per-user base currency via read-time conversion (`v4` was the #311 net-worth
 * semantics, `v3` added the #125 performance series, `v2` the #122 overlays).
 * Bumping the version also wholesale-invalidates every series a *previous*
 * deployment computed. The 1 h TTL is only refreshed by writes, so without the
 * bump a pre-deploy entry — possibly computed by older, buggier code — would
 * keep being served for up to an hour after a fix ships (exactly the stale
 * single-point graph reported in #122).
 */
export function portfolioHistoryCacheKey(portfolioId: string): string {
  return `portfolio:history:v5:${portfolioId}`;
}

/**
 * The full cached graph payload, always EUR-denominated (the storage base):
 * the net-worth value curve, the external TWR flows it pairs with, and the
 * per-asset overlay series (native currency). Per-user bases are applied at
 * read time (see `getHistory`), so this cache stays one-entry-per-portfolio.
 */
interface HistoryPayload {
  points: Array<{ date: string; valueEur: number }>;
  flows: FlowPoint[];
  assets: PortfolioHistoryOverlay[];
}

/** Months of history each non-MAX range covers (§6.9: 1M / 6M / 1Y / Max). */
const RANGE_MONTHS: Record<Exclude<PortfolioHistoryRange, 'MAX'>, number> = {
  '1M': 1,
  '6M': 6,
  '1Y': 12,
};

export function createPortfolioService(deps: PortfolioServiceDeps): PortfolioService {
  const {
    portfolioRepo,
    transactionRepo,
    cashMovementRepo,
    cashSourceRepo,
    userRepo,
    marketData,
    currencyService,
    referenceBackfill,
    redis,
    friendshipRepo,
    events,
    logger,
  } = deps;
  const now = deps.now ?? Date.now;
  // The STORAGE base (EUR): the cash ledger's currency and the denomination of
  // the cached history ingredients. A caller's per-user base (V3-P10d) never
  // replaces this — it is applied at read time via `fxFor`/`seriesInBase`.
  const baseCurrency = currencyService.baseCurrency;

  /** Today's UTC calendar day, the last point of the value series. */
  function todayIso(): string {
    return new Date(now()).toISOString().slice(0, 10);
  }

  /** Map a stored record / input into the pure-domain transaction shape. */
  function recordToDomain(r: TransactionRecord): DomainTransaction {
    return {
      assetId: r.assetId,
      side: r.side,
      quantity: r.quantity,
      price: r.price,
      fee: r.fee,
      executedAt: r.executedAt.toISOString(),
    };
  }

  function inputToDomain(i: TransactionInput): DomainTransaction {
    return {
      assetId: i.assetId,
      side: i.side,
      quantity: i.quantity,
      price: i.price,
      fee: i.fee,
      // Normalize through Date exactly like the insert + recordToDomain path
      // does, so create-time oversell validation replays the timeline the DB
      // will hold — client timestamps may carry a different sub-second
      // precision or zone offset than the stored rows (issue #218).
      executedAt: new Date(i.executedAt).toISOString(),
    };
  }

  function assetToDto(row: AssetRow): TransactionDto['asset'] {
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

  function recordToDto(r: TransactionRecord, asset: AssetRow): TransactionDto {
    return {
      id: r.id,
      assetId: r.assetId,
      side: r.side,
      quantity: r.quantity,
      price: r.price,
      fee: r.fee,
      executedAt: r.executedAt.toISOString(),
      note: r.note,
      asset: assetToDto(asset),
    };
  }

  /** Resolve + index the asset rows for a set of ids, asserting each is visible. */
  async function loadVisibleAssets(userId: string, ids: string[]): Promise<Map<string, AssetRow>> {
    const rows = await portfolioRepo.assetsByIds(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = byId.get(id);
      // A global market asset, or the caller's own custom asset. Anything else
      // (missing, or another user's custom asset) is a 404 — nothing leaks (§10).
      if (!row || (row.ownerId !== null && row.ownerId !== userId)) {
        throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
      }
    }
    return byId;
  }

  /** Replay a single asset's full transaction set, mapping oversell to a 400. */
  function assertNoOversell(domainTxns: DomainTransaction[]): void {
    try {
      reducePosition(domainTxns);
    } catch (err) {
      if (err instanceof OversellError) {
        throw badRequest(`You only hold ${err.held} shares.`, 'OVERSELL', {
          held: err.held,
          requested: err.requested,
          assetId: err.assetId,
        });
      }
      throw err;
    }
  }

  async function invalidateHistory(portfolioId: string): Promise<void> {
    await redis.del(portfolioHistoryCacheKey(portfolioId));
  }

  /**
   * Publish one `portfolio.shared` per current friend of the owner (§6.10) so the
   * notification dispatcher can tell each friend the portfolio is now shared.
   * Best-effort: resolving friends or a bus failure never fails the update.
   */
  async function emitPortfolioShared(ownerId: string, portfolioId: string): Promise<void> {
    try {
      const [ownerUsername, friends] = await Promise.all([
        friendshipRepo.getUsername(ownerId),
        friendshipRepo.listFriends(ownerId),
      ]);
      const occurredAt = new Date(now()).toISOString();
      for (const friend of friends) {
        await events.publish({
          type: 'portfolio.shared',
          userId: friend.id,
          actorId: ownerId,
          actorUsername: ownerUsername ?? '',
          portfolioId,
          occurredAt,
        });
      }
    } catch (err) {
      logger?.error({ err, portfolioId }, 'portfolio.shared event publish failed');
    }
  }

  /**
   * Resolve a portfolio the caller owns, or 404 (§8). Ownership is enforced in
   * the repository (`WHERE user_id = session.user`), so another user's id is
   * indistinguishable from a missing one — no IDOR, and never a 403.
   */
  async function requireOwnedPortfolio(
    userId: string,
    portfolioId: string,
  ): Promise<PortfolioSummary> {
    const portfolio = await portfolioRepo.findByIdForUser(userId, portfolioId);
    if (!portfolio) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
    return portfolio;
  }

  // --- Cash ledger (§14, #220; cash sources V3-P3) ---------------------------

  /**
   * Map a stored cash-movement row into the pure-domain movement shape. The
   * result carries the `sourceId`, so it feeds the per-source functions
   * (solvency, per-source balances) and — being a structural superset — every
   * portfolio-level roll-up (`cashBalance`, `netWorthSeries`,
   * `externalCashFlowsForTwr`) unchanged.
   */
  function toDomainMovement(r: CashMovementRecord): SourcedCashMovement {
    return {
      kind: r.kind,
      amountEur: r.amountEur,
      occurredAt: r.executedAt.toISOString(),
      sourceId: r.sourceId,
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
      executedAt: r.executedAt.toISOString(),
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    };
  }

  function sourceToDto(record: CashSourceRecord, balanceEur: number): CashSourceDto {
    return {
      id: record.id,
      name: record.name,
      type: record.type,
      isMain: record.isMain,
      archivedAt: record.archivedAt ? record.archivedAt.toISOString() : null,
      createdAt: record.createdAt.toISOString(),
      balanceEur,
    };
  }

  /**
   * Current EUR cash balance = sum of signed movements (§14 reconciliation
   * invariant), quantized to whole cents. Movements enter the ledger already
   * cent-exact (deposit/withdraw and cash-linked buys/sells all pass through
   * {@link roundCents}), so this only sheds FP summation dust — the reported
   * balance is always exact cents, which is what lets a withdraw-all land at
   * exactly €0.00 (V3-P0, issue #322). Rolls up across ALL sources (V3-P3).
   */
  async function cashBalanceFor(portfolioId: string): Promise<number> {
    const records = await cashMovementRepo.listForPortfolio(portfolioId);
    return roundCents(cashBalance(records.map(toDomainMovement)));
  }

  /**
   * The portfolio's movements plus its per-source **cent-quantized** balances
   * (V3-P3): sources without movements read €0.00. One ledger read feeds both.
   */
  async function loadCashState(portfolioId: string): Promise<{
    records: CashMovementRecord[];
    balanceBySource: Map<string, number>;
    totalEur: number;
  }> {
    const records = await cashMovementRepo.listForPortfolio(portfolioId);
    const raw = cashBalancesBySource(records.map(toDomainMovement));
    const balanceBySource = new Map<string, number>();
    for (const [sourceId, balance] of raw) balanceBySource.set(sourceId, roundCents(balance));
    return {
      records,
      balanceBySource,
      totalEur: roundCents(cashBalance(records.map(toDomainMovement))),
    };
  }

  /** Resolve a source inside this portfolio, or 404 (never leaks across users). */
  async function requireSource(portfolioId: string, sourceId: string): Promise<CashSourceRecord> {
    const source = await cashSourceRepo.findByIdForPortfolio(portfolioId, sourceId);
    if (!source) throw notFound('Cash source not found.', 'CASH_SOURCE_NOT_FOUND');
    return source;
  }

  /**
   * Resolve the source a cash flow targets (V3-P3): the explicitly requested
   * one — which must be *active*; archived sources keep history but accept no
   * new movements — or the portfolio's Main, materialised on first touch.
   */
  async function resolveFlowSource(
    portfolioId: string,
    sourceId: string | undefined,
  ): Promise<CashSourceRecord> {
    if (sourceId === undefined) return cashSourceRepo.getOrCreateMain(portfolioId);
    const source = await requireSource(portfolioId, sourceId);
    if (source.archivedAt) {
      throw badRequest(
        'This cash source is archived. Restore it before recording new movements.',
        'CASH_SOURCE_ARCHIVED',
      );
    }
    return source;
  }

  /**
   * Replay every source's ledger with the proposed movements appended and
   * reject (400 `INSUFFICIENT_CASH`) if any source would dip negative at any
   * point — the single no-silent-negative gate, per source (V3-P3: money in
   * "Bank" cannot cover an overdraft of "Main"), driven entirely by
   * `domain/cashLedger`.
   */
  function assertCashSolvent(
    existing: readonly CashMovementRecord[],
    proposed: readonly SourcedCashMovement[],
  ): void {
    try {
      projectCashLedgerBySource([...existing.map(toDomainMovement), ...proposed]);
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

  /**
   * Convert a native-currency amount to EUR at the movement date, or 400 if no
   * FX. Deliberately pinned to EUR — the cash ledger's storage currency — and
   * NOT the caller's base (V3-P10d): this is a *write* path, and stored
   * amounts always stay native per §5.4.
   */
  async function toCashEur(amountNative: number, currency: string, day: string): Promise<number> {
    try {
      return await currencyService.toBase(amountNative, currency, { date: day });
    } catch {
      throw badRequest(
        'Cash-linked transactions need a EUR conversion that is currently unavailable for this asset.',
        'CASH_FX_UNAVAILABLE',
        { currency },
      );
    }
  }

  // --- Per-user base currency (§5.4, V3-P10d) --------------------------------

  /**
   * The §5.4 conversion view for a request's effective base: the caller's
   * per-user base when supplied, the service default (EUR) otherwise. Same
   * FxRateSource underneath — the §5.3 caches and coalescing are shared.
   */
  const fxFor = (base?: string): CurrencyService =>
    base === undefined ? currencyService : currencyService.withBase(base);

  /**
   * The (EUR-stored) cash balance in `fx`'s base at the current spot rate.
   * Identity for the EUR base; a base whose spot rate is unavailable is a 422
   * — cash cannot silently stay EUR inside a response that declares another
   * denomination.
   */
  async function cashInBase(cashEur: number, fx: CurrencyService): Promise<number> {
    if (fx.baseCurrency === baseCurrency || cashEur === 0) return cashEur;
    try {
      return await fx.toBase(cashEur, baseCurrency);
    } catch {
      throw unprocessable(
        `Exchange rates for your base currency (${fx.baseCurrency}) are currently unavailable.`,
        'BASE_FX_UNAVAILABLE',
      );
    }
  }

  /**
   * The cached EUR series ingredients converted into `fx`'s base, each day at
   * that day's **historical** FX rate (§5.4) — a value curve re-priced with one
   * spot rate would fake the FX leg of every past day. Identity (no lookups)
   * for the EUR base. Days before the FX pair's recorded history (beyond the
   * nearest-prior window) are dropped from points and flows alike — the curve
   * starts where it can be stated honestly in the requested base.
   */
  async function seriesInBase(
    payload: HistoryPayload,
    fx: CurrencyService,
  ): Promise<{ points: HistoryPayload['points']; flows: FlowPoint[] }> {
    if (fx.baseCurrency === baseCurrency) return { points: payload.points, flows: payload.flows };

    const dates = new Set<string>();
    for (const p of payload.points) dates.add(p.date);
    for (const f of payload.flows) dates.add(f.date);

    // One rate per distinct day; the FX source memoises the pair's daily-close
    // series, so this is one provider fetch + N map lookups, not N fetches.
    const rateByDate = new Map<string, number>();
    for (const date of dates) {
      try {
        rateByDate.set(date, await fx.getRate(baseCurrency, fx.baseCurrency, { date }));
      } catch (err) {
        if (err instanceof FxRateUnavailableError) continue;
        throw err;
      }
    }

    return {
      points: payload.points
        .filter((p) => rateByDate.has(p.date))
        .map((p) => ({ date: p.date, valueEur: p.valueEur * rateByDate.get(p.date)! })),
      flows: payload.flows
        .filter((f) => rateByDate.has(f.date))
        .map((f) => ({ date: f.date, flowEur: f.flowEur * rateByDate.get(f.date)! })),
    };
  }

  /**
   * Build the linked cash movement for a cash-flagged buy/sell (§14), or null
   * when the flag is off or the net EUR amount rounds to nothing. A buy funded
   * from cash books an internal `buy` (cash↓, TWR-neutral) for its total cost
   * (quantity·price + fee); a sell adds `sell_proceeds` (cash↑) for its net
   * proceeds (quantity·price − fee). A flag that contradicts the side is a 400.
   * The movement lands in `sourceId` — the caller-resolved cash source (V3-P3).
   */
  async function buildCashLink(
    input: TransactionInput,
    asset: AssetRow,
    sourceId: string,
  ): Promise<LinkedCashMovement | null> {
    if (input.payFromCash && input.side !== 'buy') {
      throw badRequest('"Pay from cash" applies only to buys.', 'CASH_FLAG_MISMATCH');
    }
    if (input.addProceedsToCash && input.side !== 'sell') {
      throw badRequest('"Add proceeds to cash" applies only to sells.', 'CASH_FLAG_MISMATCH');
    }
    const day = new Date(input.executedAt).toISOString().slice(0, 10);

    // Cash is whole-cent money: a currency conversion can yield sub-cent EUR,
    // so quantize the linked movement to cents before it enters the ledger
    // (V3-P0 exact-cents fix, #322) — otherwise the sub-cent residue strands a
    // reported cent that can never be withdrawn.
    if (input.payFromCash && input.side === 'buy') {
      const costEur = roundCents(
        await toCashEur(input.quantity * input.price + input.fee, asset.currency, day),
      );
      if (costEur <= CASH_EPSILON) return null;
      return { kind: 'buy', amountEur: -costEur, sourceId, note: 'Paid from cash balance' };
    }
    if (input.addProceedsToCash && input.side === 'sell') {
      const proceedsEur = roundCents(
        await toCashEur(input.quantity * input.price - input.fee, asset.currency, day),
      );
      if (proceedsEur <= CASH_EPSILON) return null;
      return {
        kind: 'sell_proceeds',
        amountEur: proceedsEur,
        sourceId,
        note: 'Proceeds added to cash balance',
      };
    }
    return null;
  }

  /** The empty graph payload (no transactions / nothing convertible to plot). */
  const emptyHistory = (): HistoryPayload => ({ points: [], flows: [], assets: [] });

  /**
   * The full value-over-time payload for a portfolio (first transaction or
   * cash movement → today), cached 1 h: the EUR **net-worth** curve (holdings
   * value + EOD cash balance, #311), its TWR performance series, and each held
   * asset's own daily price series (the #122 overlay). Recomputed on a cache
   * miss and re-stored; the range slice is applied by the caller. Invalidated
   * wholesale on any write — transactions, value points *and* cash movements —
   * so a back-dated entry reshapes the history immediately (§6.9).
   *
   * Per-asset daily prices come from the provider layer (`marketData.getHistory`
   * at `1d`, §5.2/§5.3 — cached, coalesced, budgeted), merged over the stored
   * `price_history` rows which act as the outage fallback — see
   * {@link mergeDailyPrices}. The overlay series reuse exactly these merged
   * prices, so overlays add **zero** provider requests.
   */
  async function loadSeries(portfolioId: string): Promise<HistoryPayload> {
    const key = portfolioHistoryCacheKey(portfolioId);
    const cached = await redis.get(key);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as HistoryPayload;
        // Shape guard: only trust entries this code version wrote.
        if (
          parsed &&
          Array.isArray(parsed.points) &&
          Array.isArray(parsed.flows) &&
          Array.isArray(parsed.assets)
        ) {
          return parsed;
        }
      } catch {
        // Corrupt cache entry — fall through and recompute.
      }
    }

    const [txns, cashRecords] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    if (txns.length === 0 && cashRecords.length === 0) {
      const empty = emptyHistory();
      await redis.set(key, JSON.stringify(empty), 'EX', HISTORY_TTL_SECONDS);
      return empty;
    }

    const today = todayIso();
    const movements = cashRecords.map(toDomainMovement);
    // Transactions with a linked cash movement (§14): internal cash↔holdings
    // conversions, excluded from the external TWR flows below (their external
    // flow was booked when the cash was deposited — cashLedger wiring rule 2).
    const linkedTxnIds = new Set(
      cashRecords.map((r) => r.transactionId).filter((id): id is string => id !== null),
    );
    const legs =
      txns.length > 0
        ? await buildHoldingsLegs(txns, linkedTxnIds, today)
        : { points: [], flows: [], overlays: [] };

    // The absolute curve is the NET-WORTH curve (#311): holdings value plus
    // the end-of-day cash balance — a deposit moves it by exactly its amount,
    // a cash-funded buy leaves it flat at the trade moment (money changes
    // form). The EXTERNAL flows (#125) — ledger deposits/withdrawals plus
    // transactions not funded from cash — are cached alongside rather than a
    // precomputed TWR curve, because the performance in a non-EUR base needs
    // BOTH ingredients converted per day first (V3-P10d); timeWeightedReturn
    // aggregates same-day flows, so the two sparse series concatenate safely.
    const points = netWorthSeries({ holdingsValues: legs.points, movements, today });
    const flows = [...legs.flows, ...externalCashFlowsForTwr(movements)];

    const payload: HistoryPayload = { points, flows, assets: legs.overlays };
    await redis.set(key, JSON.stringify(payload), 'EX', HISTORY_TTL_SECONDS);
    return payload;
  }

  /**
   * The holdings-only legs of the graph payload: the daily holdings value
   * curve, the external transaction flows (cash-funded transactions excluded,
   * see {@link loadSeries}), and the #122 overlay series. Degrades to empty
   * legs when no holding is EUR-convertible.
   */
  async function buildHoldingsLegs(
    txns: TransactionRecord[],
    linkedTxnIds: ReadonlySet<string>,
    today: string,
  ): Promise<{
    points: Array<{ date: string; valueEur: number }>;
    flows: FlowPoint[];
    overlays: PortfolioHistoryOverlay[];
  }> {
    const assetIds = [...new Set(txns.map((t) => t.assetId))];
    const assetsById = new Map((await portfolioRepo.assetsByIds(assetIds)).map((r) => [r.id, r]));

    // The value series converts each day's native sum to EUR via *historical* FX,
    // which is not yet available for non-base currencies (§5.4 future work). Rather
    // than 500 on a non-EUR holding (e.g. a USD custom asset or market stock), we
    // degrade exactly like getPortfolio drops an unconvertible quote: probe each
    // distinct non-base currency once and exclude assets we can't convert from the
    // series. When historical FX lands this path starts including them automatically.
    const convertible = new Map<string, boolean>();
    for (const asset of assetsById.values()) {
      const ccy = asset.currency;
      if (ccy === baseCurrency || convertible.has(ccy)) continue;
      try {
        await currencyService.toBase(1, ccy, { date: today });
        convertible.set(ccy, true);
      } catch {
        convertible.set(ccy, false);
      }
    }
    const isConvertible = (ccy: string): boolean =>
      ccy === baseCurrency || convertible.get(ccy) === true;

    const usableAssetIds = assetIds.filter((id) => {
      const asset = assetsById.get(id);
      return asset !== undefined && isConvertible(asset.currency);
    });

    // No EUR-convertible holding has any history to plot — degrade to empty
    // legs instead of throwing mid-conversion (the cash leg still renders).
    if (usableAssetIds.length === 0) return { points: [], flows: [], overlays: [] };

    const usableIdSet = new Set(usableAssetIds);

    // Stored daily closes / custom value points (`price_history`): the durable
    // fallback layer of the series.
    const priceRows = await portfolioRepo.pricesForAssets(usableAssetIds);
    const storedByAsset = new Map<string, PricePoint[]>();
    for (const row of priceRows) {
      const list = storedByAsset.get(row.assetId);
      const point: PricePoint = { date: row.date, close: row.close };
      if (list) list.push(point);
      else storedByAsset.set(row.assetId, [point]);
    }

    // The primary layer is each asset's real daily history through the
    // market-data keystone (§5.2/§5.3) — cached, coalesced, serve-stale — so
    // the curve moves with the market day by day instead of only at
    // transaction or value-point events. Custom assets route through the
    // manual provider via the exact same call: zero special-casing (§5.2).
    // Best-effort per asset: an outage past the stale window degrades that
    // asset to its stored rows above — the chart renders what is available.
    const firstTxnDay = txns
      .map((t) => t.executedAt.toISOString().slice(0, 10))
      .reduce((a, b) => (a < b ? a : b));
    const range = seriesHistoryRange(firstTxnDay, today);
    const providerPrices = await Promise.all(
      usableAssetIds.map(async (assetId): Promise<readonly ProviderPricePoint[]> => {
        const asset = assetsById.get(assetId);
        if (!asset) return [];
        try {
          const cached = await marketData.getHistory(
            { providerId: asset.providerId, providerRef: asset.providerRef },
            range,
            '1d',
          );
          return cached.value;
        } catch {
          return [];
        }
      }),
    );

    const valueAssets: ValueOverTimeAsset[] = usableAssetIds.map((assetId, i) => {
      const asset = assetsById.get(assetId);
      if (!asset) throw new Error(`Asset ${assetId} missing while building value series`);
      return {
        assetId,
        currency: asset.currency,
        prices: mergeDailyPrices(storedByAsset.get(assetId) ?? [], providerPrices[i] ?? []),
      };
    });

    const usableRecords = txns.filter((t) => usableIdSet.has(t.assetId));
    const usableTxns = usableRecords.map(recordToDomain);
    const points = await valueOverTime({
      transactions: usableTxns,
      assets: valueAssets,
      today,
      converter: currencyService,
    });

    // External transaction flows (#125): a buy/sell settled *outside* the
    // portfolio is money crossing the boundary. Cash-funded transactions are
    // internal conversions and are excluded here (#311, cashLedger wiring
    // rule 2) — their external flow was already booked when the cash entered
    // the ledger; counting them again would double the flow.
    const flows = await netFlowsOverTime({
      transactions: usableRecords.filter((t) => !linkedTxnIds.has(t.id)).map(recordToDomain),
      currencyByAsset: new Map(valueAssets.map((a) => [a.assetId, a.currency])),
      converter: currencyService,
    });

    // Overlay series (#122): each held asset's own daily closes over the same
    // window, expanded to the portfolio curve's daily grid (weekends/holidays
    // carry the last known close forward — see dailyCloseSeries) so every
    // overlay point lines up with a curve point. Built from the merged prices
    // already fetched above; assets whose price data starts later simply start
    // where their data starts, and assets with no data at all are omitted.
    const overlays: PortfolioHistoryOverlay[] = [];
    for (const valueAsset of valueAssets) {
      const asset = assetsById.get(valueAsset.assetId);
      if (!asset) continue; // unreachable: valueAssets is built from assetsById
      const overlayPoints = dailyCloseSeries(valueAsset.prices, firstTxnDay, today);
      if (overlayPoints.length === 0) continue;
      overlays.push({
        assetId: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        currency: asset.currency,
        points: overlayPoints,
      });
    }

    return { points, flows, overlays };
  }

  return {
    async listPortfolios(userId, opts) {
      // Materialise the guaranteed default so the list is never empty (§6.8):
      // seeded/invited users alike always have exactly one auto-created row.
      await portfolioRepo.getOrCreateMain(userId);
      const portfolios = await portfolioRepo.listForUser(userId, {
        includeArchived: opts?.includeArchived ?? false,
      });
      return { portfolios };
    },

    async createPortfolio(userId, input) {
      // Materialise the default first so the very first extra portfolio never
      // outranks a not-yet-created "Main" (which owns sort_order 0, §6.8).
      await portfolioRepo.getOrCreateMain(userId);
      const name = input.name.trim();
      // Reject a duplicate name up-front (the unique index spans archived rows)
      // with a clean 409 rather than surfacing a raw DB constraint error.
      if (await portfolioRepo.nameExists(userId, name)) {
        throw conflict('A portfolio with that name already exists.', 'PORTFOLIO_NAME_TAKEN');
      }
      // A newly created portfolio adopts the owner's default visibility (§6.9,
      // V2-P9). The auto-created "Main" is provisioned before any preference
      // exists (getOrCreateMain above), so it always stays `private`; only an
      // explicit create honours the default. Existing portfolios are untouched.
      const visibility = await userRepo.getDefaultPortfolioVisibility(userId);
      return portfolioRepo.createPortfolio(userId, name, visibility);
    },

    async archivePortfolio(userId, portfolioId) {
      const portfolio = await portfolioRepo.findByIdForUser(userId, portfolioId);
      if (!portfolio) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
      if (portfolio.archivedAt) {
        throw badRequest('Portfolio is already archived.', 'PORTFOLIO_ALREADY_ARCHIVED');
      }
      // The default-portfolio invariant: never leave the user with zero active
      // portfolios (§13.2 V2-P8). Archiving the last active one — or the current
      // default with no other active row to take over — is rejected. When
      // another active row exists, the default recomputes to it automatically
      // (the default is derived from the active set, §6.8).
      const activeCount = await portfolioRepo.countActive(userId);
      if (activeCount <= 1) {
        throw badRequest('You cannot archive your only active portfolio.', 'LAST_ACTIVE_PORTFOLIO');
      }
      const archived = await portfolioRepo.archivePortfolio(userId, portfolioId, new Date(now()));
      // Concurrent archive raced us to null → treat as already archived.
      if (!archived)
        throw badRequest('Portfolio is already archived.', 'PORTFOLIO_ALREADY_ARCHIVED');
      return archived;
    },

    async restorePortfolio(userId, portfolioId) {
      const portfolio = await portfolioRepo.findByIdForUser(userId, portfolioId);
      if (!portfolio) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
      if (!portfolio.archivedAt) {
        throw badRequest('Portfolio is not archived.', 'PORTFOLIO_NOT_ARCHIVED');
      }
      const restored = await portfolioRepo.restorePortfolio(userId, portfolioId);
      if (!restored) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
      return restored;
    },

    async updatePortfolio(userId, portfolioId, patch) {
      // Capture the prior visibility so we only fire `portfolio.shared` on an
      // actual transition *to* friends — not on a no-op re-save or a toggle-off.
      const before = await portfolioRepo.findByIdForUser(userId, portfolioId);
      if (!before) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
      // Reject a rename that collides with another of the user's portfolios up
      // front (the unique index spans archived rows) with the same clean 409 the
      // create path emits — otherwise the `portfolios_user_name_unique` violation
      // would surface as a raw 500 on a routine rename. Only check when the name
      // actually changes; excluding this row lets a no-op re-save through.
      if (patch.name !== undefined && patch.name !== before.name) {
        if (await portfolioRepo.nameExists(userId, patch.name, portfolioId)) {
          throw conflict('A portfolio with that name already exists.', 'PORTFOLIO_NAME_TAKEN');
        }
      }
      const updated = await portfolioRepo.updatePortfolio(userId, portfolioId, {
        name: patch.name,
        visibility: patch.visibility,
        defaultPayFromCash: patch.defaultPayFromCash,
      });
      if (!updated) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');

      if (patch.visibility === 'friends' && before?.visibility !== 'friends') {
        await emitPortfolioShared(userId, portfolioId);
      }
      return updated;
    },

    getDefaultPortfolioId(userId) {
      return portfolioRepo.getOrCreateMain(userId);
    },

    async listTransactions(userId, portfolioId, params) {
      await requireOwnedPortfolio(userId, portfolioId);
      const limit = params.limit ?? DEFAULT_LIMIT;
      const { items, nextCursor } = await transactionRepo.listByPortfolio(portfolioId, {
        limit,
        cursor: params.cursor,
      });
      return {
        items: items.map((row) => ({
          id: row.id,
          assetId: row.assetId,
          side: row.side,
          quantity: row.quantity,
          price: row.price,
          fee: row.fee,
          executedAt: row.executedAt.toISOString(),
          note: row.note,
          asset: {
            id: row.asset.id,
            symbol: row.asset.symbol,
            name: row.asset.name,
            exchange: row.asset.exchange,
            currency: row.asset.currency,
            type: row.asset.type,
            isCustom: row.asset.isCustom,
          },
        })),
        nextCursor,
      };
    },

    async createTransactions(userId, portfolioId, inputs) {
      if (inputs.length === 0) throw badRequest('No transactions to create.', 'EMPTY_BATCH');
      await requireOwnedPortfolio(userId, portfolioId);

      const assetIds = [...new Set(inputs.map((i) => i.assetId))];
      const assetsById = await loadVisibleAssets(userId, assetIds);

      // Validate per asset against the *whole* timeline (existing + pending), so
      // back-dated sells and intra-batch interleaving are judged correctly.
      for (const assetId of assetIds) {
        const existing = await transactionRepo.listForAsset(portfolioId, assetId);
        const pending = inputs.filter((i) => i.assetId === assetId).map(inputToDomain);
        assertNoOversell([...existing.map(recordToDomain), ...pending]);
      }

      // Cash-ledger linkage (§14, #220; V3-P3): resolve each cash-flagged
      // buy/sell into a linked EUR movement against its cash source — the
      // explicitly requested one (must be active) or Main — then reject
      // up-front if the batch, replayed over the existing ledger, would ever
      // overdraw any source (no silent negative balances). The transactions and
      // their movements are then written atomically.
      const flowSourceCache = new Map<string, Promise<CashSourceRecord>>();
      const flowSource = (sourceId: string | undefined): Promise<CashSourceRecord> => {
        const key = sourceId ?? '';
        let cached = flowSourceCache.get(key);
        if (!cached) {
          cached = resolveFlowSource(portfolioId, sourceId);
          flowSourceCache.set(key, cached);
        }
        return cached;
      };
      const cashLinks = await Promise.all(
        inputs.map(async (input) => {
          if (!input.payFromCash && !input.addProceedsToCash) {
            if (input.cashSourceId !== undefined) {
              throw badRequest(
                'A cash source applies only together with "pay from cash" or "add proceeds to cash".',
                'CASH_FLAG_MISMATCH',
              );
            }
            return null;
          }
          const asset = assetsById.get(input.assetId);
          if (!asset) throw new Error(`Asset ${input.assetId} missing while linking cash`);
          const source = await flowSource(input.cashSourceId);
          return buildCashLink(input, asset, source.id);
        }),
      );
      if (cashLinks.some((link) => link)) {
        const existing = await cashMovementRepo.listForPortfolio(portfolioId);
        const proposed: SourcedCashMovement[] = cashLinks
          .map((link, i): SourcedCashMovement | null =>
            link
              ? {
                  kind: link.kind,
                  amountEur: link.amountEur,
                  sourceId: link.sourceId,
                  occurredAt: new Date(inputs[i]!.executedAt).toISOString(),
                }
              : null,
          )
          .filter((m): m is SourcedCashMovement => m !== null);
        assertCashSolvent(existing, proposed);
      }

      const inserted = await transactionRepo.insertMany(
        portfolioId,
        inputs.map(
          (i, idx): NewTransaction => ({
            assetId: i.assetId,
            side: i.side,
            quantity: i.quantity,
            price: i.price,
            fee: i.fee,
            executedAt: new Date(i.executedAt),
            note: i.note ?? null,
            cashMovement: cashLinks[idx],
          }),
        ),
      );

      await invalidateHistory(portfolioId);

      // First reference (§6.2/§9): transacting on an asset warms its daily
      // history so the value-over-time series has closes to plot — seeded and
      // enrichment-upserted catalog rows get their backfill here. Best-effort.
      for (const assetId of assetIds) {
        await referenceBackfill.ensureHistory(assetId);
      }

      return inserted.map((r) => {
        const asset = assetsById.get(r.assetId);
        if (!asset) throw new Error(`Asset ${r.assetId} missing after insert`);
        return recordToDto(r, asset);
      });
    },

    async updateTransaction(userId, portfolioId, id, patch) {
      await requireOwnedPortfolio(userId, portfolioId);
      const existing = await transactionRepo.findByIdForUser(userId, id);
      // Scope the transaction to *this* portfolio: a txn in another (even owned)
      // portfolio is a 404 on this path, matching the scoped URL (§8).
      if (!existing || existing.portfolioId !== portfolioId) {
        throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');
      }

      // A cash-linked buy/sell (§14) carries an internal cash movement whose EUR
      // amount and date mirror the trade. The patch cannot restate the linkage
      // flags or re-derive the native→EUR amount, so editing a financial field
      // would desync the movement — inflating net worth and faking TWR
      // performance with no external flow. Reject such edits (the note stays
      // editable); to change the numbers, delete and re-add the transaction.
      const financialEdit =
        patch.side !== undefined ||
        patch.quantity !== undefined ||
        patch.price !== undefined ||
        patch.fee !== undefined ||
        patch.executedAt !== undefined;
      if (financialEdit) {
        const movements = await cashMovementRepo.listForPortfolio(portfolioId);
        if (movements.some((m) => m.transactionId === id)) {
          throw badRequest(
            'This transaction is funded from (or pays into) your cash balance. Delete and re-add it to change the amount.',
            'TRANSACTION_CASH_LINKED',
          );
        }
      }

      // Build the asset's set with the edited row swapped in, then re-validate.
      const siblings = await transactionRepo.listForAsset(existing.portfolioId, existing.assetId);
      const merged: TransactionRecord = {
        ...existing,
        side: patch.side ?? existing.side,
        quantity: patch.quantity ?? existing.quantity,
        price: patch.price ?? existing.price,
        fee: patch.fee ?? existing.fee,
        executedAt: patch.executedAt ? new Date(patch.executedAt) : existing.executedAt,
        note: patch.note === undefined ? existing.note : (patch.note ?? null),
      };
      const replayed = siblings.map((s) => (s.id === id ? merged : s)).map(recordToDomain);
      assertNoOversell(replayed);

      const updated = await transactionRepo.update(userId, id, {
        side: patch.side,
        quantity: patch.quantity,
        price: patch.price,
        fee: patch.fee,
        executedAt: patch.executedAt ? new Date(patch.executedAt) : undefined,
        note: patch.note === undefined ? undefined : (patch.note ?? null),
      });
      if (!updated) throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');

      await invalidateHistory(portfolioId);

      const [asset] = await portfolioRepo.assetsByIds([updated.assetId]);
      if (!asset) throw new Error(`Asset ${updated.assetId} missing after update`);
      return recordToDto(updated, asset);
    },

    async deleteTransaction(userId, portfolioId, id) {
      await requireOwnedPortfolio(userId, portfolioId);
      const existing = await transactionRepo.findByIdForUser(userId, id);
      if (!existing || existing.portfolioId !== portfolioId) {
        throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');
      }

      // Removing a BUY can leave a later SELL over-selling; replay without it.
      const siblings = await transactionRepo.listForAsset(existing.portfolioId, existing.assetId);
      const replayed = siblings.filter((s) => s.id !== id).map(recordToDomain);
      assertNoOversell(replayed);

      // Deleting a cash-linked buy/sell cascades away its cash movement (§14,
      // schema onDelete: 'cascade'). If a later withdrawal/purchase relied on
      // that cash, the *remaining* ledger would dip negative — and the solvency
      // gate replays the whole history, so from then on every cash write is
      // rejected. Enforce the no-negative invariant at the delete boundary too:
      // replay the ledger (per source, V3-P3) without this txn's linked
      // movement and refuse the delete if any point would go negative.
      const cashMovements = await cashMovementRepo.listForPortfolio(portfolioId);
      if (cashMovements.some((m) => m.transactionId === id)) {
        const remaining = cashMovements.filter((m) => m.transactionId !== id).map(toDomainMovement);
        try {
          projectCashLedgerBySource(remaining);
        } catch (err) {
          if (err instanceof InsufficientCashError) {
            throw badRequest(
              'Deleting this transaction would overdraw your cash balance on a later date. Add cash or remove the dependent movements first.',
              'CASH_LEDGER_WOULD_GO_NEGATIVE',
              { availableEur: err.balanceEur, shortfallEur: err.shortfallEur },
            );
          }
          throw err;
        }
      }

      const deleted = await transactionRepo.deleteForUser(userId, id);
      if (!deleted) throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');

      await invalidateHistory(portfolioId);
    },

    async getPortfolio(userId, portfolioId, opts) {
      await requireOwnedPortfolio(userId, portfolioId);
      const fx = fxFor(opts?.baseCurrency);
      // Cash is a first-class overview line (§14): loaded up-front so it shows
      // even for a portfolio that holds only cash (no transactions yet). The
      // ledger stores EUR; the overview reports it in the caller's base at the
      // current spot rate — the same moment the holdings are priced at.
      const cashValue = await cashInBase(await cashBalanceFor(portfolioId), fx);
      const empty: PortfolioResponse = {
        baseCurrency: fx.baseCurrency,
        holdings: [],
        totals: emptyTotals(cashValue),
      };

      const txns = await transactionRepo.listForPortfolio(portfolioId);
      if (txns.length === 0) return empty;

      const assetIds = [...new Set(txns.map((t) => t.assetId))];
      const assetsById = new Map((await portfolioRepo.assetsByIds(assetIds)).map((r) => [r.id, r]));

      // One quote per asset (coalesced), best-effort: a degraded provider yields
      // a null quote rather than failing the page (§6.3). For non-EUR assets we
      // also probe the spot FX rate; if it is unavailable, drop the quote so the
      // pure derivation never throws mid-conversion.
      const assetInputs: HoldingAssetInput[] = [];
      for (const assetId of assetIds) {
        const asset = assetsById.get(assetId);
        if (!asset) continue;
        let quote: HoldingAssetInput['quote'] = null;
        try {
          const cached = await marketData.getQuote({
            providerId: asset.providerId,
            providerRef: asset.providerRef,
          });
          quote = { price: cached.value.price, prevClose: cached.value.prevClose ?? null };
          if (asset.currency !== fx.baseCurrency) {
            // Throws if no spot rate is available → degrade to no quote.
            await fx.getRate(asset.currency, fx.baseCurrency);
          }
        } catch {
          quote = null;
        }
        assetInputs.push({ assetId, currency: asset.currency, quote });
      }

      const domainTxns = txns.map(recordToDomain);
      // The converter carries the caller's base (§5.4) — the pure domain never
      // learns where it came from.
      const holdings = await deriveHoldings(domainTxns, assetInputs, fx);

      const holdingDtos: HoldingDto[] = holdings.map((h) => {
        const asset = assetsById.get(h.assetId);
        if (!asset) throw new Error(`Asset ${h.assetId} missing while building holdings`);
        return {
          asset: assetToDto(asset),
          quantity: h.quantity,
          avgCost: h.avgCost,
          realizedPnl: h.realizedPnl,
          price: h.price,
          marketValueEur: h.marketValueEur,
          costBasisEur: h.costBasisEur,
          unrealizedPnlEur: h.unrealizedPnlEur,
          unrealizedPnlPct: h.unrealizedPnlPct,
          dayChangeEur: h.dayChangeEur,
          dayChangePct: h.dayChangePct,
        };
      });

      return {
        baseCurrency: fx.baseCurrency,
        holdings: holdingDtos,
        totals: computeTotals(holdings, cashValue),
      };
    },

    async getCashMovements(userId, portfolioId) {
      await requireOwnedPortfolio(userId, portfolioId);
      // Materialise Main so even an untouched portfolio answers with its
      // default source (V3-P3) — mirrors listPortfolios' behavior.
      await cashSourceRepo.getOrCreateMain(portfolioId);
      const [{ records, balanceBySource, totalEur }, sources] = await Promise.all([
        loadCashState(portfolioId),
        // Archived sources are included here so every historical movement can
        // resolve its source's name; active listings use listCashSources.
        cashSourceRepo.listForPortfolio(portfolioId, { includeArchived: true }),
      ]);
      return {
        balanceEur: totalEur,
        movements: records.map(movementToDto),
        sources: sources.map((s) => sourceToDto(s, balanceBySource.get(s.id) ?? 0)),
      };
    },

    async listCashSources(userId, portfolioId, opts) {
      await requireOwnedPortfolio(userId, portfolioId);
      await cashSourceRepo.getOrCreateMain(portfolioId);
      const [{ balanceBySource }, sources] = await Promise.all([
        loadCashState(portfolioId),
        cashSourceRepo.listForPortfolio(portfolioId, {
          includeArchived: opts?.includeArchived ?? false,
        }),
      ]);
      return { sources: sources.map((s) => sourceToDto(s, balanceBySource.get(s.id) ?? 0)) };
    },

    async createCashSource(userId, portfolioId, input) {
      await requireOwnedPortfolio(userId, portfolioId);
      // Materialise Main first so it exists before any sibling and its name is
      // reserved — a sibling can then never squat "Main" ahead of provisioning.
      await cashSourceRepo.getOrCreateMain(portfolioId);
      const name = input.name.trim();
      // Reject a duplicate name up-front (the unique index spans archived rows)
      // with a clean 409 rather than surfacing a raw DB constraint error.
      if (await cashSourceRepo.nameExists(portfolioId, name)) {
        throw conflict('A cash source with that name already exists.', 'CASH_SOURCE_NAME_TAKEN');
      }
      const source = await cashSourceRepo.createSource(portfolioId, { name, type: input.type });
      return sourceToDto(source, 0);
    },

    async updateCashSource(userId, portfolioId, sourceId, patch) {
      await requireOwnedPortfolio(userId, portfolioId);
      const before = await requireSource(portfolioId, sourceId);
      const name = patch.name?.trim();
      if (name !== undefined && name !== before.name) {
        if (await cashSourceRepo.nameExists(portfolioId, name, sourceId)) {
          throw conflict('A cash source with that name already exists.', 'CASH_SOURCE_NAME_TAKEN');
        }
      }
      const updated = await cashSourceRepo.updateSource(portfolioId, sourceId, {
        name,
        type: patch.type,
      });
      if (!updated) throw notFound('Cash source not found.', 'CASH_SOURCE_NOT_FOUND');
      const { balanceBySource } = await loadCashState(portfolioId);
      return sourceToDto(updated, balanceBySource.get(sourceId) ?? 0);
    },

    async archiveCashSource(userId, portfolioId, sourceId) {
      await requireOwnedPortfolio(userId, portfolioId);
      const source = await requireSource(portfolioId, sourceId);
      // Main is the guaranteed default target of every cash flow — never
      // archivable (owner decision, PR for §16): there is always exactly one
      // active Main per portfolio.
      if (source.isMain) {
        throw badRequest('The Main cash source cannot be archived.', 'CASH_SOURCE_IS_MAIN');
      }
      if (source.archivedAt) {
        throw badRequest('Cash source is already archived.', 'CASH_SOURCE_ALREADY_ARCHIVED');
      }
      // Only an exactly-€0.00 source may be archived (owner decision, PR for
      // §16): archived sources leave the active listings, and a hidden source
      // must never hide money — the roll-ups would show cash "from nowhere".
      const { balanceBySource } = await loadCashState(portfolioId);
      const balanceEur = balanceBySource.get(sourceId) ?? 0;
      if (balanceEur !== 0) {
        throw badRequest(
          'Only a cash source with a balance of exactly €0.00 can be archived. Transfer or withdraw the remaining balance first.',
          'CASH_SOURCE_NOT_EMPTY',
          { balanceEur },
        );
      }
      const archived = await cashSourceRepo.archiveSource(portfolioId, sourceId, new Date(now()));
      // Concurrent archive raced us to null → treat as already archived.
      if (!archived) {
        throw badRequest('Cash source is already archived.', 'CASH_SOURCE_ALREADY_ARCHIVED');
      }
      return sourceToDto(archived, 0);
    },

    async restoreCashSource(userId, portfolioId, sourceId) {
      await requireOwnedPortfolio(userId, portfolioId);
      const source = await requireSource(portfolioId, sourceId);
      if (!source.archivedAt) {
        throw badRequest('Cash source is not archived.', 'CASH_SOURCE_NOT_ARCHIVED');
      }
      const restored = await cashSourceRepo.restoreSource(portfolioId, sourceId);
      if (!restored) throw notFound('Cash source not found.', 'CASH_SOURCE_NOT_FOUND');
      const { balanceBySource } = await loadCashState(portfolioId);
      return sourceToDto(restored, balanceBySource.get(sourceId) ?? 0);
    },

    async transferCash(userId, portfolioId, input) {
      await requireOwnedPortfolio(userId, portfolioId);
      if (input.fromSourceId === input.toSourceId) {
        throw badRequest(
          'A transfer needs two different cash sources.',
          'CASH_TRANSFER_SAME_SOURCE',
        );
      }
      // Both endpoints must be active sources of THIS portfolio: archived ones
      // accept no new movements, and a foreign source id is a 404.
      const [from, to] = await Promise.all([
        resolveFlowSource(portfolioId, input.fromSourceId),
        resolveFlowSource(portfolioId, input.toSourceId),
      ]);
      const executedAt = input.executedAt ? new Date(input.executedAt) : new Date(now());
      // The pure builder quantizes the magnitude to cents (#322) and mirrors it
      // into the two double-entry legs sharing one timestamp.
      let legs: CashTransferLegs;
      try {
        legs = pairedTransferMovements({
          fromSourceId: from.id,
          toSourceId: to.id,
          amountEur: input.amountEur,
          occurredAt: executedAt.toISOString(),
        });
      } catch (err) {
        if (err instanceof CashLedgerError) {
          throw badRequest(err.message, 'CASH_TRANSFER_INVALID');
        }
        throw err;
      }
      // No overdraw of the from-source at any point once the (possibly
      // back-dated) pair is replayed — checked per source over both legs.
      const existing = await cashMovementRepo.listForPortfolio(portfolioId);
      assertCashSolvent(existing, [legs.outgoing, legs.incoming]);

      // One shared transferId pairs the legs; each leg names the other side
      // for display. Written atomically — neither leg can persist alone.
      const transferId = newId();
      const note = input.note ?? null;
      const [outgoing, incoming] = await cashMovementRepo.insertTransferPair(portfolioId, [
        {
          sourceId: from.id,
          kind: 'transfer_out',
          amountEur: legs.outgoing.amountEur,
          executedAt,
          note,
          transferId,
          counterpartSourceId: to.id,
        },
        {
          sourceId: to.id,
          kind: 'transfer_in',
          amountEur: legs.incoming.amountEur,
          executedAt,
          note,
          transferId,
          counterpartSourceId: from.id,
        },
      ]);
      // The paired legs cancel in the net-worth curve and are never TWR flows,
      // so the cached series is provably identical — invalidate anyway to keep
      // the blanket "every cash write invalidates" rule simple and true.
      await invalidateHistory(portfolioId);
      const { balanceBySource, totalEur } = await loadCashState(portfolioId);
      return {
        outgoing: movementToDto(outgoing),
        incoming: movementToDto(incoming),
        fromBalanceEur: balanceBySource.get(from.id) ?? 0,
        toBalanceEur: balanceBySource.get(to.id) ?? 0,
        balanceEur: totalEur,
      };
    },

    async setCashBalance(userId, portfolioId, sourceId, input) {
      await requireOwnedPortfolio(userId, portfolioId);
      const source = await resolveFlowSource(portfolioId, sourceId);
      const existing = await cashMovementRepo.listForPortfolio(portfolioId);
      const currentEur = roundCents(
        cashBalance(existing.filter((m) => m.sourceId === source.id).map(toDomainMovement)),
      );
      // §16 (2026-07-07): the app computes the signed delta itself and records
      // it as a NORMAL deposit/withdrawal movement — audit trail intact, and
      // TWR-wise an external flow exactly like a hand-entered one. Always
      // effective now: "set balance to X" reconciles the present, not the past.
      const domainMovement = setBalanceMovement({
        sourceId: source.id,
        currentBalanceEur: currentEur,
        targetBalanceEur: input.balanceEur,
        occurredAt: new Date(now()).toISOString(),
      });
      if (!domainMovement) {
        // Already at the target — a no-op records nothing (nothing happened).
        return {
          movement: null,
          deltaEur: 0,
          sourceBalanceEur: currentEur,
          balanceEur: await cashBalanceFor(portfolioId),
        };
      }
      // A negative delta is a withdrawal: guard future-dated movements that
      // relied on the removed cash (per-source replay, no silent negatives).
      if (domainMovement.amountEur < 0) {
        assertCashSolvent(existing, [domainMovement]);
      }
      const movement = await cashMovementRepo.insert(portfolioId, {
        sourceId: source.id,
        kind: domainMovement.kind,
        amountEur: domainMovement.amountEur,
        executedAt: new Date(domainMovement.occurredAt),
        note: input.note ?? null,
      });
      // Cash is part of the net-worth curve (#311) — drop the cached series.
      await invalidateHistory(portfolioId);
      const { balanceBySource, totalEur } = await loadCashState(portfolioId);
      return {
        movement: movementToDto(movement),
        deltaEur: domainMovement.amountEur,
        sourceBalanceEur: balanceBySource.get(source.id) ?? 0,
        balanceEur: totalEur,
      };
    },

    async depositCash(userId, portfolioId, input) {
      await requireOwnedPortfolio(userId, portfolioId);
      const source = await resolveFlowSource(portfolioId, input.sourceId);
      // A deposit only ever raises the balance, so it needs no solvency gate.
      const executedAt = input.executedAt ? new Date(input.executedAt) : new Date(now());
      // Cash is whole-cent money — quantize the entered amount to cents (#322).
      const movement = await cashMovementRepo.insert(portfolioId, {
        sourceId: source.id,
        kind: 'deposit',
        amountEur: roundCents(input.amountEur),
        executedAt,
        note: input.note ?? null,
      });
      // Cash is part of the net-worth curve (#311) — drop the cached series.
      await invalidateHistory(portfolioId);
      const { balanceBySource, totalEur } = await loadCashState(portfolioId);
      return {
        movement: movementToDto(movement),
        sourceBalanceEur: balanceBySource.get(source.id) ?? 0,
        balanceEur: totalEur,
      };
    },

    async withdrawCash(userId, portfolioId, input) {
      await requireOwnedPortfolio(userId, portfolioId);
      const source = await resolveFlowSource(portfolioId, input.sourceId);
      const executedAt = input.executedAt ? new Date(input.executedAt) : new Date(now());
      // Cash is whole-cent money — quantize the entered amount to cents (#322),
      // so a withdraw-all (the cent-exact reported balance) cancels the ledger
      // to exactly €0.00 rather than stranding sub-cent residue.
      const amountEur = roundCents(input.amountEur);
      const existing = await cashMovementRepo.listForPortfolio(portfolioId);
      // Guard against an overdraw of THIS source at *any* point once this
      // (possibly back-dated) withdrawal is replayed — no silent negatives.
      assertCashSolvent(existing, [
        {
          kind: 'withdrawal',
          amountEur: -amountEur,
          occurredAt: executedAt.toISOString(),
          sourceId: source.id,
        },
      ]);
      const movement = await cashMovementRepo.insert(portfolioId, {
        sourceId: source.id,
        kind: 'withdrawal',
        amountEur: -amountEur,
        executedAt,
        note: input.note ?? null,
      });
      // Cash is part of the net-worth curve (#311) — drop the cached series.
      await invalidateHistory(portfolioId);
      const { balanceBySource, totalEur } = await loadCashState(portfolioId);
      return {
        movement: movementToDto(movement),
        sourceBalanceEur: balanceBySource.get(source.id) ?? 0,
        balanceEur: totalEur,
      };
    },

    async previewCash(userId, portfolioId, input) {
      await requireOwnedPortfolio(userId, portfolioId);
      // Solvency is per source (V3-P3): preview against the chosen source's
      // balance (Main when omitted), mirroring what the write path enforces.
      const source = await resolveFlowSource(portfolioId, input.sourceId);
      const { balanceBySource } = await loadCashState(portfolioId);
      const availableEur = balanceBySource.get(source.id) ?? 0;
      // Quantize the proposed amount to cents to mirror what the write path will
      // actually record (#322), so the "available → after" preview matches the
      // balance the user will land on — a withdraw-all previews exactly €0.00.
      const afterEur = roundCents(
        availableEur + roundCents(input.amountEur) * CASH_MOVEMENT_SIGN[input.kind],
      );
      const sufficient = afterEur >= -CASH_EPSILON;
      return {
        availableEur,
        afterEur,
        sufficient,
        shortfallEur: sufficient ? 0 : -afterEur,
      };
    },

    async getHistory(userId, portfolioId, range, opts) {
      // Ownership is enforced against the scoped id (§6.8): another user's — or a
      // missing — portfolio is a 404, not a silent fall-back to the default.
      await requireOwnedPortfolio(userId, portfolioId);
      const overlay = opts?.overlay ?? false;
      const fx = fxFor(opts?.baseCurrency);

      const today = todayIso();
      const payload = await loadSeries(portfolioId);
      // Re-denominate the cached EUR ingredients into the caller's base with
      // per-day historical rates (identity for EUR), THEN derive the TWR — a
      // USD user's performance includes the FX leg of holding EUR-priced
      // assets, exactly as their real USD-terms return does (V3-P10d).
      const series = await seriesInBase(payload, fx);
      const points = sliceRange(series.points, range, today);
      // The performance curve is cumulative since inception. MAX serves it
      // unchanged: the domain index is anchored at 1 (0 %) *before* day one,
      // so day one's execution→close move (and its fee drag) is genuine
      // since-inception return — re-basing to the first plotted point would
      // divide it out of every response. A range slice (1M/6M/1Y/5Y) IS
      // re-based to 0 % at the window start (#125): it shows the TWR of that
      // window, not an arbitrary offset. Compounding, not subtraction.
      const perfSlice = sliceRange(timeWeightedReturn(series.points, series.flows), range, today);
      const performance = range === 'MAX' ? perfSlice : rebasePerformance(perfSlice);
      if (!overlay) return { range, baseCurrency: fx.baseCurrency, points, performance };

      // Overlays share the curve's daily grid, so the same range slice keeps
      // them point-for-point aligned. An asset whose data lies entirely outside
      // the window is dropped rather than sent as an empty series.
      const assets = payload.assets
        .map((a) => ({ ...a, points: sliceRange(a.points, range, today) }))
        .filter((a) => a.points.length > 0);
      return { range, baseCurrency: fx.baseCurrency, points, performance, assets };
    },

    invalidateHistory,
  };
}

// ---------------------------------------------------------------------------
// Totals + range helpers
// ---------------------------------------------------------------------------

function emptyTotals(cashEur = 0): PortfolioTotals {
  return {
    marketValueEur: 0,
    investedEur: 0,
    unrealizedPnlEur: 0,
    unrealizedPnlPct: null,
    dayChangeEur: 0,
    dayChangePct: null,
    cashEur,
    totalValueEur: cashEur,
  };
}

/** Aggregate the holdings into the totals header (§6.9), plus the cash line (§14). */
function computeTotals(holdings: readonly Holding[], cashEur: number): PortfolioTotals {
  let marketValueEur = 0;
  let investedEur = 0;
  let dayChangeEur = 0;
  let dayPrevValueEur = 0; // Σ (marketValue − dayChange) over assets with a known day move.

  for (const h of holdings) {
    if (h.marketValueEur !== null) marketValueEur += h.marketValueEur;
    if (h.costBasisEur !== null) investedEur += h.costBasisEur;
    if (h.dayChangeEur !== null && h.marketValueEur !== null) {
      dayChangeEur += h.dayChangeEur;
      dayPrevValueEur += h.marketValueEur - h.dayChangeEur;
    }
  }

  const unrealizedPnlEur = marketValueEur - investedEur;
  return {
    marketValueEur,
    investedEur,
    unrealizedPnlEur,
    unrealizedPnlPct: investedEur > 0 ? (unrealizedPnlEur / investedEur) * 100 : null,
    dayChangeEur,
    dayChangePct: dayPrevValueEur > 0 ? (dayChangeEur / dayPrevValueEur) * 100 : null,
    cashEur,
    // The headline number (#311): net worth = holdings value + cash. A deposit
    // raises it by exactly its amount; a cash-funded buy leaves it unchanged.
    totalValueEur: marketValueEur + cashEur,
  };
}

/**
 * Calendar day `months` before `today` (ISO `YYYY-MM-DD`), UTC. When the target
 * month is shorter than `today`'s day-of-month, clamps to the target month's
 * last day — a naive `setUTCMonth` would roll over (Mar 31 − 1M → Mar 3) and
 * silently shorten the 1M/6M chart windows (issue #218).
 *
 * Exported for unit tests only.
 */
export function monthsBefore(today: string, months: number): string {
  const d = new Date(`${today}T00:00:00.000Z`);
  const dayOfMonth = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return d.toISOString().slice(0, 10);
}

/**
 * Left-edge margin when picking the provider history window: the series starts
 * at the first transaction day, which may be a weekend/market holiday, so the
 * window must reach back far enough that a prior close exists to carry forward.
 */
const SERIES_EDGE_MARGIN_DAYS = 7;

const SERIES_RANGE_LADDER: ReadonlyArray<Exclude<HistoryRange, '1D' | '1W' | 'MAX'>> = [
  '1M',
  '6M',
  '1Y',
  '5Y',
];

/**
 * Smallest §5.3 range preset whose lookback (per {@link rangeStartMs}) covers
 * the first transaction day plus {@link SERIES_EDGE_MARGIN_DAYS}. The interval
 * is always `1d` — the value series is daily regardless of span.
 */
function seriesHistoryRange(firstTxnDay: string, today: string): HistoryRange {
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  const neededMs =
    Date.parse(`${firstTxnDay}T00:00:00.000Z`) - SERIES_EDGE_MARGIN_DAYS * 86_400_000;
  for (const range of SERIES_RANGE_LADDER) {
    if (rangeStartMs(todayMs, range) <= neededMs) return range;
  }
  return 'MAX';
}

/**
 * Combine an asset's stored `price_history` rows with its provider history into
 * one daily series for {@link valueOverTime}. Provider candles collapse to one
 * close per calendar day (chronological order upstream, so the last candle of a
 * day wins) and take precedence over a stored row on the same date — they are
 * adjusted and fresher; stored rows fill dates the provider window missed and
 * carry the whole asset when the provider call failed.
 */
function mergeDailyPrices(
  stored: readonly PricePoint[],
  provider: readonly ProviderPricePoint[],
): PricePoint[] {
  const byDate = new Map<string, number>();
  for (const p of stored) byDate.set(p.date, p.close);
  for (const p of provider) {
    if (!Number.isFinite(p.close)) continue;
    byDate.set(p.time.slice(0, 10), p.close);
  }
  return [...byDate].map(([date, close]) => ({ date, close }));
}

/**
 * Slice a full daily series to a range window; MAX returns it whole (§6.9).
 * Generic over the point shape so the portfolio curve (`valueEur`) and the
 * overlay series (`close`) share one slicing rule and stay date-aligned.
 */
function sliceRange<P extends { date: string }>(
  series: readonly P[],
  range: PortfolioHistoryRange,
  today: string,
): P[] {
  if (range === 'MAX') return [...series];
  const cutoff = monthsBefore(today, RANGE_MONTHS[range]);
  return series.filter((p) => p.date >= cutoff);
}

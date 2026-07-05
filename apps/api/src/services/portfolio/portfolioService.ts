import type {
  CashEntryRequest,
  CashMovement as CashMovementDto,
  CashMovementResponse,
  CashMovementsResponse,
  CashPreviewRequest,
  CashPreviewResponse,
  CreatePortfolioRequest,
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
import type {
  CashMovementRecord,
  CashMovementRepository,
} from '../../data/repositories/cashMovementRepository';
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
  InsufficientCashError,
  projectCashLedger,
  type CashMovement as DomainCashMovement,
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
  type Holding,
  type HoldingAssetInput,
  type PricePoint,
  type Transaction as DomainTransaction,
  type ValueOverTimeAsset,
} from '../../domain/holdings';
import { badRequest, conflict, notFound } from '../../errors';
import type { EventBus } from '../../events';
import type { Logger } from '../../logger';
import { rangeStartMs, type MarketDataService } from '../../providers';
import type { ReferenceBackfill } from '../assets/referenceBackfill';
import type { CurrencyService } from '../currency/currencyService';

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
  getPortfolio(userId: string, portfolioId: string): Promise<PortfolioResponse>;
  /** The portfolio's cash movements + current balance (§14, #220). */
  getCashMovements(userId: string, portfolioId: string): Promise<CashMovementsResponse>;
  /** Record an external cash deposit (§14). */
  depositCash(
    userId: string,
    portfolioId: string,
    input: CashEntryRequest,
  ): Promise<CashMovementResponse>;
  /** Record an external cash withdrawal; rejects an overdraw (§14, no silent negatives). */
  withdrawCash(
    userId: string,
    portfolioId: string,
    input: CashEntryRequest,
  ): Promise<CashMovementResponse>;
  /** Live "available → after" preview for a proposed cash movement (§14). */
  previewCash(
    userId: string,
    portfolioId: string,
    input: CashPreviewRequest,
  ): Promise<CashPreviewResponse>;
  getHistory(
    userId: string,
    portfolioId: string,
    range: PortfolioHistoryRange,
    opts?: { overlay?: boolean },
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
 * Versioned (`v3`): the cached shape changed with #125 (the performance/TWR
 * series joined the payload; `v2` added the #122 overlay series), and bumping
 * the version also wholesale-invalidates every series a *previous* deployment
 * computed. The 1 h TTL is only refreshed by writes, so without the bump a
 * pre-deploy entry — possibly computed by older, buggier code — would keep
 * being served for up to an hour after a fix ships (exactly the stale
 * single-point graph reported in #122).
 */
export function portfolioHistoryCacheKey(portfolioId: string): string {
  return `portfolio:history:v3:${portfolioId}`;
}

/** The full cached graph payload: EUR value curve + TWR performance curve + per-asset overlay series. */
interface HistoryPayload {
  points: Array<{ date: string; valueEur: number }>;
  performance: PortfolioPerformancePoint[];
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

  // --- Cash ledger (§14, #220) ---------------------------------------------

  /** Map a stored cash-movement row into the pure-domain movement shape. */
  function toDomainMovement(r: CashMovementRecord): DomainCashMovement {
    return { kind: r.kind, amountEur: r.amountEur, occurredAt: r.executedAt.toISOString() };
  }

  function movementToDto(r: CashMovementRecord): CashMovementDto {
    return {
      id: r.id,
      kind: r.kind,
      amountEur: r.amountEur,
      transactionId: r.transactionId,
      executedAt: r.executedAt.toISOString(),
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Current EUR cash balance = sum of signed movements (§14 reconciliation invariant). */
  async function cashBalanceFor(portfolioId: string): Promise<number> {
    const records = await cashMovementRepo.listForPortfolio(portfolioId);
    return cashBalance(records.map(toDomainMovement));
  }

  /**
   * Replay the existing ledger with the proposed movements appended and reject
   * (400 `INSUFFICIENT_CASH`) if any point would dip negative — the single
   * no-silent-negative gate, driven entirely by `domain/cashLedger`.
   */
  function assertCashSolvent(
    existing: readonly CashMovementRecord[],
    proposed: readonly DomainCashMovement[],
  ): void {
    try {
      projectCashLedger([...existing.map(toDomainMovement), ...proposed]);
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

  /** Convert a native-currency amount to EUR at the movement date, or 400 if no FX. */
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

  /**
   * Build the linked cash movement for a cash-flagged buy/sell (§14), or null
   * when the flag is off or the net EUR amount rounds to nothing. A buy funded
   * from cash books an internal `buy` (cash↓, TWR-neutral) for its total cost
   * (quantity·price + fee); a sell adds `sell_proceeds` (cash↑) for its net
   * proceeds (quantity·price − fee). A flag that contradicts the side is a 400.
   */
  async function buildCashLink(
    input: TransactionInput,
    asset: AssetRow,
  ): Promise<LinkedCashMovement | null> {
    if (input.payFromCash && input.side !== 'buy') {
      throw badRequest('"Pay from cash" applies only to buys.', 'CASH_FLAG_MISMATCH');
    }
    if (input.addProceedsToCash && input.side !== 'sell') {
      throw badRequest('"Add proceeds to cash" applies only to sells.', 'CASH_FLAG_MISMATCH');
    }
    const day = new Date(input.executedAt).toISOString().slice(0, 10);

    if (input.payFromCash && input.side === 'buy') {
      const costEur = await toCashEur(
        input.quantity * input.price + input.fee,
        asset.currency,
        day,
      );
      if (costEur <= CASH_EPSILON) return null;
      return { kind: 'buy', amountEur: -costEur, note: 'Paid from cash balance' };
    }
    if (input.addProceedsToCash && input.side === 'sell') {
      const proceedsEur = await toCashEur(
        input.quantity * input.price - input.fee,
        asset.currency,
        day,
      );
      if (proceedsEur <= CASH_EPSILON) return null;
      return {
        kind: 'sell_proceeds',
        amountEur: proceedsEur,
        note: 'Proceeds added to cash balance',
      };
    }
    return null;
  }

  /** The empty graph payload (no transactions / nothing convertible to plot). */
  const emptyHistory = (): HistoryPayload => ({ points: [], performance: [], assets: [] });

  /**
   * The full value-over-time payload for a portfolio (first transaction →
   * today), cached 1 h: the EUR value curve plus each held asset's own daily
   * price series (the #122 overlay). Recomputed on a cache miss and re-stored;
   * the range slice is applied by the caller. Invalidated wholesale on any
   * write (§6.9), so a back-dated transaction reshapes the history immediately.
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
          Array.isArray(parsed.performance) &&
          Array.isArray(parsed.assets)
        ) {
          return parsed;
        }
      } catch {
        // Corrupt cache entry — fall through and recompute.
      }
    }

    const txns = await transactionRepo.listForPortfolio(portfolioId);
    if (txns.length === 0) {
      const empty = emptyHistory();
      await redis.set(key, JSON.stringify(empty), 'EX', HISTORY_TTL_SECONDS);
      return empty;
    }

    const assetIds = [...new Set(txns.map((t) => t.assetId))];
    const assetsById = new Map((await portfolioRepo.assetsByIds(assetIds)).map((r) => [r.id, r]));

    // The value series converts each day's native sum to EUR via *historical* FX,
    // which is not yet available for non-base currencies (§5.4 future work). Rather
    // than 500 on a non-EUR holding (e.g. a USD custom asset or market stock), we
    // degrade exactly like getPortfolio drops an unconvertible quote: probe each
    // distinct non-base currency once and exclude assets we can't convert from the
    // series. When historical FX lands this path starts including them automatically.
    const today = todayIso();
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

    // No EUR-convertible holding has any history to plot — degrade to an empty
    // series instead of throwing mid-conversion.
    if (usableAssetIds.length === 0) {
      const empty = emptyHistory();
      await redis.set(key, JSON.stringify(empty), 'EX', HISTORY_TTL_SECONDS);
      return empty;
    }

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

    const usableTxns = txns.filter((t) => usableIdSet.has(t.assetId)).map(recordToDomain);
    const points = await valueOverTime({
      transactions: usableTxns,
      assets: valueAssets,
      today,
      converter: currencyService,
    });

    // Performance mode (#125): the same value curve with deposits/withdrawals
    // neutralized — daily time-weighted return, chain-linked. Flows reuse the
    // exact transaction set and currencies the value curve was built from, so
    // both series describe the same portfolio slice.
    //
    // NOTE (§14, #220 cash ledger — deliberately deferred here): this curve is
    // still built purely from transactions and does not yet fold the EUR cash
    // balance into the value series or swap transaction flows for
    // `domain/cashLedger.externalCashFlowsForTwr`. The classifier already
    // guarantees a cash-funded buy is internal (not an external flow) — see the
    // #278 tests — but wiring cash into the *value curve* so a cash→stock
    // conversion is genuinely value-neutral is a money-math series rework that
    // belongs in `domain/` (fable, per the #278 scope: "flag and split rather
    // than writing money-math in the service"). Tracked as follow-up fable work.
    const flows = await netFlowsOverTime({
      transactions: usableTxns,
      currencyByAsset: new Map(valueAssets.map((a) => [a.assetId, a.currency])),
      converter: currencyService,
    });
    const performance = timeWeightedReturn(points, flows);

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

    const payload: HistoryPayload = { points, performance, assets: overlays };
    await redis.set(key, JSON.stringify(payload), 'EX', HISTORY_TTL_SECONDS);
    return payload;
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

      // Cash-ledger linkage (§14, #220): resolve each cash-flagged buy/sell into
      // a linked EUR movement, then reject up-front if the batch — replayed over
      // the existing ledger — would ever overdraw (no silent negative balances).
      // The transactions and their movements are then written atomically.
      const cashLinks = await Promise.all(
        inputs.map((input) => {
          if (!input.payFromCash && !input.addProceedsToCash) return null;
          const asset = assetsById.get(input.assetId);
          if (!asset) throw new Error(`Asset ${input.assetId} missing while linking cash`);
          return buildCashLink(input, asset);
        }),
      );
      if (cashLinks.some((link) => link)) {
        const existing = await cashMovementRepo.listForPortfolio(portfolioId);
        const proposed: DomainCashMovement[] = cashLinks
          .map((link, i): DomainCashMovement | null =>
            link
              ? {
                  kind: link.kind,
                  amountEur: link.amountEur,
                  occurredAt: new Date(inputs[i]!.executedAt).toISOString(),
                }
              : null,
          )
          .filter((m): m is DomainCashMovement => m !== null);
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

      const deleted = await transactionRepo.deleteForUser(userId, id);
      if (!deleted) throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');

      await invalidateHistory(portfolioId);
    },

    async getPortfolio(userId, portfolioId) {
      await requireOwnedPortfolio(userId, portfolioId);
      // Cash is a first-class overview line (§14): loaded up-front so it shows
      // even for a portfolio that holds only cash (no transactions yet).
      const cashEur = await cashBalanceFor(portfolioId);
      const empty: PortfolioResponse = {
        baseCurrency,
        holdings: [],
        totals: emptyTotals(cashEur),
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
          if (asset.currency !== baseCurrency) {
            // Throws if no spot rate is available → degrade to no quote.
            await currencyService.getRate(asset.currency, baseCurrency);
          }
        } catch {
          quote = null;
        }
        assetInputs.push({ assetId, currency: asset.currency, quote });
      }

      const domainTxns = txns.map(recordToDomain);
      const holdings = await deriveHoldings(domainTxns, assetInputs, currencyService);

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

      return { baseCurrency, holdings: holdingDtos, totals: computeTotals(holdings, cashEur) };
    },

    async getCashMovements(userId, portfolioId) {
      await requireOwnedPortfolio(userId, portfolioId);
      const records = await cashMovementRepo.listForPortfolio(portfolioId);
      return {
        balanceEur: cashBalance(records.map(toDomainMovement)),
        movements: records.map(movementToDto),
      };
    },

    async depositCash(userId, portfolioId, input) {
      await requireOwnedPortfolio(userId, portfolioId);
      // A deposit only ever raises the balance, so it needs no solvency gate.
      const executedAt = input.executedAt ? new Date(input.executedAt) : new Date(now());
      const movement = await cashMovementRepo.insert(portfolioId, {
        kind: 'deposit',
        amountEur: input.amountEur,
        executedAt,
        note: input.note ?? null,
      });
      return { movement: movementToDto(movement), balanceEur: await cashBalanceFor(portfolioId) };
    },

    async withdrawCash(userId, portfolioId, input) {
      await requireOwnedPortfolio(userId, portfolioId);
      const executedAt = input.executedAt ? new Date(input.executedAt) : new Date(now());
      const existing = await cashMovementRepo.listForPortfolio(portfolioId);
      // Guard against an overdraw at *any* point once this (possibly back-dated)
      // withdrawal is replayed into the ledger — no silent negative balance.
      assertCashSolvent(existing, [
        { kind: 'withdrawal', amountEur: -input.amountEur, occurredAt: executedAt.toISOString() },
      ]);
      const movement = await cashMovementRepo.insert(portfolioId, {
        kind: 'withdrawal',
        amountEur: -input.amountEur,
        executedAt,
        note: input.note ?? null,
      });
      return { movement: movementToDto(movement), balanceEur: await cashBalanceFor(portfolioId) };
    },

    async previewCash(userId, portfolioId, input) {
      await requireOwnedPortfolio(userId, portfolioId);
      const availableEur = await cashBalanceFor(portfolioId);
      // Signed by kind (deposit/sell_proceeds add, withdrawal/buy subtract), then
      // report the resulting balance — never applied, so an overdraw surfaces as
      // `sufficient: false` for the "available → after" preview rather than error.
      const afterEur = availableEur + input.amountEur * CASH_MOVEMENT_SIGN[input.kind];
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

      const today = todayIso();
      const payload = await loadSeries(portfolioId);
      const points = sliceRange(payload.points, range, today);
      // The performance curve is cumulative since inception. MAX serves it
      // unchanged: the domain index is anchored at 1 (0 %) *before* day one,
      // so day one's execution→close move (and its fee drag) is genuine
      // since-inception return — re-basing to the first plotted point would
      // divide it out of every response. A range slice (1M/6M/1Y/5Y) IS
      // re-based to 0 % at the window start (#125): it shows the TWR of that
      // window, not an arbitrary offset. Compounding, not subtraction.
      const perfSlice = sliceRange(payload.performance, range, today);
      const performance = range === 'MAX' ? perfSlice : rebasePerformance(perfSlice);
      if (!overlay) return { range, baseCurrency, points, performance };

      // Overlays share the curve's daily grid, so the same range slice keeps
      // them point-for-point aligned. An asset whose data lies entirely outside
      // the window is dropped rather than sent as an empty series.
      const assets = payload.assets
        .map((a) => ({ ...a, points: sliceRange(a.points, range, today) }))
        .filter((a) => a.points.length > 0);
      return { range, baseCurrency, points, performance, assets };
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

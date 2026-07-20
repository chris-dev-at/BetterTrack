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
  PortfolioAsset,
  PortfolioHistoryOverlay,
  PortfolioHistoryPoint,
  PortfolioHistoryRange,
  PortfolioPerformancePoint,
  PortfolioListResponse,
  PortfolioResponse,
  PortfolioSummary,
  PortfolioTotals,
  TransactionInput,
  TransactionListResponse,
  Transaction as TransactionDto,
  UpdatePortfolioRequest,
  UpdateTransactionRequest,
} from '@bettertrack/contracts';
import { customAssetCategorySchema } from '@bettertrack/contracts';

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
import type { ProfileRepository } from '../../data/repositories/profileRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
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
  InsufficientCashError,
  pairedTransferMovements,
  projectCashLedgerBySource,
  floorCents,
  setBalanceMovement,
  spendableAsOf,
  type CashTransferLegs,
  type SourcedCashMovement,
} from '../../domain/cashLedger';
import {
  deriveHoldings,
  OversellError,
  rebasePerformance,
  reducePosition,
  timeWeightedReturn,
  type FlowPoint,
  type Holding,
  type HoldingAssetInput,
  type Transaction as DomainTransaction,
} from '../../domain/holdings';
import { badRequest, conflict, notFound, unprocessable } from '../../errors';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import type { ReferenceBackfill } from '../assets/referenceBackfill';
import { FxRateUnavailableError, type CurrencyService } from '../currency/currencyService';
import type { LiveRingBuffer } from '../liveMode';
import type { NotificationCenter } from '../notifications/notificationCenter';
import type { AudienceService } from '../social/audienceService';
import type { TaxService } from '../tax/taxService';
import {
  buildIntradayEurValuePoints,
  densifiedFetchRange,
  densifiedIntervalFor,
  intradayPerformancePoints,
  isDensifiedRange,
  type DensifiedPortfolioRange,
  type IntradayCandle,
  type IntradayValuePoint,
} from './portfolioIntraday';
import type { PortfolioSnapshotService } from './portfolioSnapshots';

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
 *  - **The value series is served from the V5-P1 daily snapshot table** (issue
 *    #553): historical days come precomputed from `portfolio_daily_snapshots`
 *    via the {@link PortfolioSnapshotService}, the "today" point is always
 *    computed fresh from live quotes, and every history-mutating write below
 *    invalidates from its exact earliest affected day (§16 2026-07-17).
 */

export interface PortfolioServiceDeps {
  portfolioRepo: PortfolioRepository;
  transactionRepo: TransactionRepository;
  cashMovementRepo: CashMovementRepository;
  cashSourceRepo: CashSourceRepository;
  marketData: MarketDataService;
  currencyService: CurrencyService;
  referenceBackfill: ReferenceBackfill;
  /**
   * The V5-P1 snapshot layer (issue #553): serves the historical series from
   * precomputed daily rows (fresh "today" appended) and owns the day-precise
   * invalidation every write path below reports into.
   */
  snapshots: PortfolioSnapshotService;
  /**
   * Tax engine (V3-P4): plans the per-sell tax facts + settlement movements a
   * transaction write must carry, and the year corrections a delete posts.
   */
  taxService: TaxService;
  /** Social graph — used to resolve the owner's friends when a portfolio is shared (§6.10). */
  friendshipRepo: FriendshipRepository;
  /**
   * The sharing-enforcement layer (§13.3 V3-P5): on hard-delete, its
   * `clearForSubject` drops the portfolio's polymorphic audience row (and the
   * cascade — members + public links), which carries no FK to the portfolio.
   * Also the per-viewer authorization gate for friend-activity emits (#368).
   */
  audience: AudienceService;
  /** Per-viewer activity-alert prefs (V3-P6) — the friend-activity opt-in set (#368). */
  profile: ProfileRepository;
  /** The central notification pipeline (#368): portfolio.shared + friend.activity. */
  notify: NotificationCenter;
  /**
   * The Live-Mode per-asset ring buffer (§6.3, V3-P7b). Optional: the intraday
   * 1D/1W series (issue #556) prefers its already-recorded ticks over new
   * provider calls where present; absent under test / in processes without it,
   * the cached provider intraday history covers the window on its own.
   */
  liveRing?: LiveRingBuffer;
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
  /**
   * Permanently delete an owned portfolio and its entire dependent-row graph —
   * the hard option beside archive. Transactions, holdings, the cash ledger +
   * sources, dividends, snapshots (graph cache) and the sharing audience +
   * public links all die with it. Rejects (400 `LAST_ACTIVE_PORTFOLIO`) deleting
   * the caller's only *active* portfolio so a user is never left with zero usable
   * ones; deleting the current default silently auto-promotes the next active row
   * (the default is derived from the active set, §6.8). 404 when the id is
   * unknown or another user's — and on a second call, so delete is idempotent-ish.
   */
  deletePortfolio(userId: string, portfolioId: string): Promise<void>;
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
    params: { cursor?: string; limit?: number; source?: string },
  ): Promise<TransactionListResponse>;
  /**
   * Record one or more transactions. `opts.source` is the V5-P0c source tag the
   * rows (and their linked cash legs) are stamped with — `manual` by default;
   * the CSV apply path passes `import:<broker>`. Server-assigned only: the HTTP
   * body carries no source field, so a client can never forge a sync/import tag.
   */
  createTransactions(
    userId: string,
    portfolioId: string,
    inputs: TransactionInput[],
    opts?: { source?: string },
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
  getCashMovements(
    userId: string,
    portfolioId: string,
    opts?: { source?: string },
  ): Promise<CashMovementsResponse>;
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
    opts?: { source?: string },
  ): Promise<CashMovementResponse>;
  /**
   * Record an external cash withdrawal from a source (Main by default);
   * rejects an overdraw of that source (§14/V3-P3, no silent negatives).
   */
  withdrawCash(
    userId: string,
    portfolioId: string,
    input: CashEntryRequest,
    opts?: { source?: string },
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
    /** Daily on 1M+; a dense intraday curve (each point carries `time`) on 1D/1W (#556). */
    points: PortfolioHistoryPoint[];
    performance: PortfolioPerformancePoint[];
    assets?: PortfolioHistoryOverlay[];
  }>;
  /**
   * Per-asset EUR value-over-time series (V3-P9 Analytics) — the smoothing-aware
   * building block the overview curve sums over, exposed at per-asset
   * granularity so Analytics can mask visibility, filter by category/type, and
   * compute per-asset contributions. One entry per transacted, EUR-convertible
   * asset (non-convertible currencies drop exactly as they do in the overview,
   * §5.4); each is a daily EUR series from that asset's first transaction
   * through `today`. Always EUR-denominated (the storage base). Ownership is
   * enforced (404 on a foreign/missing id); not cached.
   */
  getAssetValueSeries(
    userId: string,
    portfolioId: string,
  ): Promise<{
    baseCurrency: string;
    name: string;
    today: string;
    assets: Array<{ asset: PortfolioAsset; points: Array<{ date: string; valueEur: number }> }>;
  }>;
  /**
   * Invalidate the precomputed snapshot series from `fromDay` (ISO
   * `YYYY-MM-DD`) — the earliest day the calling write can have reshaped.
   * Days before it stay untouched (§16 2026-07-17); a durable recompute of
   * the deleted tail is triggered, with lazy read-side refill as the backstop.
   */
  invalidateHistory(portfolioId: string, fromDay: string): Promise<void>;
  /**
   * Freshness watermark for the summary + history conditional reads (issue
   * #555): the snapshot-state `updated_at` (issue #553), which advances on
   * every history-invalidating write. Ownership-checked (404 on a
   * foreign/missing id); null when the portfolio has no computed history yet.
   * Advisory `Last-Modified` only — the authoritative validator is the
   * body-derived ETag (a live "today" quote moves the ETag, not this).
   */
  getSnapshotFreshness(userId: string, portfolioId: string): Promise<Date | null>;
}

const DEFAULT_LIMIT = 50;

/**
 * The series ingredients `getHistory` re-denominates, always EUR (the storage
 * base): the net-worth value curve and the external TWR flows it pairs with.
 * Served by the V5-P1 snapshot layer (issue #553) — precomputed rows for
 * historical days, a fresh quote-driven point for today. Per-user bases are
 * applied at read time (see `getHistory`).
 */
interface SeriesIngredients {
  points: Array<{ date: string; valueEur: number }>;
  flows: FlowPoint[];
}

/**
 * Non-MAX ranges (§6.9 + V4-P0: 1D / 1W / 1M / 6M / 1Y / 5Y / MAX) resolve to
 * a cutoff via {@link rangeCutoffIso}: day-spans by ISO-day arithmetic, month
 * spans through {@link monthsBefore} (so a month-boundary edge case like "Mar
 * 31 − 1M" cannot silently shorten a window, issue #218). The stored snapshot
 * series is daily-resolution; the read path densifies every non-MAX range with
 * a sub-daily curve on top of it (see {@link buildIntradayHistory}) — the same
 * cutoff bounds both the daily slice and the densified window.
 */
const RANGE_MONTHS: Record<'1M' | '6M' | '1Y' | '5Y', number> = {
  '1M': 1,
  '6M': 6,
  '1Y': 12,
  '5Y': 60,
};

export function createPortfolioService(deps: PortfolioServiceDeps): PortfolioService {
  const {
    portfolioRepo,
    transactionRepo,
    cashMovementRepo,
    cashSourceRepo,
    marketData,
    currencyService,
    referenceBackfill,
    snapshots,
    taxService,
    friendshipRepo,
    audience,
    profile,
    notify,
    liveRing,
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
      // Carry the persisted uncovered acknowledgment (issue #369) so a replay
      // (holdings, oversell re-check on edit/delete) doesn't reject an already-
      // accepted uncovered sell.
      allowUncovered: r.allowUncovered,
      uncoveredEntryPrice: r.uncoveredEntryPrice,
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
      // The submitted acknowledgment (issue #369): with it, an oversell in this
      // batch's replay is permitted instead of throwing OVERSELL.
      allowUncovered: i.allowUncovered,
      uncoveredEntryPrice: i.uncoveredEntryPrice,
    };
  }

  function assetToDto(row: AssetRow): TransactionDto['asset'] {
    const isCustom = row.ownerId !== null;
    // Custom assets carry their catalog category + smoothing flag (V3-P2) so the
    // allocation donut groups a custom "stock" under Stocks and the value-point
    // editor knows the current smoothing state. Market assets group by `type`.
    const meta = (row.meta ?? {}) as { category?: string; smoothing?: boolean };
    const parsedCategory = customAssetCategorySchema.safeParse(meta.category);
    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      exchange: row.exchange ?? null,
      currency: row.currency,
      type: row.type,
      isCustom,
      category: isCustom ? (parsedCategory.success ? parsedCategory.data : 'other') : null,
      smoothing: isCustom ? meta.smoothing === true : undefined,
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
      allowUncovered: r.allowUncovered,
      uncoveredEntryPrice: r.uncoveredEntryPrice,
      source: r.source,
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

  /**
   * Report a history-mutating write to the snapshot layer (§16 2026-07-17):
   * `fromDay` is the earliest day the write can have reshaped — rows before it
   * are provably unchanged and stay untouched.
   */
  async function invalidateHistory(portfolioId: string, fromDay: string): Promise<void> {
    await snapshots.invalidate(portfolioId, fromDay);
  }

  /** ISO day of a Date/ISO timestamp (UTC). */
  const dayOf = (value: Date | string): string =>
    (typeof value === 'string' ? new Date(value) : value).toISOString().slice(0, 10);

  /** The earliest of a set of ISO days — the invalidation anchor of a write. */
  function minDay(days: readonly string[]): string {
    return days.reduce((a, b) => (a < b ? a : b));
  }

  /**
   * Emit one `portfolio.shared` per current friend of the owner (§6.10) through
   * the durable notification center (#368) so each friend learns the portfolio
   * is now shared. Best-effort: a resolve failure never fails the update.
   */
  async function emitPortfolioShared(ownerId: string, portfolioId: string): Promise<void> {
    try {
      const [ownerUsername, friends] = await Promise.all([
        friendshipRepo.getUsername(ownerId),
        friendshipRepo.listFriends(ownerId),
      ]);
      const occurredAt = new Date(now()).toISOString();
      for (const friend of friends) {
        await notify.emit({
          type: 'portfolio.shared',
          userId: friend.id,
          actorId: ownerId,
          actorUsername: ownerUsername ?? '',
          portfolioId,
          occurredAt,
        });
      }
    } catch (err) {
      logger?.error({ err, portfolioId }, 'portfolio.shared event emit failed');
    }
  }

  /**
   * Friend-activity fan-out (#368): after a transaction batch commits, notify
   * every viewer who (a) opted into activity alerts for THIS portfolio via the
   * V3-P6 toggle AND (b) is still authorized to see it — the audience layer is
   * re-checked per viewer at emit time, so a pref that outlived a revoked share
   * notifies nobody. Best-effort: never fails the write it trails.
   */
  async function emitFriendActivity(
    ownerId: string,
    portfolioId: string,
    trades: { refId: string; side: 'buy' | 'sell'; symbol: string }[],
  ): Promise<void> {
    try {
      const viewers = await profile.viewersWithActivityAlerts('portfolio', portfolioId);
      const optedIn = viewers.filter((v) => v !== ownerId);
      if (optedIn.length === 0) return;
      const actorUsername = (await friendshipRepo.getUsername(ownerId)) ?? '';
      const occurredAt = new Date(now()).toISOString();
      for (const viewerId of optedIn) {
        const authorized = await audience
          .authorizePortfolioRead(viewerId, portfolioId)
          .catch(() => undefined);
        if (!authorized) continue;
        for (const trade of trades) {
          await notify.emit({
            type: 'friend.activity',
            userId: viewerId,
            actorId: ownerId,
            actorUsername,
            itemKind: 'portfolio',
            itemId: portfolioId,
            activity: trade.side,
            assetSymbol: trade.symbol,
            refId: trade.refId,
            occurredAt,
          });
        }
      }
    } catch (err) {
      logger?.error({ err, portfolioId }, 'friend.activity emit failed');
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
      dividendId: r.dividendId,
      taxYear: r.taxYear,
      executedAt: r.executedAt.toISOString(),
      note: r.note,
      source: r.source,
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
   * {@link floorCents}), so this only sheds FP summation dust — the reported
   * balance is always exact cents, which is what lets a withdraw-all land at
   * exactly €0.00 (V3-P0, issue #322). Rolls up across ALL sources (V3-P3).
   */
  async function cashBalanceFor(portfolioId: string): Promise<number> {
    const records = await cashMovementRepo.listForPortfolio(portfolioId);
    return floorCents(cashBalance(records.map(toDomainMovement)));
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
    for (const [sourceId, balance] of raw) balanceBySource.set(sourceId, floorCents(balance));
    return {
      records,
      balanceBySource,
      totalEur: floorCents(cashBalance(records.map(toDomainMovement))),
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
    payload: SeriesIngredients,
    fx: CurrencyService,
  ): Promise<{ points: SeriesIngredients['points']; flows: FlowPoint[] }> {
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
      const costEur = floorCents(
        await toCashEur(input.quantity * input.price + input.fee, asset.currency, day),
      );
      if (costEur <= CASH_EPSILON) return null;
      return { kind: 'buy', amountEur: -costEur, sourceId, note: 'Paid from cash balance' };
    }
    if (input.addProceedsToCash && input.side === 'sell') {
      const proceedsEur = floorCents(
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

  /**
   * The series ingredients for a portfolio (first transaction or cash
   * movement → today): the EUR **net-worth** curve (holdings value + EOD cash
   * balance, #311) and the external TWR flows (#125), served by the V5-P1
   * snapshot layer (issue #553) — precomputed daily rows for historical days
   * (the engine runs only as the snapshot writer / dirty-state fallback), plus
   * an always-fresh quote-driven "today" point. The range slice is applied by
   * the caller.
   */
  async function loadSeries(portfolioId: string): Promise<SeriesIngredients> {
    const series = await snapshots.getSeries(portfolioId);
    return { points: series.points, flows: series.flows };
  }

  /**
   * One asset's native intraday candles for the window (issue #556). The
   * cached/coalesced provider history is the source (§5.3 — a burst of series
   * reads costs one upstream fetch per asset/interval); where the Live-Mode
   * ring buffer already holds recent ticks they are preferred (fresher, and no
   * new provider call), the ring winning at its own instants. Best-effort: a
   * provider or ring failure degrades to whatever the other supplied (an asset
   * left without any intraday data carries forward in the builder).
   */
  async function loadIntradayCandles(
    asset: { id: string; providerId: string; providerRef: string },
    range: DensifiedPortfolioRange,
    cutoffMs: number,
  ): Promise<IntradayCandle[]> {
    const ref = { providerId: asset.providerId, providerRef: asset.providerRef };
    const byMs = new Map<number, number>();
    try {
      // 1M/6M/1Y/5Y fetch their sub-daily candles over the recent `fetchRange`
      // (all a provider serves at an intraday interval), sharing one §5.3 cache
      // entry; 1D/1W fetch over their own range. The builder densifies the days
      // candles cover and daily-fills the rest.
      const history = await marketData.getHistory(
        ref,
        densifiedFetchRange(range),
        densifiedIntervalFor(range),
      );
      for (const point of history.value) {
        const atMs = Date.parse(point.time);
        if (!Number.isNaN(atMs) && Number.isFinite(point.close)) byMs.set(atMs, point.close);
      }
    } catch {
      // Provider outage past the stale window — the ring (if any) still seeds it.
    }
    if (liveRing) {
      try {
        for (const frame of await liveRing.readSince(asset.id, cutoffMs)) {
          const atMs = Date.parse(frame.at);
          // Ring ticks win at their instant — the freshest observed native price.
          if (!Number.isNaN(atMs) && Number.isFinite(frame.price)) byMs.set(atMs, frame.price);
        }
      } catch {
        // The ring is a best-effort accelerator; ignore a Redis hiccup.
      }
    }
    return [...byMs].map(([atMs, price]) => ({ atMs, price })).sort((a, b) => a.atMs - b.atMs);
  }

  /**
   * The densified (sub-daily) history for a non-MAX range (issue #556;
   * 2026-07-20 resolution bump): the daily snapshot series scaled by each held
   * asset's intraday price ratio (see {@link buildIntradayEurValuePoints}).
   * Returns `null` for a portfolio with no history at all (the caller falls
   * through to the daily path's empty result). With no intraday candles for any
   * asset the builder degrades to one point per in-window day — exactly the
   * pre-#556 daily slice — which is also what the older, beyond-`fetchRange`
   * days of a 1M+ span get.
   */
  async function buildIntradayHistory(
    portfolioId: string,
    range: DensifiedPortfolioRange,
    fx: CurrencyService,
    today: string,
  ): Promise<{ points: PortfolioHistoryPoint[]; performance: PortfolioPerformancePoint[] } | null> {
    const series = await snapshots.getSeries(portfolioId);
    if (series.points.length === 0) return null;

    const cutoffDay = rangeCutoffIso(range, today);
    const cutoffMs = Date.parse(`${cutoffDay}T00:00:00.000Z`);
    const nowMs = now();

    const dailyValueEurByDay = new Map(series.points.map((p) => [p.date, p.valueEur]));
    const perAssetEurByDay = new Map<string, Map<string, number>>();
    for (const asset of series.assets) {
      perAssetEurByDay.set(asset.assetId, new Map(asset.points.map((p) => [p.date, p.valueEur])));
    }

    // Fetch candles only for assets actually held during the window; manual /
    // custom assets have no intraday history and always carry forward.
    const heldAssetIds = series.assets
      .filter((a) => a.points.some((p) => p.date >= cutoffDay))
      .map((a) => a.assetId);
    const assetsById = new Map(
      (await portfolioRepo.assetsByIds(heldAssetIds)).map((r) => [r.id, r]),
    );
    const candlesByAsset = new Map<string, IntradayCandle[]>();
    await Promise.all(
      heldAssetIds.map(async (assetId) => {
        const asset = assetsById.get(assetId);
        if (!asset || asset.providerId === 'manual') return;
        const candles = await loadIntradayCandles(asset, range, cutoffMs);
        if (candles.length > 0) candlesByAsset.set(assetId, candles);
      }),
    );

    const eurPoints = buildIntradayEurValuePoints({
      range,
      cutoffDay,
      nowMs,
      dailyValueEurByDay,
      perAssetEurByDay,
      candlesByAsset,
    });
    if (eurPoints.length === 0) return null;

    // Re-denominate EUR → the caller's base with per-day historical rates (§5.4,
    // identity for EUR) — the same treatment `seriesInBase` gives the daily
    // curve, so 1D/1W stay currency-consistent with 1M+. Days whose FX is
    // unavailable in the requested base drop, exactly as they do daily.
    const points: PortfolioHistoryPoint[] = [];
    if (fx.baseCurrency === baseCurrency) {
      for (const p of eurPoints) {
        points.push({ date: p.date, time: new Date(p.timeMs).toISOString(), valueEur: p.valueEur });
      }
    } else {
      const rateByDay = new Map<string, number>();
      for (const day of new Set(eurPoints.map((p) => p.date))) {
        try {
          rateByDay.set(day, await fx.getRate(baseCurrency, fx.baseCurrency, { date: day }));
        } catch (err) {
          if (err instanceof FxRateUnavailableError) continue;
          throw err;
        }
      }
      for (const p of eurPoints) {
        const rate = rateByDay.get(p.date);
        if (rate === undefined) continue;
        points.push({
          date: p.date,
          time: new Date(p.timeMs).toISOString(),
          valueEur: p.valueEur * rate,
        });
      }
    }
    if (points.length === 0) return null;

    // Performance is anchored to the daily TWR (in the caller's base), so 1D/1W
    // agree with the 1M+ ranges at each day close (see intradayPerformancePoints).
    const baseDaily = await seriesInBase({ points: series.points, flows: series.flows }, fx);
    const baseIntraday: IntradayValuePoint[] = points.map((p) => ({
      date: p.date,
      timeMs: Date.parse(p.time!),
      valueEur: p.valueEur,
    }));
    const performance: PortfolioPerformancePoint[] = intradayPerformancePoints({
      intradayPoints: baseIntraday,
      dailyBasePoints: baseDaily.points,
      flowsBase: baseDaily.flows,
    }).map((p) => ({ date: p.date, time: new Date(p.timeMs).toISOString(), pct: p.pct }));

    return { points, performance };
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
      // Universal private-default (#384): a newly created portfolio is ALWAYS
      // private, for every user. The legacy per-user `default_portfolio_visibility`
      // is retired/ignored here — the Settings control that set it was removed in
      // #377, so new portfolios start private and are shared deliberately from the
      // Social area's "My items" via the AudiencePicker. Existing portfolios and
      // the auto-created "Main" (always private) are untouched.
      return portfolioRepo.createPortfolio(userId, name, 'private');
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

    async deletePortfolio(userId, portfolioId) {
      const portfolio = await portfolioRepo.findByIdForUser(userId, portfolioId);
      if (!portfolio) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
      // The default-portfolio invariant, mirrored from archive (§13.2 V2-P8): a
      // user always keeps ≥1 usable portfolio. Deleting an *active* portfolio is
      // rejected when it is the only active one; deleting the current default is
      // fine while another active row exists — the default recomputes to the
      // oldest remaining active row automatically (it is derived, not stored,
      // §6.8), so no explicit promotion is needed. An *archived* portfolio never
      // counts toward the active set, so deleting one is always allowed.
      if (!portfolio.archivedAt) {
        const activeCount = await portfolioRepo.countActive(userId);
        if (activeCount <= 1) {
          throw badRequest(
            'You cannot delete your only active portfolio.',
            'LAST_ACTIVE_PORTFOLIO',
          );
        }
      }
      // Hard-delete the row; the FK graph cascades transactions, cash sources +
      // movements and dividends away in one statement. A concurrent delete that
      // raced us to gone → treat as already deleted (404), so a second call 404s.
      const deleted = await portfolioRepo.deletePortfolio(userId, portfolioId);
      if (!deleted) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
      // Clear the polymorphic sharing audience (+ members + public links) — it
      // carries no FK to the portfolio, so the cascade never reaches it. Mirrors
      // conglomerate/watchlist deletion; hygiene only, as the authorization joins
      // already exclude a vanished subject (a lingering chat share-chip resolves
      // to the not-available state via those same joins, #349/#332).
      await audience.clearForSubject('portfolio', portfolioId);
      // The snapshot rows + state died with the portfolio (FK cascade, §16
      // 2026-07-17 rule 8) — nothing to invalidate here.
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
        source: params.source,
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
          allowUncovered: row.allowUncovered,
          uncoveredEntryPrice: row.uncoveredEntryPrice,
          source: row.source,
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

    async createTransactions(userId, portfolioId, inputs, opts) {
      if (inputs.length === 0) throw badRequest('No transactions to create.', 'EMPTY_BATCH');
      await requireOwnedPortfolio(userId, portfolioId);
      // Source tag (V5-P0c): `manual` unless the caller (the CSV apply path)
      // passes `import:<broker>`. The HTTP body carries no source, so a client
      // can never forge a non-manual tag on a hand-entered row.
      const source = opts?.source ?? 'manual';

      const assetIds = [...new Set(inputs.map((i) => i.assetId))];
      const assetsById = await loadVisibleAssets(userId, assetIds);

      // Validate per asset against the *whole* timeline (existing + pending), so
      // back-dated sells and intra-batch interleaving are judged correctly.
      for (const assetId of assetIds) {
        const existing = await transactionRepo.listForAsset(portfolioId, assetId);
        const pending = inputs.filter((i) => i.assetId === assetId).map(inputToDomain);
        assertNoOversell([...existing.map(recordToDomain), ...pending]);
      }

      // The mode active at this recording moment (V3-P4, §16 cutover
      // semantics): it decides both the tax plan below and whether a bare
      // cash source id is meaningful (it names the tax source of a sell).
      const taxSettings = await taxService.getEffectiveSettings(userId);

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
            // Under an active tax mode a sell's settlement posts to a cash
            // source even without the proceeds flag, so a bare source id is
            // meaningful there (V3-P4); everywhere else it stays a 400 —
            // `none` mode keeps the exact v2 behavior.
            const namesTaxSource = taxSettings.mode !== 'none' && input.side === 'sell';
            if (input.cashSourceId !== undefined && !namesTaxSource) {
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

      // Tax plan (V3-P4): per-sell frozen tax facts + settlement movements,
      // plus unattached year corrections when the batch re-shapes history
      // (e.g. a backdated buy shifting existing AT gains). Pure planning —
      // written atomically with the rows below.
      const taxPlan = await taxService.planTransactionTaxes({
        userId,
        portfolioId,
        inputs,
        assetsById,
        resolveSourceId: (explicitId) => flowSource(explicitId).then((s) => s.id),
      });

      // Decide each cash leg's date (#378). A pay-from-cash BUY whose cash was
      // insufficient AS OF the buy date and flagged `settleCashAsOfToday` settles
      // its cash-withdrawal leg **as of today**: the asset acquisition still
      // records on its past `executedAt` (cost basis / P&L / AT tax anchored
      // there), but the linked `buy` movement is dated today so the historical
      // ledger never dips negative. Every other leg — a buy with cash available at
      // its date, a sell, a tax settlement — keeps its transaction date.
      // `spendableAsOf` per source is exactly what the solvency gate below
      // enforces, so a leg moves only when genuinely short; the gate then still
      // rejects (INSUFFICIENT_CASH) a buy that cannot be covered even today.
      const existingCash = await cashMovementRepo.listForPortfolio(portfolioId);
      const existingBySource = new Map<string, SourcedCashMovement[]>();
      for (const record of existingCash) {
        const movement = toDomainMovement(record);
        const list = existingBySource.get(movement.sourceId);
        if (list) list.push(movement);
        else existingBySource.set(movement.sourceId, [movement]);
      }
      const nowIso = new Date(now()).toISOString();
      const proposed: SourcedCashMovement[] = cashLinks
        .map((link, i): SourcedCashMovement | null => {
          if (!link) return null;
          const naturalIso = new Date(inputs[i]!.executedAt).toISOString();
          let occurredAt = naturalIso;
          if (link.kind === 'buy' && inputs[i]!.settleCashAsOfToday) {
            const available = spendableAsOf(existingBySource.get(link.sourceId) ?? [], naturalIso);
            const costEur = -link.amountEur; // buy amounts are strictly negative
            if (costEur > available + CASH_EPSILON) {
              occurredAt = nowIso;
              // Persist the moved date onto the stored leg too, so the recorded
              // movement matches the solvency-checked one.
              cashLinks[i] = { ...link, occurredAt: new Date(nowIso) };
            }
          }
          return {
            kind: link.kind,
            amountEur: link.amountEur,
            sourceId: link.sourceId,
            occurredAt,
          };
        })
        .filter((m): m is SourcedCashMovement => m !== null)
        .concat(taxPlan.proposed);
      if (proposed.length > 0) {
        assertCashSolvent(existingCash, proposed);
      }

      const inserted = await transactionRepo.insertMany(
        portfolioId,
        inputs.map((i, idx): NewTransaction => {
          const rowPlan = taxPlan.rows[idx];
          const cashMovements = [
            ...(cashLinks[idx] ? [cashLinks[idx]!] : []),
            ...(rowPlan?.movement ? [rowPlan.movement] : []),
          ];
          return {
            assetId: i.assetId,
            side: i.side,
            quantity: i.quantity,
            price: i.price,
            fee: i.fee,
            executedAt: new Date(i.executedAt),
            note: i.note ?? null,
            tax: rowPlan?.tax ?? null,
            // Persist the uncovered-sell acknowledgment + supplied basis (#369);
            // the entry price is only meaningful on an acknowledged sell.
            allowUncovered: i.side === 'sell' ? (i.allowUncovered ?? false) : false,
            uncoveredEntryPrice:
              i.side === 'sell' && i.allowUncovered ? (i.uncoveredEntryPrice ?? null) : null,
            source,
            cashMovements,
          };
        }),
        // Batch year-correction legs carry the same source as the batch (V5-P0c).
        taxPlan.extras.map((extra) => ({ ...extra, source })),
      );

      // Earliest affected day (§16 rule 1): the batch's earliest transaction
      // day or cash/tax leg — a settle-as-of-today leg lands later, a tax
      // correction at "now"; the minimum covers every written row.
      await invalidateHistory(
        portfolioId,
        minDay([
          ...inputs.map((i) => dayOf(i.executedAt)),
          ...proposed.map((m) => dayOf(m.occurredAt)),
        ]),
      );

      // First reference (§6.2/§9): transacting on an asset warms its daily
      // history so the value-over-time series has closes to plot — seeded and
      // enrichment-upserted catalog rows get their backfill here. Best-effort.
      for (const assetId of assetIds) {
        await referenceBackfill.ensureHistory(assetId);
      }

      // Friend-activity (#368): tell opted-in, still-authorized viewers about
      // the new buys/sells on this shared portfolio. Best-effort, after commit.
      await emitFriendActivity(
        userId,
        portfolioId,
        inserted.map((r) => ({
          refId: `txn:${r.id}`,
          side: r.side,
          symbol: assetsById.get(r.assetId)?.symbol ?? '',
        })),
      );

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
        // A row carrying recorded tax is financially immutable (V3-P4): its
        // frozen tax and settlement movement mirror the numbers it was
        // recorded with, and the AT year ledger settled on them append-only.
        // Note edits stay allowed; to change the numbers, delete and re-add
        // (the delete re-settles the year with a correction movement).
        if (existing.taxMode === 'manual_per_trade' || existing.taxMode === 'country_specific') {
          throw badRequest(
            'This transaction carries recorded tax. Delete and re-add it to change the numbers.',
            'TRANSACTION_TAXED',
          );
        }
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

      // Editing a BUY re-shapes the moving average every later sell realized
      // against — and AT-taxed sells' gains are year-settled money (V3-P4).
      // Reject rather than silently un-anchor a settled year; deleting and
      // re-adding routes through the append-only correction path instead.
      // (Sells never move another row's average, so editing an untaxed sell
      // stays as permissive as v2.)
      if (
        financialEdit &&
        existing.side === 'buy' &&
        siblings.some((s) => s.side === 'sell' && s.taxMode === 'country_specific')
      ) {
        throw badRequest(
          'Editing this buy would change the realized gains of tax-settled sells. Delete and re-add it instead.',
          'TRANSACTION_AFFECTS_TAXED',
        );
      }
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

      // A (possibly backdated) edit reshapes history from the earlier of the
      // row's old and new day (§16 rule 2); nothing before both can change.
      await invalidateHistory(
        portfolioId,
        minDay([dayOf(existing.executedAt), dayOf(updated.executedAt)]),
      );

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

      // Deleting an AT-taxed sell — or a buy that feeds AT sells' averages —
      // re-shapes settled year pools; the year re-settles append-only with a
      // correction movement computed against the post-delete state (V3-P4,
      // §16 2026-07-08). Planned up-front so the solvency replay below can
      // include it.
      const taxCorrections = await taxService.planTransactionDeleteCorrections(
        portfolioId,
        existing,
      );

      // Deleting a cash-linked buy/sell cascades away its cash movements (§14,
      // V3-P4 settlements included; schema onDelete: 'cascade'). If a later
      // withdrawal/purchase relied on that cash — or a correction must claw
      // tax back — the *remaining* ledger would dip negative, and the solvency
      // gate replays the whole history, so from then on every cash write is
      // rejected. Enforce the no-negative invariant at the delete boundary too:
      // replay the ledger (per source, V3-P3) without this txn's movements,
      // with the corrections appended, and refuse the delete if any point
      // would go negative.
      const cashMovements = await cashMovementRepo.listForPortfolio(portfolioId);
      if (cashMovements.some((m) => m.transactionId === id) || taxCorrections.length > 0) {
        const remaining = cashMovements.filter((m) => m.transactionId !== id).map(toDomainMovement);
        const proposedCorrections: SourcedCashMovement[] = taxCorrections.map((c) => ({
          kind: c.kind,
          amountEur: c.amountEur,
          occurredAt: c.executedAt.toISOString(),
          sourceId: c.sourceId,
        }));
        try {
          projectCashLedgerBySource([...remaining, ...proposedCorrections]);
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

      // Post the year corrections the delete necessitated (append-only §16).
      for (const correction of taxCorrections) {
        await cashMovementRepo.insert(portfolioId, correction);
      }

      // The removed row's day, or an earlier-dated tax correction (§16 rule 3).
      await invalidateHistory(
        portfolioId,
        minDay([dayOf(existing.executedAt), ...taxCorrections.map((c) => dayOf(c.executedAt))]),
      );
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

    async getCashMovements(userId, portfolioId, opts) {
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
      // Source-tag filter (V5-P0c): the returned movements are narrowed to the
      // requested tag, but balances still roll up the FULL ledger — a filter is
      // a view, never a re-computation of net worth.
      const visible = opts?.source ? records.filter((r) => r.source === opts.source) : records;
      return {
        balanceEur: totalEur,
        movements: visible.map(movementToDto),
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
      // but they DO move the per-source cash split on the snapshot rows —
      // invalidate from the (possibly back-dated) transfer day (§16 rule 4).
      await invalidateHistory(portfolioId, dayOf(executedAt));
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
      const currentEur = floorCents(
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
      // Cash is part of the net-worth curve (#311); set-balance is always
      // effective now, so only today's (never-persisted) point moves (§16 rule 4).
      await invalidateHistory(portfolioId, dayOf(domainMovement.occurredAt));
      const { balanceBySource, totalEur } = await loadCashState(portfolioId);
      return {
        movement: movementToDto(movement),
        deltaEur: domainMovement.amountEur,
        sourceBalanceEur: balanceBySource.get(source.id) ?? 0,
        balanceEur: totalEur,
      };
    },

    async depositCash(userId, portfolioId, input, opts) {
      await requireOwnedPortfolio(userId, portfolioId);
      const source = await resolveFlowSource(portfolioId, input.sourceId);
      // A deposit only ever raises the balance, so it needs no solvency gate.
      const executedAt = input.executedAt ? new Date(input.executedAt) : new Date(now());
      // Cash is whole-cent money — quantize the entered amount to cents (#322).
      const movement = await cashMovementRepo.insert(portfolioId, {
        sourceId: source.id,
        kind: 'deposit',
        amountEur: floorCents(input.amountEur),
        executedAt,
        note: input.note ?? null,
        // Source tag (V5-P0c): `manual` unless the CSV apply path stamps a broker.
        source: opts?.source ?? 'manual',
      });
      // Cash is part of the net-worth curve (#311): a (possibly back-dated)
      // deposit reshapes it from its own day on (§16 rule 4).
      await invalidateHistory(portfolioId, dayOf(executedAt));
      const { balanceBySource, totalEur } = await loadCashState(portfolioId);
      return {
        movement: movementToDto(movement),
        sourceBalanceEur: balanceBySource.get(source.id) ?? 0,
        balanceEur: totalEur,
      };
    },

    async withdrawCash(userId, portfolioId, input, opts) {
      await requireOwnedPortfolio(userId, portfolioId);
      const source = await resolveFlowSource(portfolioId, input.sourceId);
      const executedAt = input.executedAt ? new Date(input.executedAt) : new Date(now());
      // Cash is whole-cent money — quantize the entered amount to cents (#322),
      // so a withdraw-all (the cent-exact reported balance) cancels the ledger
      // to exactly €0.00 rather than stranding sub-cent residue.
      const amountEur = floorCents(input.amountEur);
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
        // Source tag (V5-P0c): `manual` unless the CSV apply path stamps a broker.
        source: opts?.source ?? 'manual',
      });
      // Cash is part of the net-worth curve (#311): a (possibly back-dated)
      // withdrawal reshapes it from its own day on (§16 rule 4).
      await invalidateHistory(portfolioId, dayOf(executedAt));
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
      const records = await cashMovementRepo.listForPortfolio(portfolioId);
      const sourceMovements = records.filter((r) => r.sourceId === source.id).map(toDomainMovement);
      const availableEur = floorCents(cashBalance(sourceMovements));
      // Quantize the proposed amount to cents to mirror what the write path will
      // actually record (#322), so the "available → after" preview matches the
      // balance the user will land on — a withdraw-all previews exactly €0.00.
      const amountEur = floorCents(input.amountEur);
      const afterEur = floorCents(availableEur + amountEur * CASH_MOVEMENT_SIGN[input.kind]);
      const sufficient = afterEur >= -CASH_EPSILON;
      const base = {
        availableEur,
        afterEur,
        sufficient,
        shortfallEur: sufficient ? 0 : -afterEur,
      };
      // Backdated pay-from-cash (#378): for a BUY with a past date, also report
      // the cash spendable AS OF that date — the source's running-minimum balance
      // from that instant on, exactly what the write-boundary solvency gate
      // allows — so the form can distinguish "insufficient back then but fine
      // today" (warn + offer settle-as-of-today) from "unaffordable even now".
      if (input.asOfDate !== undefined && input.kind === 'buy') {
        const asOfAvailableEur = floorCents(
          spendableAsOf(sourceMovements, `${input.asOfDate}T00:00:00.000Z`),
        );
        const asOfAfterEur = floorCents(asOfAvailableEur - amountEur);
        return {
          ...base,
          asOfDate: input.asOfDate,
          asOfAvailableEur,
          asOfAfterEur,
          asOfSufficient: asOfAfterEur >= -CASH_EPSILON,
        };
      }
      return base;
    },

    async getHistory(userId, portfolioId, range, opts) {
      // Ownership is enforced against the scoped id (§6.8): another user's — or a
      // missing — portfolio is a 404, not a silent fall-back to the default.
      await requireOwnedPortfolio(userId, portfolioId);
      const overlay = opts?.overlay ?? false;
      const fx = fxFor(opts?.baseCurrency);

      const today = todayIso();

      // Every non-MAX range renders a densified (sub-daily) curve rather than a
      // plain daily slice (V5-P1 arc d, issue #556; 2026-07-20 resolution bump).
      // 1D/1W are full intraday curves; 1M/6M/1Y/5Y densify their recent window
      // and daily-fill older days. The builder degrades to the daily slice when
      // no intraday data exists, and returns null only for a history-less
      // portfolio — which falls through to the empty daily result. MAX keeps its
      // since-inception daily curve.
      if (isDensifiedRange(range)) {
        const intraday = await buildIntradayHistory(portfolioId, range, fx, today);
        if (intraday) {
          if (!overlay) {
            return {
              range,
              baseCurrency: fx.baseCurrency,
              points: intraday.points,
              performance: intraday.performance,
            };
          }
          // Overlays stay per-asset daily price curves (issue #122), sliced to
          // the window — the intraday densification is the portfolio curve only.
          const overlayAssets = (await snapshots.getOverlays(portfolioId))
            .map((a) => ({ ...a, points: sliceRange(a.points, range, today) }))
            .filter((a) => a.points.length > 0);
          return {
            range,
            baseCurrency: fx.baseCurrency,
            points: intraday.points,
            performance: intraday.performance,
            assets: overlayAssets,
          };
        }
      }

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
      // the window is dropped rather than sent as an empty series. Overlays are
      // per-asset PRICE curves — not snapshot material — assembled on demand
      // from the §5.3-cached provider histories + stored `price_history` rows.
      const assets = (await snapshots.getOverlays(portfolioId))
        .map((a) => ({ ...a, points: sliceRange(a.points, range, today) }))
        .filter((a) => a.points.length > 0);
      return { range, baseCurrency: fx.baseCurrency, points, performance, assets };
    },

    async getAssetValueSeries(userId, portfolioId) {
      // Ownership enforced against the scoped id (§6.8): a foreign/missing id 404s.
      const summary = await requireOwnedPortfolio(userId, portfolioId);
      const today = todayIso();

      // The per-asset breakdown of the SAME series the overview sums (V3-P9):
      // served by the snapshot layer — per-asset values ride each daily row,
      // and the "today" point per asset is quote-fresh. Summing any visible
      // subset reproduces the overview total, because valueOverTime is linear
      // in its assets (§13.3 V3-P9). A portfolio without transactions simply
      // yields an empty asset list — no separate pre-check query needed.
      const series = await snapshots.getSeries(portfolioId);
      if (series.assets.length === 0) {
        return { baseCurrency, name: summary.name, today, assets: [] };
      }
      const assetsById = new Map(
        (await portfolioRepo.assetsByIds(series.assets.map((a) => a.assetId))).map((r) => [
          r.id,
          r,
        ]),
      );
      const assets: Array<{
        asset: PortfolioAsset;
        points: Array<{ date: string; valueEur: number }>;
      }> = [];
      for (const entry of series.assets) {
        const row = assetsById.get(entry.assetId);
        if (!row) continue; // unreachable: the series only carries live assets
        assets.push({ asset: assetToDto(row), points: entry.points });
      }
      return { baseCurrency, name: summary.name, today, assets };
    },

    invalidateHistory,

    async getSnapshotFreshness(userId, portfolioId) {
      await requireOwnedPortfolio(userId, portfolioId);
      return snapshots.getStateUpdatedAt(portfolioId);
    },
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
  const cutoff = rangeCutoffIso(range, today);
  return series.filter((p) => p.date >= cutoff);
}

/**
 * ISO-day cutoff at which a non-MAX range window opens (§6.9 + V4-P0). Day
 * spans (1D/1W) resolve by exact day arithmetic on the ISO stamp; month/year
 * spans go through {@link monthsBefore} so the #218 last-day-of-target-month
 * clamp still guards month-boundary drift. A portfolio younger than the span
 * is fine — the slice just returns fewer points; the caller renders what it
 * has (never a crash, never a broken empty chart — V4-P0 acceptance).
 */
export function rangeCutoffIso(
  range: Exclude<PortfolioHistoryRange, 'MAX'>,
  today: string,
): string {
  if (range === '1D') return daysBefore(today, 1);
  if (range === '1W') return daysBefore(today, 7);
  return monthsBefore(today, RANGE_MONTHS[range]);
}

/** Calendar day `days` before `today` (ISO `YYYY-MM-DD`), UTC. Exported for tests. */
export function daysBefore(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

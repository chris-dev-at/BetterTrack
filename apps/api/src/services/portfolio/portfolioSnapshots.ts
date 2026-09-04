import type {
  HistoryRange,
  PortfolioHistoryOverlay,
  PricePoint as ProviderPricePoint,
} from '@bettertrack/contracts';

import type {
  CashMovementRecord,
  CashMovementRepository,
} from '../../data/repositories/cashMovementRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type {
  NewSnapshotRow,
  PortfolioSnapshotRepository,
  SnapshotRowRecord,
} from '../../data/repositories/portfolioSnapshotRepository';
import type {
  TransactionRecord,
  TransactionRepository,
} from '../../data/repositories/transactionRepository';
import {
  cashBalance,
  cashBySourceOverTime,
  externalCashFlowsForTwr,
  netWorthSeries,
  type SourcedCashMovement,
} from '../../domain/cashLedger';
import {
  costBasisOverTime,
  dailyCloseSeries,
  netFlowsOverTime,
  valueOverTime,
  type FlowPoint,
  type PricePoint,
  type Transaction as DomainTransaction,
  type ValueOverTimeAsset,
  type ValuePoint,
} from '../../domain/holdings';
import type { Logger } from '../../logger';
import { isNotFoundError, rangeStartMs, type MarketDataService } from '../../providers';
import { FxRateUnavailableError, type CurrencyService } from '../currency/currencyService';
import { daysBefore } from './portfolioService';

/**
 * Per-portfolio daily snapshots (PROJECTPLAN §13.5 V5-P1 arc a, issue #553,
 * invalidation rules §16 2026-07-17).
 *
 * This module owns the ONE value-series engine — the exact computation the
 * portfolio service ran per read until V5-P1 — and gives it two uses:
 *
 *  1. **Writer**: {@link PortfolioSnapshotService.recompute} runs the engine
 *     and persists one row per (portfolio, calendar day) through *yesterday*
 *     into `portfolio_daily_snapshots` (value, cost basis, P/L, TWR flow,
 *     per-source cash split, per-asset values).
 *  2. **Fallback**: when the snapshot state is invalid (dirty, or the nightly
 *     roll hasn't reached yesterday yet), {@link PortfolioSnapshotService.getSeries}
 *     serves the engine's output directly and opportunistically refills the
 *     missing rows — reads are correct regardless of job timing.
 *
 * On the snapshot path, historical days come straight from the rows and the
 * live **"today" point is always computed fresh** from current quotes (falling
 * back to the last stored close, mirroring the engine's carry-forward), never
 * persisted — a quote change reflects immediately with zero snapshot writes.
 *
 * Invalidation is **direct service calls**, not the event bus: the bus is
 * at-most-once fan-out, and snapshot invalidation is a money-path correctness
 * invariant. Every history-mutating write calls
 * {@link PortfolioSnapshotService.invalidate} with its earliest affected day,
 * which synchronously marks the state dirty and deletes the affected rows —
 * earlier days stay untouched — then best-effort enqueues a recompute.
 */

export interface PortfolioSnapshotServiceDeps {
  snapshotRepo: PortfolioSnapshotRepository;
  portfolioRepo: PortfolioRepository;
  transactionRepo: TransactionRepository;
  cashMovementRepo: CashMovementRepository;
  marketData: MarketDataService;
  currencyService: CurrencyService;
  /**
   * Durable recompute trigger (production: enqueue `snapshots.recompute`).
   * Absent under test / in processes without queues — the read path's lazy
   * refill covers correctness either way; the job only accelerates it.
   */
  requestRecompute?: (portfolioId: string) => Promise<void>;
  /** Fail-safe for stale reads/jobs after a user enters paranoid mode. */
  isParanoidPortfolio?: (portfolioId: string) => Promise<boolean>;
  /** Hold the account transition lock across each snapshot write path. */
  runIfAllowedPortfolio?: (portfolioId: string, action: () => Promise<void>) => Promise<boolean>;
  logger?: Logger;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

/** One asset's EUR value series (the analytics feed, V3-P9 semantics). */
export interface PortfolioSeriesAsset {
  assetId: string;
  points: ValuePoint[];
}

/** The full series payload the portfolio service builds its responses from. */
export interface PortfolioSeries {
  /** Net-worth curve (#311), daily, ending at the fresh "today" point. */
  points: ValuePoint[];
  /** External TWR flows (sparse), including today's. */
  flows: FlowPoint[];
  /** Per-asset EUR value series, in first-transaction order. */
  assets: PortfolioSeriesAsset[];
  /** True when historical days were served from snapshot rows (probe/tests). */
  fromSnapshots: boolean;
  /**
   * The two ledgers this series was computed from, as read (#1120 review).
   * Handed back so the intraday path can place trades and cash movements at
   * their instants without issuing the same two unbounded queries a second
   * time on the hottest read in V5-P1.
   */
  transactions: readonly TransactionRecord[];
  cashMovements: readonly CashMovementRecord[];
}

export interface RecomputeOptions {
  /**
   * Rows on/after this day overwrite existing ones — the nightly roll's
   * trailing self-heal window for provider close revisions. Omit for
   * insert-missing-only (the on-demand/refill mode: earlier days untouched).
   */
  healFrom?: string | null;
}

export interface PortfolioSnapshotService {
  /**
   * The portfolio's series: snapshot rows + fresh today when the state is
   * valid, the live engine (with opportunistic refill) otherwise.
   */
  getSeries(portfolioId: string): Promise<PortfolioSeries>;
  /**
   * The #122 per-asset overlay price series. Not persisted — overlays are
   * price curves, already durable in `price_history` + the §5.3 provider
   * cache; recomputing them is a cache read, not a value-engine run.
   */
  getOverlays(portfolioId: string): Promise<PortfolioHistoryOverlay[]>;
  /**
   * Invalidate from `fromDay` (§16 2026-07-17): mark dirty, delete the rows on
   * or after it (earlier days untouched), and trigger the durable recompute.
   */
  invalidate(portfolioId: string, fromDay: string): Promise<void>;
  /**
   * Invalidate every portfolio transacting `assetId` — custom-asset value
   * point / smoothing changes reshape each holder's series from
   * `max(fromDay, that portfolio's first transaction on the asset)`. Call it
   * AFTER the change is committed (the recompute it triggers must see it).
   */
  invalidateForAsset(assetId: string, fromDay?: string): Promise<void>;
  /**
   * The portfolios currently transacting `assetId` + each one's first
   * transaction day. For writes that DESTROY the reference (custom-asset
   * deletion cascades the transactions away): resolve before the delete,
   * {@link PortfolioSnapshotService.invalidate} each ref after it commits.
   */
  resolveAssetReferences(assetId: string): Promise<Array<{ portfolioId: string; fromDay: string }>>;
  /**
   * The snapshot-state watermark (`updated_at`) for `portfolioId`, or null when
   * no state row exists yet. Bumps on every history-invalidating write and on
   * each recompute (issue #553), so it is the freshness source the conditional
   * read layer (issue #555) hangs `Last-Modified` on. Ownership is the caller's
   * concern — this is a raw metadata read.
   */
  getStateUpdatedAt(portfolioId: string): Promise<Date | null>;
  /** Run the engine and persist rows through yesterday. */
  recompute(portfolioId: string, opts?: RecomputeOptions): Promise<void>;
  /**
   * Recompute every portfolio with history (the backfill / nightly roll).
   * Failures are collected per portfolio, never aborting the sweep.
   */
  recomputeAll(opts?: RecomputeOptions): Promise<{ total: number; failures: string[] }>;
}

/**
 * Left-edge margin when picking the provider history window: the series starts
 * at the first transaction day, which may be a weekend/market holiday, so the
 * window must reach back far enough that a prior close exists to carry forward.
 */
const SERIES_EDGE_MARGIN_DAYS = 7;

const SERIES_RANGE_LADDER: ReadonlyArray<'1M' | '6M' | '1Y' | '5Y'> = ['1M', '6M', '1Y', '5Y'];

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

/** Map a stored transaction row into the pure-domain transaction shape. */
function recordToDomain(r: TransactionRecord): DomainTransaction {
  return {
    assetId: r.assetId,
    side: r.side,
    quantity: r.quantity,
    price: r.price,
    fee: r.fee,
    executedAt: r.executedAt.toISOString(),
    allowUncovered: r.allowUncovered,
    uncoveredEntryPrice: r.uncoveredEntryPrice,
  };
}

/** Map a stored cash-movement row into the pure-domain movement shape. */
function toDomainMovement(r: CashMovementRecord): SourcedCashMovement {
  return {
    kind: r.kind,
    amountEur: r.amountEur,
    occurredAt: r.executedAt.toISOString(),
    sourceId: r.sourceId,
  };
}

/** One asset row as the portfolio repository returns it. */
type AssetRecord = Awaited<ReturnType<PortfolioRepository['assetsByIds']>>[number];

/** How deep {@link fxProbeFailure} walks an error's `cause` chain. */
const FX_CAUSE_DEPTH = 4;

/**
 * Why a currency failed the §5.4 convertibility probe.
 *
 *  - `unconvertible` — a property of the CURRENCY: the provider positively
 *    answers "no such symbol" for its `EUR{ccy}=X` pair, or the code itself is
 *    not convertible money. Dropping the asset is the permanent, correct answer
 *    and the run it produces is a faithful computation.
 *  - `unavailable` — a property of the MOMENT: {@link FxRateUnavailableError}
 *    from an outage past the stale window, a spot quote older than the bound, or
 *    no close near the date. The same probe will succeed once FX recovers, so
 *    the artifacts it yields are degraded and must never be frozen into the
 *    snapshot table as a clean computation.
 */
function fxProbeFailure(err: unknown): 'unavailable' | 'unconvertible' {
  if (!(err instanceof FxRateUnavailableError)) return 'unconvertible';
  let cause: unknown = err.cause;
  for (let depth = 0; depth < FX_CAUSE_DEPTH && cause != null; depth += 1) {
    if (isNotFoundError(cause)) return 'unconvertible';
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return 'unavailable';
}

/** Everything one engine run produces — the writer persists, the fallback serves. */
interface EngineArtifacts {
  today: string;
  /**
   * At least one currency dropped out of the run because FX was UNAVAILABLE
   * rather than unconvertible ({@link fxProbeFailure}). The artifacts are still
   * served — the reader sees what is priceable right now — but they are not a
   * faithful computation and {@link persist} refuses to write them.
   */
  fxUnavailable: boolean;
  /** The ledgers the run read, handed to the caller (see {@link PortfolioSeries}). */
  txns: TransactionRecord[];
  cashRecords: CashMovementRecord[];
  points: ValuePoint[];
  flows: FlowPoint[];
  perAsset: PortfolioSeriesAsset[];
  holdingsByDate: Map<string, number>;
  costBasisByDate: Map<string, number>;
  cashByDate: Map<string, ReadonlyMap<string, number>>;
}

/** The no-history payload: empty curves and empty ledgers. */
function emptySeries(): PortfolioSeries {
  return {
    points: [],
    flows: [],
    assets: [],
    fromSnapshots: false,
    transactions: [],
    cashMovements: [],
  };
}

export function createPortfolioSnapshotService(
  deps: PortfolioSnapshotServiceDeps,
): PortfolioSnapshotService {
  const {
    snapshotRepo,
    portfolioRepo,
    transactionRepo,
    cashMovementRepo,
    marketData,
    currencyService,
    requestRecompute,
    logger,
  } = deps;
  const now = deps.now ?? Date.now;
  const baseCurrency = currencyService.baseCurrency;

  /** Today's UTC calendar day — the always-fresh last point of every series. */
  function todayIso(): string {
    return new Date(now()).toISOString().slice(0, 10);
  }

  /**
   * The transacted asset universe behind the engine's §5.4 convertibility
   * gate: every distinct transacted asset's row, plus the subset whose
   * currency converts to base as of `today` (probed once per currency;
   * unconvertible assets degrade out exactly like the overview). Shared by
   * the full engine and the fresh "today" leg so both agree on the universe —
   * persisted rows can never define it, because an asset first transacted
   * today appears in no row yet.
   *
   * A failed probe also reports WHY (`fxUnavailable`): the same drop means
   * "this currency has no market" on one day and "the FX provider is down" on
   * the next, and only the first may be persisted (see {@link fxProbeFailure}).
   */
  async function resolveUsableAssets(
    txns: readonly TransactionRecord[],
    today: string,
  ): Promise<{
    assetsById: Map<string, AssetRecord>;
    usableAssetIds: string[];
    usableIdSet: Set<string>;
    fxUnavailable: boolean;
  }> {
    const assetIds = [...new Set(txns.map((t) => t.assetId))];
    const assetsById = new Map((await portfolioRepo.assetsByIds(assetIds)).map((r) => [r.id, r]));

    const convertible = new Map<string, boolean>();
    let fxUnavailable = false;
    for (const asset of assetsById.values()) {
      const ccy = asset.currency;
      if (ccy === baseCurrency || convertible.has(ccy)) continue;
      try {
        await currencyService.toBase(1, ccy, { date: today });
        convertible.set(ccy, true);
      } catch (err) {
        convertible.set(ccy, false);
        if (fxProbeFailure(err) === 'unavailable') {
          fxUnavailable = true;
          logger?.warn({ err, currency: ccy }, 'FX unavailable for snapshot convertibility probe');
        }
      }
    }
    const isConvertible = (ccy: string): boolean =>
      ccy === baseCurrency || convertible.get(ccy) === true;

    const usableAssetIds = assetIds.filter((id) => {
      const asset = assetsById.get(id);
      return asset !== undefined && isConvertible(asset.currency);
    });
    return { assetsById, usableAssetIds, usableIdSet: new Set(usableAssetIds), fxUnavailable };
  }

  /**
   * Assemble each transacted, EUR-convertible asset's merged, smoothing-aware
   * daily price series (§5.2/§5.3): stored `price_history` rows as the durable
   * fallback layer, overlaid with each asset's real daily market history
   * (custom assets route through the manual provider via the exact same call,
   * so V3-P2 value-smoothing is applied transparently). Unconvertible non-base
   * currencies are probed once and their assets dropped from the series — the
   * same degrade the overview applies (§5.4). Assumes `txns` is non-empty.
   */
  async function buildValueAssets(
    txns: TransactionRecord[],
    today: string,
  ): Promise<{
    assetsById: Map<string, AssetRecord>;
    valueAssets: ValueOverTimeAsset[];
    usableAssetIds: string[];
    usableIdSet: Set<string>;
    firstTxnDay: string;
    fxUnavailable: boolean;
  }> {
    const { assetsById, usableAssetIds, usableIdSet, fxUnavailable } = await resolveUsableAssets(
      txns,
      today,
    );
    const firstTxnDay = txns
      .map((t) => t.executedAt.toISOString().slice(0, 10))
      .reduce((a, b) => (a < b ? a : b));

    if (usableAssetIds.length === 0) {
      return {
        assetsById,
        valueAssets: [],
        usableAssetIds,
        usableIdSet,
        firstTxnDay,
        fxUnavailable,
      };
    }

    const priceRows = await portfolioRepo.pricesForAssets(usableAssetIds);
    const storedByAsset = new Map<string, PricePoint[]>();
    for (const row of priceRows) {
      const list = storedByAsset.get(row.assetId);
      const point: PricePoint = { date: row.date, close: row.close };
      if (list) list.push(point);
      else storedByAsset.set(row.assetId, [point]);
    }

    // The primary layer is each asset's real daily history through the
    // market-data keystone (cached, coalesced, serve-stale). Best-effort per
    // asset: an outage past the stale window degrades that asset to its stored
    // rows above — the chart renders what is available.
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

    return { assetsById, valueAssets, usableAssetIds, usableIdSet, firstTxnDay, fxUnavailable };
  }

  /**
   * The transactions whose money never crossed the portfolio boundary because
   * they were settled against the cash ledger — a `buy` paid from cash or a
   * `sell` whose proceeds were booked into cash. Their external flow was
   * recorded when that cash entered/left the ledger, so counting the
   * transaction again would double it (#125).
   *
   * **Only `buy` / `sell_proceeds` legs qualify.** A transaction can carry other
   * linked movements — a V3-P4 `tax_withholding` / `tax_refund` settlement rides
   * on its sell's `transactionId` (§16 2026-07-08) — and those say nothing about
   * where the proceeds went. Keying on "has *any* linked movement" suppressed
   * the outflow of a taxed sell that paid out instead of into cash, while the
   * holdings still left the value curve: a phantom loss the user never took.
   */
  function cashSettledTxnIds(cashRecords: readonly CashMovementRecord[]): Set<string> {
    const ids = new Set<string>();
    for (const r of cashRecords) {
      if (r.transactionId === null) continue;
      if (r.kind === 'buy' || r.kind === 'sell_proceeds') ids.add(r.transactionId);
    }
    return ids;
  }

  /**
   * Backdated pay-from-cash buys settled as of a later day (#378): a linked
   * `buy` movement whose day differs from its transaction's day. Their TWR
   * compensator flow pair (+cost on the buy day, −cost on the settle day)
   * keeps both days flow-explained; see the portfolio service's history docs.
   */
  function deriveSplitCashBuys(
    txns: readonly TransactionRecord[],
    cashRecords: readonly CashMovementRecord[],
  ): Array<{ txnId: string; buyDay: string; settleDay: string; amountEur: number }> {
    const txnDayById = new Map(txns.map((t) => [t.id, t.executedAt.toISOString().slice(0, 10)]));
    return cashRecords.flatMap((r) => {
      if (r.kind !== 'buy' || r.transactionId === null) return [];
      const buyDay = txnDayById.get(r.transactionId);
      const settleDay = r.executedAt.toISOString().slice(0, 10);
      if (buyDay === undefined || buyDay === settleDay) return [];
      return [{ txnId: r.transactionId, buyDay, settleDay, amountEur: r.amountEur }];
    });
  }

  /**
   * ONE full engine run — exactly the computation the portfolio service ran
   * per read until V5-P1, extended with the per-asset breakdown (the V3-P9
   * analytics pipeline), the daily cost basis and the per-source cash split.
   * Returns `null` for a portfolio with no history at all.
   */
  async function computeArtifacts(portfolioId: string): Promise<EngineArtifacts | null> {
    const [txns, cashRecords] = await Promise.all([
      transactionRepo.listForPortfolio(portfolioId),
      cashMovementRepo.listForPortfolio(portfolioId),
    ]);
    if (txns.length === 0 && cashRecords.length === 0) return null;

    const today = todayIso();
    const movements = cashRecords.map(toDomainMovement);
    const linkedTxnIds = cashSettledTxnIds(cashRecords);
    const splitCashBuys = deriveSplitCashBuys(txns, cashRecords);

    let holdingsPoints: ValuePoint[] = [];
    let flows: FlowPoint[] = [];
    let perAsset: PortfolioSeriesAsset[] = [];
    let costBasis: Awaited<ReturnType<typeof costBasisOverTime>> = [];
    let fxUnavailable = false;

    if (txns.length > 0) {
      const {
        valueAssets,
        usableIdSet,
        fxUnavailable: fxDown,
      } = await buildValueAssets(txns, today);
      fxUnavailable = fxDown;
      if (valueAssets.length > 0) {
        const usableRecords = txns.filter((t) => usableIdSet.has(t.assetId));
        const usableTxns = usableRecords.map(recordToDomain);

        // The overview curve is the JOINT valueOverTime pass (legacy-exact);
        // the per-asset series are one pass per asset (the V3-P9 analytics
        // pipeline, legacy-exact there). valueOverTime is linear in its
        // assets, so the two views agree up to FP associativity.
        holdingsPoints = await valueOverTime({
          transactions: usableTxns,
          assets: valueAssets,
          today,
          converter: currencyService,
        });
        const txnsByAsset = new Map<string, DomainTransaction[]>();
        for (const t of usableRecords) {
          const list = txnsByAsset.get(t.assetId);
          const domain = recordToDomain(t);
          if (list) list.push(domain);
          else txnsByAsset.set(t.assetId, [domain]);
        }
        perAsset = [];
        for (const valueAsset of valueAssets) {
          const assetTxns = txnsByAsset.get(valueAsset.assetId) ?? [];
          const points = await valueOverTime({
            transactions: assetTxns,
            assets: [valueAsset],
            today,
            converter: currencyService,
          });
          perAsset.push({ assetId: valueAsset.assetId, points });
        }

        // External transaction flows (#125): cash-funded transactions are
        // internal conversions and excluded (their external flow was booked
        // when the cash entered the ledger).
        flows = await netFlowsOverTime({
          transactions: usableRecords.filter((t) => !linkedTxnIds.has(t.id)).map(recordToDomain),
          currencyByAsset: new Map(valueAssets.map((a) => [a.assetId, a.currency])),
          converter: currencyService,
        });
        // TWR neutraliser for backdated buys settled later (#378).
        const txnAssetById = new Map(txns.map((t) => [t.id, t.assetId]));
        for (const split of splitCashBuys) {
          const assetId = txnAssetById.get(split.txnId);
          if (assetId === undefined || !usableIdSet.has(assetId)) continue;
          flows.push({ date: split.buyDay, flowEur: -split.amountEur });
          flows.push({ date: split.settleDay, flowEur: split.amountEur });
        }

        costBasis = await costBasisOverTime({
          transactions: usableTxns,
          assets: valueAssets,
          today,
          converter: currencyService,
        });
      }
    }

    const points = netWorthSeries({ holdingsValues: holdingsPoints, movements, today });
    const allFlows = [...flows, ...externalCashFlowsForTwr(movements)];

    const cashByDate = new Map<string, ReadonlyMap<string, number>>();
    for (const point of cashBySourceOverTime(movements, today)) {
      cashByDate.set(point.date, point.balances);
    }

    return {
      today,
      fxUnavailable,
      txns,
      cashRecords,
      points,
      flows: allFlows,
      perAsset,
      holdingsByDate: new Map(holdingsPoints.map((p) => [p.date, p.valueEur])),
      costBasisByDate: new Map(costBasis.map((p) => [p.date, p.costBasisEur])),
      cashByDate,
    };
  }

  /** Artifacts → persistable rows for every day strictly before today. */
  function buildRows(artifacts: EngineArtifacts): NewSnapshotRow[] {
    const flowsByDate = new Map<string, number>();
    for (const flow of artifacts.flows) {
      flowsByDate.set(flow.date, (flowsByDate.get(flow.date) ?? 0) + flow.flowEur);
    }
    const assetValuesByDate = new Map<string, Record<string, number>>();
    for (const asset of artifacts.perAsset) {
      for (const point of asset.points) {
        let bucket = assetValuesByDate.get(point.date);
        if (!bucket) {
          bucket = {};
          assetValuesByDate.set(point.date, bucket);
        }
        bucket[asset.assetId] = point.valueEur;
      }
    }

    return artifacts.points
      .filter((p) => p.date < artifacts.today)
      .map((p) => {
        const holdingsValue = artifacts.holdingsByDate.get(p.date) ?? 0;
        const costBasisEur = artifacts.costBasisByDate.get(p.date) ?? 0;
        const cash = artifacts.cashByDate.get(p.date);
        return {
          date: p.date,
          valueEur: p.valueEur,
          costBasisEur,
          plEur: holdingsValue - costBasisEur,
          flowEur: flowsByDate.get(p.date) ?? 0,
          cashBySource: cash ? Object.fromEntries(cash) : {},
          assetValues: assetValuesByDate.get(p.date) ?? {},
        };
      });
  }

  /**
   * Persist an engine run.
   *
   * `raced` means an invalidation landed mid-compute; `degraded` means FX was
   * unavailable for at least one currency, so the artifacts are missing whole
   * assets from the WHOLE history (value, cost basis and external flows alike).
   * Writing those rows would freeze a provider outage into the table and clear
   * `dirty_from` on top of it — and since the nightly roll only overwrites the
   * trailing heal window, every older day would stay wrong forever. The read
   * path still serves the degraded artifacts (best available right now) and the
   * state stays dirty, so the next run after FX recovers rewrites the range.
   */
  async function persist(
    portfolioId: string,
    artifacts: EngineArtifacts,
    seen: { version: string | null; dirtyFrom: string | null },
    healFrom: string | null,
  ): Promise<{ applied: boolean; reason?: 'raced' | 'degraded' }> {
    if (artifacts.fxUnavailable) {
      logger?.warn(
        { portfolioId },
        'snapshot persist skipped: FX unavailable, engine run degraded',
      );
      return { applied: false, reason: 'degraded' };
    }
    const result = await snapshotRepo.saveComputation({
      portfolioId,
      rows: buildRows(artifacts),
      computedThrough: daysBefore(artifacts.today, 1),
      seenVersion: seen.version,
      seenDirtyFrom: seen.dirtyFrom,
      healFrom,
    });
    return result.applied ? { applied: true } : { applied: false, reason: 'raced' };
  }

  /**
   * The fresh "today" leg on the snapshot path. Per-asset value = the same
   * engine formula (`valueOverTime`) fed a single price point: the live quote,
   * or the last stored close when the quote is unavailable — the engine's
   * carry-forward, sourced without a provider history call. An asset whose
   * price or FX is unavailable carries its last snapshotted value forward.
   */
  async function computeTodayLeg(
    txns: TransactionRecord[],
    cashRecords: CashMovementRecord[],
    rows: SnapshotRowRecord[],
    today: string,
  ): Promise<{
    todayPoint: ValuePoint;
    todayFlows: FlowPoint[];
    assetValuesToday: Map<string, number>;
  }> {
    const lastRow = rows[rows.length - 1];
    // The universe comes from the TRANSACTIONS behind the engine's own
    // convertibility gate — never from yesterday's row keys: an asset first
    // transacted today appears in no persisted row, yet must be valued and
    // flow-counted, or a cash-funded first buy reads as a phantom drop of the
    // whole position until the nightly roll. Assets that carry row values but
    // fail today's FX probe stay valued via the carry-forward below.
    const { assetsById, usableAssetIds, usableIdSet } = await resolveUsableAssets(txns, today);
    const carriedOnlyIds = Object.keys(lastRow?.assetValues ?? {}).filter(
      (id) => !usableIdSet.has(id),
    );
    const valuedAssetIds = [...usableAssetIds, ...carriedOnlyIds];

    // Live quotes first (coalesced, cheap); stored last closes only for the
    // assets whose quote degraded.
    const quoteByAsset = new Map<string, number>();
    await Promise.all(
      valuedAssetIds.map(async (assetId) => {
        const asset = assetsById.get(assetId);
        if (!asset) return;
        try {
          const cached = await marketData.getQuote({
            providerId: asset.providerId,
            providerRef: asset.providerRef,
          });
          if (Number.isFinite(cached.value.price)) quoteByAsset.set(assetId, cached.value.price);
        } catch {
          // Degrades to the stored-close fallback below.
        }
      }),
    );
    const missingQuote = valuedAssetIds.filter((id) => !quoteByAsset.has(id));
    const storedCloses = await portfolioRepo.latestClosesForAssets(missingQuote);

    const assetValuesToday = new Map<string, number>();
    for (const assetId of valuedAssetIds) {
      const asset = assetsById.get(assetId);
      const price = quoteByAsset.get(assetId) ?? storedCloses.get(assetId);
      const carried = lastRow?.assetValues[assetId] ?? 0;
      if (!asset || price === undefined) {
        assetValuesToday.set(assetId, carried);
        continue;
      }
      const assetTxns = txns.filter((t) => t.assetId === assetId).map(recordToDomain);
      try {
        const points = await valueOverTime({
          transactions: assetTxns,
          assets: [{ assetId, currency: asset.currency, prices: [{ date: today, close: price }] }],
          today,
          converter: currencyService,
        });
        const last = points[points.length - 1];
        assetValuesToday.set(
          assetId,
          last !== undefined && last.date === today ? last.valueEur : carried,
        );
      } catch {
        // FX unavailable right now — carry yesterday's value rather than 500.
        assetValuesToday.set(assetId, carried);
      }
    }

    const movements = cashRecords.map(toDomainMovement);
    const cashToday = cashBalance(movements.filter((m) => m.occurredAt.slice(0, 10) <= today));
    let holdingsToday = 0;
    for (const value of assetValuesToday.values()) holdingsToday += value;

    // Today's TWR flows, assembled from the same three legs the engine books:
    // external ledger flows, unlinked transaction flows, #378 compensators.
    const todayFlows: FlowPoint[] = externalCashFlowsForTwr(movements).filter(
      (f) => f.date === today,
    );
    const linkedTxnIds = cashSettledTxnIds(cashRecords);
    const todayTxns = txns.filter(
      (t) =>
        t.executedAt.toISOString().slice(0, 10) === today &&
        usableIdSet.has(t.assetId) &&
        !linkedTxnIds.has(t.id),
    );
    if (todayTxns.length > 0) {
      const currencyByAsset = new Map<string, string>();
      for (const [id, asset] of assetsById) currencyByAsset.set(id, asset.currency);
      todayFlows.push(
        ...(await netFlowsOverTime({
          transactions: todayTxns.map(recordToDomain),
          currencyByAsset,
          converter: currencyService,
        })),
      );
    }
    const txnAssetById = new Map(txns.map((t) => [t.id, t.assetId]));
    for (const split of deriveSplitCashBuys(txns, cashRecords)) {
      const assetId = txnAssetById.get(split.txnId);
      if (assetId === undefined || !usableIdSet.has(assetId)) continue;
      if (split.buyDay === today)
        todayFlows.push({ date: split.buyDay, flowEur: -split.amountEur });
      if (split.settleDay === today) {
        todayFlows.push({ date: split.settleDay, flowEur: split.amountEur });
      }
    }

    return {
      todayPoint: { date: today, valueEur: holdingsToday + cashToday },
      todayFlows,
      assetValuesToday,
    };
  }

  /** Snapshot rows + fresh today → the served series payload. */
  async function reconstruct(
    txns: TransactionRecord[],
    cashRecords: CashMovementRecord[],
    rows: SnapshotRowRecord[],
    today: string,
  ): Promise<PortfolioSeries> {
    const { todayPoint, todayFlows, assetValuesToday } = await computeTodayLeg(
      txns,
      cashRecords,
      rows,
      today,
    );

    const points: ValuePoint[] = rows.map((r) => ({ date: r.date, valueEur: r.valueEur }));
    points.push(todayPoint);

    const flows: FlowPoint[] = rows
      .filter((r) => r.flowEur !== 0)
      .map((r) => ({ date: r.date, flowEur: r.flowEur }));
    flows.push(...todayFlows);

    // Per-asset series in first-transaction order (the legacy analytics order).
    const orderedAssetIds: string[] = [];
    const seen = new Set<string>();
    for (const t of txns) {
      if (!seen.has(t.assetId) && assetValuesToday.has(t.assetId)) {
        seen.add(t.assetId);
        orderedAssetIds.push(t.assetId);
      }
    }
    const assets: PortfolioSeriesAsset[] = orderedAssetIds.map((assetId) => {
      const assetPoints: ValuePoint[] = [];
      for (const row of rows) {
        const value = row.assetValues[assetId];
        if (value !== undefined) assetPoints.push({ date: row.date, valueEur: value });
      }
      assetPoints.push({ date: today, valueEur: assetValuesToday.get(assetId) ?? 0 });
      return { assetId, points: assetPoints };
    });

    return {
      points,
      flows,
      assets,
      fromSnapshots: true,
      transactions: txns,
      cashMovements: cashRecords,
    };
  }

  async function invalidate(portfolioId: string, fromDay: string): Promise<void> {
    const apply = async () => {
      if (await deps.isParanoidPortfolio?.(portfolioId)) return;
      // Dirty marker BEFORE the row delete: a reader that interleaves sees the
      // marker and falls back to the engine rather than serving a gap.
      await snapshotRepo.markDirty(portfolioId, fromDay);
      await snapshotRepo.deleteFrom(portfolioId, fromDay);
      if (requestRecompute) {
        try {
          await requestRecompute(portfolioId);
        } catch (err) {
          // The read path's lazy refill covers correctness; log and move on.
          logger?.warn({ err, portfolioId }, 'snapshot recompute enqueue failed');
        }
      }
    };
    if (deps.runIfAllowedPortfolio) {
      await deps.runIfAllowedPortfolio(portfolioId, apply);
    } else {
      await apply();
    }
  }

  async function recompute(portfolioId: string, opts: RecomputeOptions = {}): Promise<void> {
    const apply = async () => {
      if (await deps.isParanoidPortfolio?.(portfolioId)) return;
      const state = await snapshotRepo.getState(portfolioId);
      const artifacts = await computeArtifacts(portfolioId);
      if (artifacts === null) {
        // History vanished entirely (last transaction/movement deleted).
        await snapshotRepo.clear(portfolioId);
        return;
      }
      const result = await persist(
        portfolioId,
        artifacts,
        { version: state?.version ?? null, dirtyFrom: state?.dirtyFrom ?? null },
        opts.healFrom ?? null,
      );
      if (!result.applied) {
        logger?.info(
          { portfolioId, reason: result.reason },
          result.reason === 'degraded'
            ? 'snapshot recompute degraded by unavailable FX; left dirty for a later run'
            : 'snapshot recompute raced an invalidation; skipped persist',
        );
      }
    };
    if (deps.runIfAllowedPortfolio) {
      await deps.runIfAllowedPortfolio(portfolioId, apply);
    } else {
      await apply();
    }
  }

  return {
    async getSeries(portfolioId) {
      if (await deps.isParanoidPortfolio?.(portfolioId)) {
        return emptySeries();
      }
      // State FIRST: everything computed after this read is at least as fresh,
      // so the persist CAS can reject any computation an invalidation raced.
      const state = await snapshotRepo.getState(portfolioId);
      const [txns, cashRecords] = await Promise.all([
        transactionRepo.listForPortfolio(portfolioId),
        cashMovementRepo.listForPortfolio(portfolioId),
      ]);
      if (txns.length === 0 && cashRecords.length === 0) {
        if (state !== null) {
          // Stale leftovers from a fully-emptied history — best-effort sweep.
          await snapshotRepo.clear(portfolioId).catch(() => undefined);
        }
        return emptySeries();
      }

      const today = todayIso();
      const yesterday = daysBefore(today, 1);
      if (state !== null && state.dirtyFrom === null && state.computedThrough >= yesterday) {
        const rows = await snapshotRepo.listForPortfolio(portfolioId);
        // Zero rows with live events means the whole history started today —
        // serve that via the engine below instead of guessing usable assets.
        if (rows.length > 0) {
          // The rows were read AFTER the state: an invalidation landing between
          // the two reads has already deleted its tail, so the rows would be
          // served gappy. Re-read the state and trust the rows only when
          // nothing moved; otherwise fall through to the engine (whose persist
          // CAS fails against the bumped state — correct either way).
          const recheck = await snapshotRepo.getState(portfolioId);
          if (recheck !== null && recheck.dirtyFrom === null && recheck.version === state.version) {
            return reconstruct(txns, cashRecords, rows, today);
          }
        }
      }

      // Fallback: the live engine (identical math), refilled opportunistically
      // so the next read hits the snapshot path. A failed persist never fails
      // the read.
      const artifacts = await computeArtifacts(portfolioId);
      if (artifacts === null) return emptySeries();
      try {
        await persist(
          portfolioId,
          artifacts,
          { version: state?.version ?? null, dirtyFrom: state?.dirtyFrom ?? null },
          null,
        );
      } catch (err) {
        logger?.warn({ err, portfolioId }, 'snapshot refill failed; served engine output');
      }
      return {
        points: artifacts.points,
        flows: artifacts.flows,
        assets: artifacts.perAsset,
        fromSnapshots: false,
        transactions: artifacts.txns,
        cashMovements: artifacts.cashRecords,
      };
    },

    async getOverlays(portfolioId) {
      if (await deps.isParanoidPortfolio?.(portfolioId)) return [];
      const txns = await transactionRepo.listForPortfolio(portfolioId);
      if (txns.length === 0) return [];
      const today = todayIso();
      const { assetsById, valueAssets, firstTxnDay } = await buildValueAssets(txns, today);
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
      return overlays;
    },

    invalidate,

    async getStateUpdatedAt(portfolioId) {
      const state = await snapshotRepo.getState(portfolioId);
      return state?.updatedAt ?? null;
    },

    async resolveAssetReferences(assetId) {
      const refs = await snapshotRepo.portfoliosReferencingAsset(assetId);
      return refs.map((ref) => ({ portfolioId: ref.portfolioId, fromDay: ref.firstTxnDay }));
    },

    async invalidateForAsset(assetId, fromDay) {
      const refs = await snapshotRepo.portfoliosReferencingAsset(assetId);
      for (const ref of refs) {
        // A price change before the first transaction still reshapes the close
        // carried INTO that first day, so the floor is the first-txn day.
        const from = fromDay !== undefined && fromDay > ref.firstTxnDay ? fromDay : ref.firstTxnDay;
        await invalidate(ref.portfolioId, from);
      }
    },

    recompute,

    async recomputeAll(opts = {}) {
      const targets = await snapshotRepo.listSnapshotTargets();
      const failures: string[] = [];
      for (const target of targets) {
        try {
          await recompute(target.portfolioId, opts);
        } catch (err) {
          failures.push(target.portfolioId);
          logger?.warn(
            { err, portfolioId: target.portfolioId },
            'snapshot recompute failed for portfolio',
          );
        }
      }
      return { total: targets.length, failures };
    },
  };
}

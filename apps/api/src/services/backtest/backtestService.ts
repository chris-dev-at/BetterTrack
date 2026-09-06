import { createHash } from 'node:crypto';

import type {
  BacktestBenchmark,
  BacktestBenchmarkInput,
  BacktestBenchmarkKind,
  BacktestBenchmarkResult,
  BacktestComparisonResponse,
  BacktestMode,
  BacktestPreviewPosition,
  BacktestPreviewRange,
  BacktestResponse,
  BacktestStats as BacktestStatsDto,
  ComparisonMetrics,
  HistoryRange,
  PricePoint as ProviderPricePoint,
  RebalanceFrequency,
  SharedSandboxAggregateResponse,
  SharedSandboxPreviewResponse,
} from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import type {
  ConglomerateConstituentRow,
  ConglomerateRepository,
} from '../../data/repositories/conglomerateRepository';
import {
  backtest,
  BacktestError,
  type BacktestAsset,
  type BacktestResult,
  type BacktestStats,
} from '../../domain/backtest';
import { compareSeriesStats } from '../../domain/seriesStats';
import { notFound, unprocessable } from '../../errors';
import type { MarketDataService } from '../../providers';
import type { ParanoidModeGuard } from '../account/paranoidEnforcement';
import { flattenConglomerate, mapFlattened } from '../conglomerate/nesting';
import { FxRateUnavailableError, type CurrencyService } from '../currency/currencyService';

/**
 * Backtest preview service (PROJECTPLAN.md §6.5, §6.6).
 *
 * Assembles the inputs the pure {@link backtest} engine consumes and shapes its
 * `BacktestResult` into the wire response — it does not do money-math itself
 * (that all lives in the Fable-hardened `domain/backtest.ts`, unchanged here).
 * It exists so the Builder's live-preview panel can backtest an *unsaved* draft
 * basket over inline positions, and so the saved-conglomerate backtest endpoint
 * (a later issue) can reuse the exact same pipeline.
 *
 * The assembly reuses the portfolio-history pattern (§6.9): per-asset daily
 * closes come from {@link MarketDataService.getHistory} (warm `price_history`,
 * cached/coalesced/serve-stale), and EUR conversion routes exclusively through
 * the {@link CurrencyService} historical FX-at-date keystone (§5.4), injected
 * into the engine as its `CurrencyConverter`.
 *
 * The optional benchmark (V4-P7) — a one-click preset, any catalog asset, or
 * one of the caller's own conglomerates — is a SECOND run of the same engine
 * over the primary's effective window with the same base currency,
 * late-listing mode and rebalance schedule, so its full stat set is
 * apples-to-apples with the primary basket by construction.
 *
 * Results are memoised in Redis for 1 h keyed by hash(positions+range+benchmark)
 * so slider-wiggling in the Builder stays cheap (§6.6). The key is additionally
 * namespaced by user id: the basket may reference the caller's *custom* assets
 * and conglomerates, whose ids resolve only for their owner (§10), so a shared
 * cache must never let one user read another's memoised preview.
 */

const PREVIEW_TTL_SECONDS = 3600; // 1 h (§6.6).
const SHARED_SANDBOX_UNAVAILABLE_MESSAGE =
  'This shared basket can’t be backtested with the selected settings.';

/**
 * Remove every user-scoped memoised result before paranoid mode commits.
 *
 * SCAN keeps this bounded on production Redis; both key families contain
 * private basket composition and computed portfolio-derived results.
 */
export async function purgeBacktestCaches(redis: Redis, userId: string): Promise<void> {
  for (const pattern of [`backtest:preview:${userId}:*`, `backtest:compare:${userId}:*`]) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = String(nextCursor);
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

/** Calendar years back for each finite preview range. */
const RANGE_YEARS: Record<Exclude<BacktestPreviewRange, 'MAX'>, number> = {
  '1Y': 1,
  '3Y': 3,
  '5Y': 5,
};

/**
 * Provider history window to fetch per preview range. Deliberately generous (a
 * 3Y preview pulls the 5Y window) — the engine clips to the requested window,
 * so over-fetching is harmless while under-fetching would silently drop data.
 */
const PROVIDER_RANGE: Record<BacktestPreviewRange, HistoryRange> = {
  '1Y': '1Y',
  '3Y': '5Y',
  '5Y': '5Y',
  MAX: 'MAX',
};

/**
 * Where each one-click preset's prices come from + its native currency (§6.6).
 * Since V4-P7 a preset is sugar over the catalog: it resolves to its catalog
 * asset when seeded, and this spec is only the fallback identity for an
 * unseeded catalog.
 */
interface BenchmarkSpec {
  providerId: string;
  providerRef: string;
  currency: string;
}
const BENCHMARKS: Record<BacktestBenchmark, BenchmarkSpec> = {
  '^GSPC': { providerId: 'yahoo', providerRef: '^GSPC', currency: 'USD' },
  '^GDAXI': { providerId: 'yahoo', providerRef: '^GDAXI', currency: 'EUR' },
  URTH: { providerId: 'yahoo', providerRef: 'URTH', currency: 'USD' },
};

export interface BacktestPreviewInput {
  positions: BacktestPreviewPosition[];
  range: BacktestPreviewRange;
  /** Benchmark choice (V4-P7): exactly one of preset / catalog asset / own conglomerate. */
  benchmark?: BacktestBenchmarkInput | null;
  /** Late-listing mode (§14); defaults to `clip` (the pre-§14 behavior). */
  mode?: BacktestMode;
  /** Rebalance schedule (V4-P7); defaults to `none` (buy-and-hold, today's behavior). */
  rebalance?: RebalanceFrequency;
}

/**
 * N-way conglomerate comparison input (§13.5 V5-P6): a set of the caller's own
 * conglomerate ids (2–6, contract-capped) plus the same window/late-listing/
 * rebalance knobs a single backtest takes. The ids are a SET, not a list: the
 * primary — whose effective window is the shared axis every other series runs
 * over, exactly as a V4-P7 benchmark runs over the primary basket's window — is
 * the canonically FIRST id (sorted), so re-ordering the picker cannot change the
 * chart, the stats or the memo entry (#1755). The response's series order still
 * follows the request. `baselineId` (default: the first requested id) chooses
 * the delta reference only.
 */
export interface BacktestComparisonInput {
  conglomerateIds: string[];
  range: BacktestPreviewRange;
  mode?: BacktestMode;
  rebalance?: RebalanceFrequency;
  baselineId?: string;
}

/**
 * Shared-conglomerate what-if sandbox input (§13.5 V5-P6 arc c): the shared
 * conglomerate the viewer is looking at plus their locally-tweaked TOP-LEVEL
 * weights keyed by an asset constituent's `assetId` or a nested constituent's
 * `childId`. Same window/late-listing/rebalance knobs a single preview takes;
 * no benchmark and no changes to a nested child's internal weights.
 */
export interface BacktestSharedSandboxInput {
  conglomerateId: string;
  positions: Array<{ id: string; weight: number }>;
  range: BacktestPreviewRange;
  mode?: BacktestMode;
  rebalance?: RebalanceFrequency;
}

export interface BacktestServiceDeps {
  assetRepo: AssetRepository;
  conglomerateRepo: ConglomerateRepository;
  marketData: MarketDataService;
  currencyService: CurrencyService;
  redis: Redis;
  /**
   * Share-read authorization for the V5-P6 sandbox (arc c) — the SAME guard the
   * read-only shared conglomerate view uses (the §6.9 audience model): resolves
   * the owner when the viewer may see the basket, else `undefined` (→ 404).
   * Optional so the pure preview/compare paths construct without the social
   * layer; {@link BacktestService.runSharedSandboxPreview} 404s when it is absent.
   */
  authorizeConglomerateRead?: (
    viewerId: string,
    conglomerateId: string,
  ) => Promise<{ ownerId: string } | undefined>;
  /** Hold viewer and shared-item owner through authorization and response construction. */
  paranoid?: Pick<ParanoidModeGuard, 'runAllowedMany' | 'runAllowedWithOptional'>;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

/** A benchmark resolved to a runnable basket plus its wire identity (V4-P7). */
interface ResolvedBenchmark {
  kind: BacktestBenchmarkKind;
  refId: string;
  label: string;
  positions: Array<{ assetId: string; weight: number }>;
  assets: BacktestAsset[];
  /** The benchmark's unresolved share (a conglomerate with an empty child); 0 for an asset. */
  unresolvedPct: number;
}

/**
 * What one of the caller's conglomerates IS, once its nesting is flattened:
 * identity plus the effective asset/weight vector. Derived from the database
 * alone (no provider I/O), which is what lets it address the comparison memo
 * key before any history is fetched.
 */
export interface ConglomerateComposition {
  id: string;
  name: string;
  positions: Array<{ assetId: string; weight: number }>;
  /**
   * The share of the basket that resolved to NO asset, in percent — an empty
   * nested child whose slice the flatten's normalization would otherwise hand
   * to the survivors. `positions` covers only the resolved remainder, so this
   * travels with it to every read path instead of being dropped (#1755).
   */
  unresolvedPct: number;
}

/** One of the caller's conglomerates resolved to a runnable basket (V4-P7 / V5-P6). */
interface ResolvedConglomerateBasket extends ConglomerateComposition {
  assets: BacktestAsset[];
}

/** Scoping flags shared by the two halves of a basket-member load. */
interface BasketAssetOptions {
  globalOnly?: boolean;
  redactIdentity?: boolean;
  hidePrivateAsset?: boolean;
}

/** An authorized basket member, between the two halves of its load. */
type BasketAssetRow = NonNullable<Awaited<ReturnType<AssetRepository['findByIdForUser']>>>;

export interface BacktestService {
  /**
   * Backtest an inline draft basket for the Builder live preview (§6.5),
   * computed in `opts.baseCurrency` (the caller's per-user base, §5.4/V3-P10d;
   * EUR when omitted). The base changes the *result*, not just labels — a USD
   * investor's return on a EUR-priced asset carries the FX leg.
   */
  runPreview(
    userId: string,
    input: BacktestPreviewInput,
    opts?: { baseCurrency?: string },
  ): Promise<BacktestResponse>;

  /**
   * Compare 2–6 of the caller's own conglomerates on one shared window (§13.5
   * V5-P6): each is run through the same engine as the primary (the canonically
   * first id), so every series' stats are apples-to-apples, and the response
   * carries each series' base-100 curve, full stats, unresolved share and
   * per-metric deltas vs `baselineId`, in request order. A conglomerate whose
   * history does not cover the primary's window — starting late OR stopping
   * early — is a 422, the same outcome the V4-P7 overlay produced for a short
   * benchmark.
   */
  runComparison(
    userId: string,
    input: BacktestComparisonInput,
    opts?: { baseCurrency?: string },
  ): Promise<BacktestComparisonResponse>;

  /**
   * Backtest a FRIEND-SHARED conglomerate with the viewer's local weight tweaks
   * for the read-only "what-if" sandbox (§13.5 V5-P6 arc c). Authorized through
   * the exact same share guard the shared view uses (`authorizeConglomerateRead`)
   * — an unauthorized viewer gets a 404, never data. The tweak set is pinned to
   * the shared basket's real top-level constituents (a foreign / missing id is
   * a 422). Nested children retain their stored internal weights and resolve
   * through the shared depth-bounded flattener; every resulting asset is then
   * resolved as a PUBLIC catalog asset, so a private custom asset's manual
   * valuations remain unavailable. Flat baskets keep the original full
   * backtest response; nested baskets return aggregate curve/stat data only,
   * and descendant identities and identity-bearing errors never widen the
   * share. Purely a read: no state is ever written. `reset to shared` is just
   * this call with the original weights, so it reproduces the shared curve
   * exactly.
   */
  runSharedSandboxPreview(
    viewerId: string,
    input: BacktestSharedSandboxInput,
    opts?: { baseCurrency?: string },
  ): Promise<SharedSandboxPreviewResponse>;
}

/**
 * Redis memo key for a preview —
 * hash(positions+range+benchmark+mode+rebalance+base), namespaced by user id so
 * a custom-asset basket's result never leaks across users (§10). The mode is
 * normalised to `clip` and the rebalance frequency to `none` so an omitted
 * field and its explicit default share one memo entry — and two different
 * modes or frequencies never collide. The base currency is part of the
 * identity (V3-P10d): the same basket backtested in USD is a different result,
 * not a different rendering.
 */
export function backtestPreviewCacheKey(
  userId: string,
  input: BacktestPreviewInput,
  baseCurrency: string,
  scope?: { globalOnly?: boolean },
): string {
  const canonical = JSON.stringify({
    positions: input.positions.map((p) => ({ assetId: p.assetId, weight: p.weight })),
    range: input.range,
    benchmark: input.benchmark ?? null,
    mode: input.mode ?? 'clip',
    rebalance: input.rebalance ?? 'none',
    baseCurrency,
    ...(scope?.globalOnly ? { globalOnly: true } : {}),
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `backtest:preview:${userId}:${hash}`;
}

/**
 * Redis memo key for a comparison's **baseline-independent core** (the per-series
 * backtests) — hash(id SET+resolved compositions+range+mode+rebalance+base),
 * namespaced by user id (§10). `baselineId` is deliberately NOT part of the key:
 * it only selects the delta reference, so re-picking it hits the same cached
 * backtests and just re-runs the cheap delta math.
 *
 * The id order is **not** part of the key either (#1755). A comparison is a SET
 * of baskets on one axis, so `[A,B,C]` and `[C,B,A]` are the same comparison and
 * must share one memo entry — keying by the ordered list gave one six-basket set
 * 720 distinct keys × 4 ranges × 3 modes × 4 frequencies, a memo that could
 * essentially never be hit twice. Everything the core computes is therefore
 * order-free by construction: the shared window is derived from the whole SET
 * (#1832 — see {@link comparisonWindowStart}), the canonical (id-sorted) list
 * only fixes the order the core is stored and refused in, and the response
 * re-projects the cached series into the caller's request order.
 *
 * The key is **content-addressed** like the preview key (V5-P6): a conglomerate
 * id is a mutable handle, so keying by id alone served a 1 h-stale chart and
 * stats grid after any Builder edit — and, worse, after an edit to a NESTED
 * CHILD, whose id never appears in the request at all. `compositions` therefore
 * carries each series' name, its fully *resolved* asset/weight vector (the
 * flatten already walked the children) and its unresolved share (an empty child
 * changes what a basket IS without changing the resolved vector), so any edit
 * that changes what a series is lands on a different key and recomputes; an
 * edit that changes nothing observable still hits the memo.
 */
export function backtestComparisonCacheKey(
  userId: string,
  input: BacktestComparisonInput,
  baseCurrency: string,
  scope?: { globalOnly?: boolean; compositions?: readonly ConglomerateComposition[] },
): string {
  const canonical = JSON.stringify({
    conglomerateIds: [...input.conglomerateIds].sort(),
    compositions:
      scope?.compositions === undefined
        ? null
        : canonicalCompositionOrder(scope.compositions).map((c) => ({
            id: c.id,
            name: c.name,
            positions: c.positions.map((p) => ({ assetId: p.assetId, weight: p.weight })),
            unresolvedPct: c.unresolvedPct,
          })),
    range: input.range,
    mode: input.mode ?? 'clip',
    rebalance: input.rebalance ?? 'none',
    baseCurrency,
    ...(scope?.globalOnly ? { globalOnly: true } : {}),
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `backtest:compare:${userId}:${hash}`;
}

/**
 * The order a comparison is COMPUTED in: by conglomerate id, so re-ordering the
 * picker is the same request (#1755). It is a storage/reporting order only — no
 * entry is privileged. The shared window comes from the whole set (#1832), so
 * this order decides just how the cached core is serialized and which of two
 * equally uncomparable series is named first in a refusal.
 */
function canonicalCompositionOrder(
  compositions: readonly ConglomerateComposition[],
): ConglomerateComposition[] {
  return [...compositions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Grace, in calendar days, between a secondary series' covered span and the
 * shared window it is measured over — at EITHER end — before the series is
 * refused as not covering it (#1755, #1811).
 *
 * The window's ends are the primary basket's first and last TRADING days, and
 * two baskets on different exchanges do not close on the same holidays — a US
 * basket compared against a DAX basket over a window ending on a day only one of
 * them traded is short by a day through no fault of the data. A week absorbs
 * every such calendar mismatch (the longest ordinary market closure is a long
 * weekend) while the cases this guards — a delisting, a provider history gap —
 * are short by months or years.
 */
export const COMPARISON_COVERAGE_GRACE_DAYS = 7;

/**
 * The shared window's start for an N-way comparison (#1832): the requested
 * range's start, pushed up to the LATEST date every compared basket has price
 * history from — the honest "latest common start" of the set.
 *
 * A basket's own earliest usable date is the one the engine would clip it to on
 * its own: its **common start** (the latest listing across its constituents) in
 * `clip` mode, its **earliest** listing in the §14 full-window modes, exactly as
 * {@link BacktestService.runPreview} anchors a MAX preview. Taking the max over
 * the set is what "compare these baskets" means: two baskets with history from
 * 2010 and 2015 are comparable over 2015→today, and neither the request nor the
 * ids may decide which of the two windows is used.
 *
 * Because the result is ≥ every basket's own clip point, no series is clipped by
 * the window and no basket can be refused merely for being younger than its
 * siblings. What the coverage rule still refuses is a basket that *claims* the
 * window and then does not deliver it: a provider gap right after t₀, or data
 * that stops inside it (#1811).
 */
function comparisonWindowStart(
  baskets: readonly ResolvedConglomerateBasket[],
  range: BacktestPreviewRange,
  mode: BacktestMode,
  end: string,
): string {
  // MAX has no requested floor — the window is the set's own history.
  let start = range === 'MAX' ? '' : yearsBefore(end, RANGE_YEARS[range]);
  for (const basket of baskets) {
    const available = mode === 'clip' ? commonStart(basket.assets) : earliestStart(basket.assets);
    if (available > start) start = available;
  }
  return start;
}

export function createBacktestService(deps: BacktestServiceDeps): BacktestService {
  const { assetRepo, conglomerateRepo, marketData, currencyService, redis } = deps;
  const now = deps.now ?? Date.now;

  /** Today's UTC calendar day — the last day of every preview window. */
  function todayIso(): string {
    return new Date(now()).toISOString().slice(0, 10);
  }

  /**
   * Daily closes for a provider ref over `range`. Best-effort like the portfolio
   * series: a provider outage past the stale window yields an empty series
   * (surfaced by the caller as a 422, never a 500).
   */
  async function loadDailyCloses(
    ref: { providerId: string; providerRef: string },
    range: HistoryRange,
  ): Promise<Array<{ date: string; close: number }>> {
    let points: readonly ProviderPricePoint[];
    try {
      const cached = await marketData.getHistory(ref, range, '1d');
      points = cached.value;
    } catch {
      points = [];
    }
    return toDailyCloses(points);
  }

  /**
   * Resolve one basket member: ownership-scoped asset lookup (another user's
   * custom asset — or a missing id — is a 404, no existence leak §10) plus its
   * daily closes through the market-data keystone (§5.2/§5.3). Shared by the
   * primary basket and every benchmark constituent so both go through the
   * exact same path. Composed of the two phases below, which the batched
   * callers run separately.
   */
  async function loadBasketAsset(
    userId: string,
    assetId: string,
    providerRange: HistoryRange,
    opts?: BasketAssetOptions,
  ): Promise<BacktestAsset> {
    const row = await resolveBasketAssetRow(userId, assetId, opts);
    return loadBasketAssetPrices(row, providerRange, opts);
  }

  /**
   * Phase one of {@link loadBasketAsset}: the owner-scoped row read and the two
   * refusals that follow from it. Database only — **no provider I/O** — which is
   * what lets the batched callers authorize every asset of a request before any
   * history is fetched (see {@link loadBasketAssets}).
   */
  async function resolveBasketAssetRow(
    userId: string,
    assetId: string,
    opts?: BasketAssetOptions,
  ): Promise<BasketAssetRow> {
    const row = await assetRepo.findByIdForUser(assetId, userId, {
      includeCustomAssets: opts?.hidePrivateAsset !== true,
    });
    if (!row) {
      if (opts?.redactIdentity) throw sharedSandboxUnavailable();
      throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
    }
    // Share-scoped sandbox (V5-P6 arc c): a custom asset's price history is the
    // owner's private manual valuations — absent from the read-only share — so a
    // viewer's backtest must never surface it. The existence is already exposed
    // (its symbol/name are in the shared view), so this is a plain 422, not a 404.
    if (opts?.globalOnly && row.ownerId !== null) {
      if (opts.redactIdentity) throw sharedSandboxUnavailable();
      throw unprocessable(
        `${row.symbol} is a private custom asset and can’t be backtested in a shared sandbox.`,
        'SANDBOX_PRIVATE_ASSET',
      );
    }
    return row;
  }

  /** Phase two of {@link loadBasketAsset}: the market-data half (§5.2/§5.3). */
  async function loadBasketAssetPrices(
    row: BasketAssetRow,
    providerRange: HistoryRange,
    opts?: BasketAssetOptions,
  ): Promise<BacktestAsset> {
    const prices = await loadDailyCloses(
      { providerId: row.providerId, providerRef: row.providerRef },
      providerRange,
    );
    if (prices.length === 0) {
      if (opts?.redactIdentity) throw sharedSandboxUnavailable();
      throw unprocessable(
        `No price history available for ${row.symbol} to backtest.`,
        'NO_PRICE_HISTORY',
      );
    }
    return { assetId: row.id, symbol: row.symbol, currency: row.currency, prices };
  }

  /**
   * Load many basket members as a bounded fan-out, in **two phases**: every row
   * is authorized first (database only), and only once they all pass does the
   * history fetch run. The phase split is load-bearing, not tidiness — the pool
   * replaced a sequential `for` loop in which the first refused asset aborted
   * before a single provider call. Fanned out naively, a refused request (a
   * paranoid transition that won mid-flight, a foreign custom asset) would still
   * emit history calls for its siblings — provider work for a request that ends
   * in a 404. Authorizing first restores "refused ⇒ zero provider I/O" exactly,
   * regardless of scheduling.
   *
   * Order is preserved and the lowest-index failure is the one that throws, so
   * the error a caller sees is the one the sequential loop would have given.
   */
  async function loadBasketAssets(
    userId: string,
    assetIds: readonly string[],
    providerRange: HistoryRange,
    opts?: BasketAssetOptions,
  ): Promise<BacktestAsset[]> {
    const rows = await mapFlattened(assetIds, (assetId) =>
      resolveBasketAssetRow(userId, assetId, opts),
    );
    return mapFlattened(rows, (row) => loadBasketAssetPrices(row, providerRange, opts));
  }

  /**
   * Resolve one of the caller's own conglomerates into a runnable basket
   * (ownership enforced at query time → 404, no existence leak §10; an empty or
   * unpriced basket is a 422). Shared by the V4-P7 benchmark path and the V5-P6
   * N-way comparison so a conglomerate runs through the exact same pipeline in
   * both — the "generalise, don't fork" mandate. A NESTED conglomerate (V5-P6)
   * is flattened to its effective asset weights through the one shared
   * resolution function first, so its backtest equals the backtest of its
   * hand-flattened equivalent by construction; a basket that flattens to
   * nothing (empty, or only empty children) is a 422.
   */
  async function resolveConglomerateComposition(
    userId: string,
    conglomerateId: string,
    globalOnly = false,
  ): Promise<ConglomerateComposition> {
    const detail = await conglomerateRepo.findByIdForOwner(userId, conglomerateId, {
      globalAssetMetadataOnly: globalOnly,
    });
    if (!detail) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
    const flat = await flattenConglomerate(
      // The root is already loaded — reuse it; children load owner-scoped.
      (id) =>
        id === conglomerateId
          ? Promise.resolve(detail)
          : conglomerateRepo.findByIdForOwner(userId, id, {
              globalAssetMetadataOnly: globalOnly,
            }),
      conglomerateId,
    );
    if (!flat || flat.positions.length === 0) {
      throw unprocessable(
        `Conglomerate ${detail.name} has no positions to backtest.`,
        'BACKTEST_UNAVAILABLE',
      );
    }
    return {
      id: detail.id,
      name: detail.name,
      positions: flat.positions.map((p) => ({ assetId: p.assetId, weight: p.weightPct })),
      unresolvedPct: flat.unresolvedPct,
    };
  }

  /**
   * The provider half of a comparison: one asset row + history window per
   * DISTINCT resolved position across ALL series, through a small pool rather
   * than one sequential round trip each. Each basket's flatten is bounded by
   * `MAX_FLATTENED_POSITIONS` and the series count by `COMPARISON_MAX_SERIES`,
   * so this is a bounded fan-out, not an open one. Results are re-split in
   * request order, one entry per input composition.
   *
   * The load is de-duplicated across series (#1755): baskets under comparison
   * overlap heavily by construction — the whole point is comparing variations of
   * one portfolio — and loading per series charged the provider layer (and the
   * asset repository) once per OCCURRENCE, so six baskets sharing 250 assets
   * spent 1500 row reads and 1500 history windows for 250 assets' worth of data.
   * One asset is now loaded exactly once and the resulting {@link BacktestAsset}
   * (immutable, and consumed read-only by the engine) is shared by every series
   * holding it.
   */
  async function loadCompositionAssets(
    userId: string,
    compositions: readonly ConglomerateComposition[],
    providerRange: HistoryRange,
    globalOnly: boolean,
  ): Promise<ResolvedConglomerateBasket[]> {
    // One pool across the WHOLE request rather than a pool per basket: the two
    // authorization/history phases then straddle every series at once, so a
    // refused asset in the last basket still precedes the first history call.
    // First-occurrence order is preserved, so the LOWEST-INDEX failure is the
    // same asset it was before the de-duplication — the refusal a caller sees
    // does not depend on how often an id repeats.
    const distinctIds = [
      ...new Set(compositions.flatMap((c) => c.positions.map((p) => p.assetId))),
    ];
    const assets = await loadBasketAssets(userId, distinctIds, providerRange, {
      globalOnly,
      hidePrivateAsset: globalOnly,
    });
    const byAssetId = new Map(distinctIds.map((assetId, index) => [assetId, assets[index]!]));
    return compositions.map((composition) => ({
      ...composition,
      assets: composition.positions.map((p) => byAssetId.get(p.assetId)!),
    }));
  }

  async function resolveConglomerateBasket(
    userId: string,
    conglomerateId: string,
    providerRange: HistoryRange,
    globalOnly = false,
  ): Promise<ResolvedConglomerateBasket> {
    const composition = await resolveConglomerateComposition(userId, conglomerateId, globalOnly);
    return (await loadCompositionAssets(userId, [composition], providerRange, globalOnly))[0]!;
  }

  /**
   * Resolve the benchmark choice (V4-P7) into a runnable basket:
   *
   *  - `conglomerateId` — one of the CALLER's own conglomerates (ownership
   *    enforced at query time → 404, §10), as a whole second basket;
   *  - `assetId` — any catalog asset from local search (§6.2), as a
   *    single-constituent basket;
   *  - `preset` — a one-click ticker, resolved to its catalog asset when
   *    seeded; an unseeded catalog falls back to the static provider spec so
   *    the presets keep working on a fresh instance.
   */
  async function resolveBenchmark(
    userId: string,
    choice: BacktestBenchmarkInput,
    providerRange: HistoryRange,
    globalOnly = false,
  ): Promise<ResolvedBenchmark> {
    if ('conglomerateId' in choice) {
      const basket = await resolveConglomerateBasket(
        userId,
        choice.conglomerateId,
        providerRange,
        globalOnly,
      );
      return {
        kind: 'conglomerate',
        refId: basket.id,
        label: basket.name,
        positions: basket.positions,
        assets: basket.assets,
        unresolvedPct: basket.unresolvedPct,
      };
    }

    if ('assetId' in choice) {
      const asset = await loadBasketAsset(userId, choice.assetId, providerRange, {
        globalOnly,
        hidePrivateAsset: globalOnly,
      });
      return {
        kind: 'asset',
        refId: asset.assetId,
        label: asset.symbol,
        positions: [{ assetId: asset.assetId, weight: 1 }],
        assets: [asset],
        unresolvedPct: 0,
      };
    }

    const spec = BENCHMARKS[choice.preset];
    const row = await assetRepo.findGlobal(spec.providerId, spec.providerRef);
    const identity = row
      ? { assetId: row.id, symbol: row.symbol, currency: row.currency }
      : { assetId: choice.preset, symbol: choice.preset, currency: spec.currency };
    const prices = await loadDailyCloses(
      { providerId: spec.providerId, providerRef: spec.providerRef },
      providerRange,
    );
    if (prices.length === 0) {
      throw unprocessable(
        `No price history available for benchmark ${choice.preset}.`,
        'NO_PRICE_HISTORY',
      );
    }
    return {
      kind: 'asset',
      refId: identity.assetId,
      label: identity.symbol,
      positions: [{ assetId: identity.assetId, weight: 1 }],
      assets: [{ ...identity, prices }],
      unresolvedPct: 0,
    };
  }

  type ScopedBacktestService = Omit<BacktestService, 'runPreview' | 'runComparison'> & {
    runPreview(
      userId: string,
      input: BacktestPreviewInput,
      opts: { baseCurrency?: string } | undefined,
      globalOnly: boolean,
    ): Promise<BacktestResponse>;
    runComparison(
      userId: string,
      input: BacktestComparisonInput,
      opts: { baseCurrency?: string } | undefined,
      globalOnly: boolean,
    ): Promise<BacktestComparisonResponse>;
  };

  const scoped: ScopedBacktestService = {
    async runPreview(userId, input, opts, globalOnly) {
      const fx =
        opts?.baseCurrency === undefined
          ? currencyService
          : currencyService.withBase(opts.baseCurrency);
      const key = backtestPreviewCacheKey(userId, input, fx.baseCurrency, { globalOnly });
      const cached = await redis.get(key);
      if (cached) {
        try {
          return JSON.parse(cached) as BacktestResponse;
        } catch {
          // Corrupt entry — fall through and recompute (no history refetch on a hit).
        }
      }

      const providerRange = PROVIDER_RANGE[input.range];

      // 1. Resolve every position asset and load its daily closes (shared
      //    ownership-scoped path, see loadBasketAsset).
      const assets: BacktestAsset[] = [];
      for (const pos of input.positions) {
        assets.push(
          await loadBasketAsset(userId, pos.assetId, providerRange, {
            globalOnly,
            hidePrivateAsset: globalOnly,
          }),
        );
      }

      // 2. Optional benchmark (V4-P7): resolve the choice — preset, catalog
      //    asset, or one of the caller's own conglomerates — into a second
      //    basket that will run through the same engine below.
      const resolvedBenchmark = input.benchmark
        ? await resolveBenchmark(userId, input.benchmark, providerRange, globalOnly)
        : null;

      // 3. Requested window. The end is today; a finite range starts N years back
      //    and the engine clips it up to the common start (emitting the §6.6
      //    notice). MAX has no explicit start, so anchor it at the basket's common
      //    start — otherwise every MAX preview would carry a spurious "Limited by
      //    …" notice for a request that asked for the full overlapping history.
      //    In the §14 full-window modes "all available history" means the
      //    EARLIEST first-available date instead (the engine only clips up to
      //    that), so MAX anchors there and late constituents stay late.
      const mode = input.mode ?? 'clip';
      const end = todayIso();
      const start =
        input.range === 'MAX'
          ? mode === 'clip'
            ? commonStart(assets)
            : earliestStart(assets)
          : yearsBefore(end, RANGE_YEARS[input.range]);

      // 4. Run the pure engine, injecting the CurrencyService as the historical
      //    FX-at-date converter (§5.4). Data-state failures (e.g. no
      //    overlapping window) surface as a 422 with the engine's message
      //    rather than a 500.
      //
      //    FX unavailability is a data state too, but unlike the portfolio
      //    series' probe-and-drop degrade (portfolioService), silently dropping
      //    an unconvertible position would re-weight the basket and change the
      //    result — so a backtest fails the whole preview with a 422 instead.
      let result: BacktestResult;
      try {
        result = await backtest({
          positions: input.positions.map((p) => ({ assetId: p.assetId, weight: p.weight })),
          assets,
          range: { start, end },
          converter: fx,
          baseCurrency: fx.baseCurrency,
          mode,
          rebalance: input.rebalance,
        });
      } catch (err) {
        throw mapEngineError(err);
      }

      // 5. Benchmark run (V4-P7): the SAME engine over the primary's effective
      //    window with the SAME base currency, late-listing mode and rebalance
      //    schedule — apples-to-apples by construction. A benchmark that does
      //    not cover that window — at EITHER end (#1811) — would silently
      //    compare a shorter one, so it is refused with a 422 through the same
      //    rule a non-primary comparison series goes through.
      let benchmark: BacktestBenchmarkResult | null = null;
      if (resolvedBenchmark) {
        let benchResult: BacktestResult;
        try {
          benchResult = await backtest({
            positions: resolvedBenchmark.positions,
            assets: resolvedBenchmark.assets,
            range: { start: result.startDate, end: result.endDate },
            converter: fx,
            baseCurrency: fx.baseCurrency,
            mode,
            rebalance: input.rebalance,
          });
        } catch (err) {
          throw mapEngineError(err);
        }
        assertCoversWindow(
          `Benchmark ${resolvedBenchmark.label}`,
          'the backtest window',
          benchResult,
          { start: result.startDate, end: result.endDate },
        );
        benchmark = {
          kind: resolvedBenchmark.kind,
          refId: resolvedBenchmark.refId,
          label: resolvedBenchmark.label,
          series: benchResult.series.map((p) => ({ date: p.date, value: p.value })),
          stats: toStats(benchResult.stats),
          // A conglomerate benchmark with an empty nested child is only its
          // resolved remainder, normalized to 100 — say so rather than let the
          // overlay claim to be the whole basket (#1755).
          unresolvedPct: resolvedBenchmark.unresolvedPct,
        };
      }

      const response = toResponse(result, benchmark);
      await redis.set(key, JSON.stringify(response), 'EX', PREVIEW_TTL_SECONDS);
      return response;
    },

    async runComparison(userId, input, opts, globalOnly) {
      const fx =
        opts?.baseCurrency === undefined
          ? currencyService
          : currencyService.withBase(opts.baseCurrency);
      const mode = input.mode ?? 'clip';
      const rebalance = input.rebalance ?? 'none';
      // The delta baseline is contract-guaranteed to be one of the ids (or the
      // first when omitted); it steers only the deltas, never the window.
      const baselineId = input.baselineId ?? input.conglomerateIds[0]!;

      // Resolve WHAT each series is first (database only — no provider I/O, no
      // engine): ownership, emptiness and the nesting invariants are checked
      // here, and the resolved compositions address the memo key so an edited
      // basket — or an edited nested child — cannot be answered from the
      // pre-edit core.
      const providerRange = PROVIDER_RANGE[input.range];
      const compositions = await mapFlattened(input.conglomerateIds, (id) =>
        resolveConglomerateComposition(userId, id, globalOnly),
      );

      // The per-series backtests are baseline-independent AND order-independent,
      // so they memoise under a key without the baseline and over the id SET:
      // re-picking the baseline, or re-ordering the picker, hits this core and
      // only the cheap delta math re-runs. The core is computed over the
      // canonical order for exactly that reason and re-projected below.
      const canonical = canonicalCompositionOrder(compositions);
      const key = backtestComparisonCacheKey(userId, input, fx.baseCurrency, {
        globalOnly,
        compositions,
      });
      let core: ComparisonCore | null = null;
      const cached = await redis.get(key);
      if (cached) {
        try {
          core = JSON.parse(cached) as ComparisonCore;
        } catch {
          // Corrupt entry — fall through and recompute.
        }
      }
      if (core === null) {
        core = await computeComparisonCore(
          userId,
          canonical,
          providerRange,
          input.range,
          fx,
          mode,
          rebalance,
          globalOnly,
        );
        await redis.set(key, JSON.stringify(core), 'EX', PREVIEW_TTL_SECONDS);
      }

      // The core is stored in canonical order; the RESPONSE is in the caller's
      // request order (the chart legend and the grid's columns follow the
      // picker). Every requested id is present — the core was computed from the
      // same set — so the projection is total.
      const byId = new Map(core.series.map((s) => [s.conglomerateId, s]));
      const ordered = input.conglomerateIds.map((id) => byId.get(id)!);

      // Deltas vs the chosen baseline — pure domain math over the shared-window
      // stats (compareSeriesStats preserves input order, so index i lines up
      // with ordered[i]).
      const comparison = compareSeriesStats(
        ordered.map((s) => ({ id: s.conglomerateId, metrics: metricsFor(s.stats) })),
        baselineId,
      );

      return {
        startDate: core.startDate,
        endDate: core.endDate,
        baselineId,
        mode: core.mode,
        rebalance: core.rebalance,
        series: ordered.map((s, i) => {
          const d = comparison.series[i]!.deltas;
          return {
            conglomerateId: s.conglomerateId,
            name: s.name,
            series: s.series,
            stats: s.stats,
            unresolvedPct: s.unresolvedPct,
            deltas: {
              totalReturnPct: d.totalReturnPct,
              cagrPct: d.cagrPct,
              maxDrawdownPct: d.maxDrawdownPct,
              volatilityPct: d.volatilityPct,
              bestDayPct: d.bestDayPct,
              worstDayPct: d.worstDayPct,
            },
          };
        }),
      };
    },

    async runSharedSandboxPreview(viewerId, input, opts) {
      // Same guard, same outcome as the read-only shared view (§6.9): resolve the
      // owner when the viewer may see this basket, otherwise a 404 — never a 403,
      // never data. Also covers the service constructed without the social guard.
      const authorize = deps.authorizeConglomerateRead;
      const candidate = authorize ? await authorize(viewerId, input.conglomerateId) : undefined;
      if (!candidate) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');

      const render = async (owner: { ownerId: string }) => {
        // Read the basket AS THE OWNER — the viewer gains no owner scope; we only
        // read what they are already authorized to see.
        const detail = await conglomerateRepo.findByIdForOwner(owner.ownerId, input.conglomerateId);
        if (!detail) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');

        // Arc c re-weights TOP-LEVEL constituents as opaque rows. A nested child
        // keeps its stored internal weights; the shared flattener resolves those
        // recursively after applying the viewer's local root allocation.
        const constituents = detail.positions;
        const assetConstituents = constituents.filter(
          (position): position is Extract<ConglomerateConstituentRow, { kind: 'asset' }> =>
            position.kind === 'asset',
        );
        const hasNestedConstituents = assetConstituents.length !== constituents.length;
        const constituentId = (position: ConglomerateConstituentRow): string =>
          position.kind === 'asset' ? position.assetId : position.childId;

        // Pin the tweak set to the shared basket's real constituents: the viewer may
        // re-weight only what the share already exposes, never add or drop an id. An
        // id set that doesn't match exactly (a foreign id, a missing one, or a basket
        // that changed under the viewer) is a 422 — the client refetches and resets.
        const tweak = new Map(input.positions.map((p) => [p.id, p.weight]));
        const idSetMatches =
          tweak.size === constituents.length &&
          constituents.every((position) => tweak.has(constituentId(position)));
        if (!idSetMatches) {
          throw unprocessable(
            'Sandbox weights must cover exactly the shared basket’s constituents.',
            'SANDBOX_POSITIONS_MISMATCH',
          );
        }

        // A nested row is opaque by design, and the aggregate response is a
        // WEIGHTED MIX of it and the root's public assets. Push that row's share
        // to ~100 % and the mix stops being a mix: the returned `series` and
        // `stats` become the hidden child's own base-100 curve, its own max
        // drawdown, its own best/worst days and — through `startDate` — its
        // youngest constituent's listing date. That is an extraction, not a
        // what-if, so it is refused BEFORE any basket is resolved (#1755).
        if (hasNestedConstituents) assertNestedShareBounded(constituents, tweak);

        const fx =
          opts?.baseCurrency === undefined
            ? currencyService
            : currencyService.withBase(opts.baseCurrency);
        const providerRange = PROVIDER_RANGE[input.range];

        let positions: Array<{ assetId: string; weight: number }>;
        // The share of the sandbox basket that resolved to NO asset — an empty
        // nested child. Always 0 on the flat path (an asset row always resolves).
        let unresolvedPct = 0;
        if (hasNestedConstituents) {
          // Apply only the root overrides, then reuse the canonical recursive
          // resolver. This preserves the stored child structure, cycle/depth
          // invariants and effective-weight semantics instead of reimplementing
          // nesting in the sandbox.
          const flat = await flattenConglomerate(
            (conglomerateId) =>
              conglomerateId === detail.id
                ? Promise.resolve(detail)
                : conglomerateRepo.findByIdForOwner(owner.ownerId, conglomerateId),
            detail.id,
            { rootWeights: tweak },
          );
          positions =
            flat?.positions.map((position) => ({
              assetId: position.assetId,
              weight: position.weightPct,
            })) ?? [];
          // A child emptied by its owner (which demotes the parent to `draft`
          // but does not un-share it) is dropped by the flatten, and the
          // survivors are normalized back to 100. Carry that slice into the
          // response (#1832): without it a `[A 60, emptied child 40]` sandbox is
          // byte-identical to the same basket at `[A 100]`, so the curve, total
          // return, drawdown and best/worst day are a single-asset basket's,
          // presented as the shared basket at its own stored weights. Every
          // sibling read path — `resolved`, `allocate`, a comparison series, the
          // benchmark overlay — already reports it.
          unresolvedPct = flat?.unresolvedPct ?? 0;
        } else {
          // Preserve the original flat-sandbox path exactly: pass raw top-level
          // tweak weights to the engine without the flattener's percentage
          // normalization round trip.
          positions = assetConstituents.map((position) => ({
            assetId: position.assetId,
            weight: tweak.get(position.assetId)!,
          }));
        }
        if (positions.length === 0) {
          throw unprocessable(
            `Conglomerate ${detail.name} has no positions to backtest.`,
            'BACKTEST_UNAVAILABLE',
          );
        }
        // A nested row hides both descendant identities and its internal
        // allocation. Even when every flattened asset also happens to be exposed
        // directly at the root, a full contribution response could reveal the
        // child's effective weights. Therefore response/error redaction is keyed
        // to the presence of nesting itself, not to whether flattening introduced
        // a previously unseen asset id.
        // Asset rows at the shared root already expose their identity. Assets
        // reachable only through a nested child remain opaque and must never be
        // named by load failures.
        const exposedAssetIds = new Set(assetConstituents.map((position) => position.assetId));
        const assets: BacktestAsset[] = [];
        for (const pos of positions) {
          assets.push(
            await loadBasketAsset(owner.ownerId, pos.assetId, providerRange, {
              globalOnly: true,
              redactIdentity: !exposedAssetIds.has(pos.assetId),
            }),
          );
        }

        // Window resolution mirrors runPreview exactly (§6.6/§14) so the sandbox
        // curve is apples-to-apples with the shared basket's own backtest.
        const mode = input.mode ?? 'clip';
        const end = todayIso();
        const start =
          input.range === 'MAX'
            ? mode === 'clip'
              ? commonStart(assets)
              : earliestStart(assets)
            : yearsBefore(end, RANGE_YEARS[input.range]);

        let result: BacktestResult;
        try {
          result = await backtest({
            positions,
            assets,
            range: { start, end },
            converter: fx,
            baseCurrency: fx.baseCurrency,
            mode,
            rebalance: input.rebalance,
          });
        } catch (err) {
          throw hasNestedConstituents ? mapSharedSandboxEngineError(err) : mapEngineError(err);
        }
        // No Redis memo and no writes: a viewer's slider-wiggle recomputes off the
        // already-warm provider history, and the sandbox never persists a thing.
        // Preserve the original full wire shape for flat baskets. Nested baskets
        // use the aggregate DTO so descendant identities and effective internal
        // weights cannot escape through contributions, entry events or notices.
        return hasNestedConstituents
          ? toSharedSandboxResponse(result, unresolvedPct)
          : toResponse(result, null);
      };

      if (!deps.paranoid) return render(candidate);
      return deps.paranoid.runAllowedMany([viewerId, candidate.ownerId], 'sharing', async () => {
        const current = authorize ? await authorize(viewerId, input.conglomerateId) : undefined;
        if (!current || current.ownerId !== candidate.ownerId) {
          throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
        }
        return render(current);
      });
    },
  };

  const withHypotheticalAssetScope = <T>(
    userId: string,
    action: (globalOnly: boolean) => Promise<T>,
  ): Promise<T> => {
    if (!deps.paranoid) return action(false);
    return deps.paranoid.runAllowedWithOptional([], [userId], 'portfolioServer', (normalUserIds) =>
      action(!normalUserIds.has(userId)),
    );
  };

  return {
    runPreview: (userId, input, opts) =>
      withHypotheticalAssetScope(userId, (globalOnly) =>
        scoped.runPreview(userId, input, opts, globalOnly),
      ),
    runComparison: (userId, input, opts) =>
      withHypotheticalAssetScope(userId, (globalOnly) =>
        scoped.runComparison(userId, input, opts, globalOnly),
      ),
    runSharedSandboxPreview: (viewerId, input, opts) =>
      scoped.runSharedSandboxPreview(viewerId, input, opts),
  };

  /**
   * Run the baseline-independent core of a comparison over the already-resolved
   * compositions (in CANONICAL id order): load each series' price history, fix
   * ONE shared window over the whole set, and run every series over that exact
   * window with identical settings. A series that can't cover the window — at
   * either end — is a 422 (the V4-P7 short-benchmark outcome).
   *
   * No series is the "primary" (#1832). The window used to be the first
   * canonically-sorted basket's own effective window, which made the id sort
   * order decide whether a comparison was possible at all: an older basket
   * sorting first opened the window at its own t₀ and 422'd every younger
   * sibling, while the identical request with the ids the other way round
   * succeeded. Id order is deliberately absent from the request semantics and
   * the memo key, so the user could not even influence it. The window is
   * derived from the SET instead ({@link comparisonWindowStart}), and every
   * series — including the one that set the window — goes through the same
   * coverage rule, so a basket with a provider gap right after t₀ is refused no
   * matter where its id sorts.
   */
  async function computeComparisonCore(
    userId: string,
    compositions: readonly ConglomerateComposition[],
    providerRange: HistoryRange,
    range: BacktestPreviewRange,
    fx: CurrencyService,
    mode: BacktestMode,
    rebalance: RebalanceFrequency,
    globalOnly: boolean,
  ): Promise<ComparisonCore> {
    const baskets = await loadCompositionAssets(userId, compositions, providerRange, globalOnly);

    const end = todayIso();
    const window = { start: comparisonWindowStart(baskets, range, mode, end), end };

    const runs: Array<{ basket: ResolvedConglomerateBasket; result: BacktestResult }> = [];
    for (const basket of baskets) {
      let result: BacktestResult;
      try {
        result = await backtest({
          positions: basket.positions,
          assets: basket.assets,
          range: window,
          converter: fx,
          baseCurrency: fx.baseCurrency,
          mode,
          rebalance,
        });
      } catch (err) {
        throw mapEngineError(err);
      }
      runs.push({ basket, result });
    }

    // What every series is measured against: the best-covered end of the set.
    // The window opens at the latest date every basket has history from, so the
    // series that set it charts from day one and the rest are compared to that
    // day (the pre-#1832 rule compared them to the *primary's* day, which is the
    // same date whenever the primary is the best-covered series — and an
    // arbitrary one otherwise). Likewise at the tail: a comparison over prices
    // that are collectively a fortnight stale is still a comparison, so the
    // reference is the furthest any series got, not the calendar's today.
    const covered = {
      start: runs.reduce(
        (earliest, r) => (r.result.startDate < earliest ? r.result.startDate : earliest),
        runs[0]!.result.startDate,
      ),
      end: runs.reduce((latest, r) => {
        const reach = r.result.endCoverage?.date ?? window.end;
        return reach > latest ? reach : latest;
      }, runs[0]!.result.endCoverage?.date ?? window.end),
    };
    for (const { basket, result } of runs) {
      // A series that does not cover the window is not comparable over it, at
      // either end (#1755, #1811) — the same rule the benchmark path applies.
      assertCoversWindow(`Conglomerate ${basket.name}`, 'the comparison window', result, covered);
    }

    const series: ComparisonCore['series'] = runs.map(({ basket, result }) => ({
      conglomerateId: basket.id,
      name: basket.name,
      series: result.series.map((p) => ({ date: p.date, value: p.value })),
      stats: toStats(result.stats),
      unresolvedPct: basket.unresolvedPct,
    }));

    // The reported window is the span EVERY charted series reaches — the latest
    // first day and the earliest last day (#1755, #1811): the grace above
    // tolerates a series whose exchange was shut on the window's first or final
    // day, and a response must never claim a date one of its own curves does not
    // reach.
    const startDate = series.reduce((latest, s) => {
      const first = s.series[0]?.date ?? latest;
      return first > latest ? first : latest;
    }, window.start);
    const endDate = series.reduce((earliest, s) => {
      const last = s.series[s.series.length - 1]?.date ?? earliest;
      return last < earliest ? last : earliest;
    }, window.end);

    return { startDate, endDate, mode, rebalance, series };
  }
}

/**
 * The baseline-independent core of a comparison (Redis-cached): the shared
 * window + each conglomerate's base-100 series and full stats. Deltas are
 * layered on per request against the caller's chosen baseline, so a baseline
 * switch reuses this core.
 */
interface ComparisonCore {
  startDate: string;
  endDate: string;
  mode: BacktestMode;
  rebalance: RebalanceFrequency;
  series: Array<{
    conglomerateId: string;
    name: string;
    series: Array<{ date: string; value: number }>;
    stats: BacktestStatsDto;
    unresolvedPct: number;
  }>;
}

/**
 * Calendar days from `from` to `to`, floored at 0 (`to` on/before `from` ⇒ 0).
 * Calendar days, not trading days: the gaps these measure are exactly the ones a
 * trading calendar cannot explain.
 */
function calendarDaysBetween(from: string, to: string): number {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * Calendar days between the last day a basket covered and the window end it was
 * asked to cover — `0` when it covered the end (the engine reports no coverage
 * gap at all).
 */
function coverageShortfallDays(
  coverage: { date: string; symbol: string } | null,
  windowEnd: string,
): number {
  if (coverage === null) return 0;
  return calendarDaysBetween(coverage.date, windowEnd);
}

/**
 * Refuse a SECONDARY series — a V4-P7 benchmark, or a non-primary series of an
 * N-way comparison — that does not cover the window it is being measured over.
 * One rule for both paths (#1811); both are the same promise, that the overlaid
 * curve and the stats printed beside the primary's describe the same window:
 *
 *  1. its common start is after the window start (the engine's own clip notice);
 *  2. its first covered day is materially after the window start — an old series
 *     with a provider gap right after t₀, or simply a different exchange
 *     calendar, which no notice fires for;
 *  3. its data stops inside the window (`endCoverage`) — a delisting.
 *
 * (2) and (3) allow {@link COMPARISON_COVERAGE_GRACE_DAYS} so an ordinary
 * holiday mismatch between two exchanges is still comparable. Without them a
 * series short of the window is charted as a line that simply starts late or
 * stops early, with stats annualised over the fraction it covered and then
 * differenced, in one grid, against series that ran the whole window.
 */
function assertCoversWindow(
  subject: string,
  windowLabel: string,
  result: BacktestResult,
  window: { start: string; end: string },
): void {
  if (result.notice !== null) {
    throw unprocessable(
      `${subject} does not cover ${windowLabel} — ${result.notice}.`,
      'BACKTEST_UNAVAILABLE',
    );
  }
  if (calendarDaysBetween(window.start, result.startDate) > COMPARISON_COVERAGE_GRACE_DAYS) {
    throw unprocessable(
      `${subject} does not cover ${windowLabel} — its data starts ${result.startDate}, after ${window.start}.`,
      'BACKTEST_UNAVAILABLE',
    );
  }
  if (coverageShortfallDays(result.endCoverage, window.end) > COMPARISON_COVERAGE_GRACE_DAYS) {
    throw unprocessable(
      `${subject} does not cover ${windowLabel} — its data ends ${result.endCoverage!.date}, before ${window.end}.`,
      'BACKTEST_UNAVAILABLE',
    );
  }
}

/**
 * Flatten a wire `BacktestStats` to the comparison's numeric metric vector: the
 * best/worst-day blocks collapse to their `returnPct` (the grid compares the
 * magnitude; the date stays on the per-series `stats`).
 */
function metricsFor(stats: BacktestStatsDto): ComparisonMetrics {
  return {
    totalReturnPct: stats.totalReturnPct,
    cagrPct: stats.cagrPct,
    maxDrawdownPct: stats.maxDrawdownPct,
    volatilityPct: stats.volatilityPct,
    bestDayPct: stats.bestDay?.returnPct ?? null,
    worstDayPct: stats.worstDay?.returnPct ?? null,
  };
}

/** Map engine data-state failures to 422s (never 500s); rethrow everything else. */
function mapEngineError(err: unknown): unknown {
  if (err instanceof BacktestError) {
    return unprocessable(err.message, 'BACKTEST_UNAVAILABLE');
  }
  if (err instanceof FxRateUnavailableError) {
    return unprocessable(
      `Currency conversion required by this backtest is unavailable: ${err.message}`,
      'FX_UNAVAILABLE',
    );
  }
  return err;
}

/**
 * The largest share of a shared what-if basket a single NESTED (opaque)
 * constituent may be pushed to, in percent (#1755).
 *
 * The aggregate-only response for a nested share hides descendant identities but
 * not their numbers: the curve is a weighted mix, and a mix in which one term
 * carries ~all the weight IS that term. Contract-bounding the weight to ≤ 100 is
 * not enough on its own — `[public 0.001, child 100]` still leaves the child at
 * 99.999 % — so a nested row additionally may not be re-weighted past this
 * share. Re-weighting inside it stays fully available: a viewer may still take
 * a 50 % child to 90 %, which is well past any honest what-if.
 *
 * A basket that ALREADY gives a nested row this much (a share whose root is one
 * 100 % child) is not the viewer's doing and is not restricted — the shared view
 * itself is that basket, and refusing it would break "reset to shared". The
 * bound is therefore `max(cap, the row's stored share)`.
 */
export const SANDBOX_MAX_NESTED_SHARE_PCT = 90;

/** Float-noise floor for comparing a re-weighted share against its stored one. */
const SANDBOX_SHARE_EPSILON = 1e-9;

/**
 * Refuse a sandbox whose weights collapse the basket onto one opaque nested
 * constituent — see {@link SANDBOX_MAX_NESTED_SHARE_PCT}. Identity-free: the
 * refusal names nothing the share does not already expose, and it is the same
 * 422 family every other sandbox data-state refusal uses.
 */
function assertNestedShareBounded(
  constituents: readonly ConglomerateConstituentRow[],
  tweak: ReadonlyMap<string, number>,
): void {
  let tweakSum = 0;
  let storedSum = 0;
  for (const position of constituents) {
    tweakSum += tweak.get(position.kind === 'asset' ? position.assetId : position.childId) ?? 0;
    storedSum += position.weightPct;
  }
  if (!(tweakSum > 0) || !(storedSum > 0)) return;
  for (const position of constituents) {
    if (position.kind !== 'conglomerate') continue;
    const share = ((tweak.get(position.childId) ?? 0) / tweakSum) * 100;
    const storedShare = (position.weightPct / storedSum) * 100;
    const bound = Math.max(SANDBOX_MAX_NESTED_SHARE_PCT, storedShare);
    if (share > bound + SANDBOX_SHARE_EPSILON) {
      throw unprocessable(
        `A nested part of this shared basket can’t be weighted above ${bound.toFixed(0)} % of it in a sandbox.`,
        'SANDBOX_NESTED_SHARE_CAP',
      );
    }
  }
}

/** One identity-free data-state outcome for errors involving opaque descendants. */
function sharedSandboxUnavailable() {
  return unprocessable(SHARED_SANDBOX_UNAVAILABLE_MESSAGE, 'BACKTEST_UNAVAILABLE');
}

/**
 * The pure engine includes asset symbols in several data-state errors. When a
 * shared nested sandbox resolves opaque descendants, those messages collapse
 * to one identity-free outcome.
 */
function mapSharedSandboxEngineError(err: unknown): unknown {
  if (err instanceof BacktestError || err instanceof FxRateUnavailableError) {
    return sharedSandboxUnavailable();
  }
  return err;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collapse a provider price series to one adjusted close per calendar day (last
 * candle of a day wins, mirroring the portfolio series' `mergeDailyPrices`) in
 * the `{ date, close }` shape the engine consumes. Non-finite closes are dropped.
 */
function toDailyCloses(
  points: readonly ProviderPricePoint[],
): Array<{ date: string; close: number }> {
  const byDate = new Map<string, number>();
  for (const p of points) {
    if (!Number.isFinite(p.close)) continue;
    byDate.set(p.time.slice(0, 10), p.close);
  }
  return [...byDate].map(([date, close]) => ({ date, close }));
}

/**
 * The basket's common start: the latest first-available date across assets —
 * the same date the engine derives internally. Used only to anchor a MAX
 * window so it is not reported as "clipped".
 */
function commonStart(assets: readonly BacktestAsset[]): string {
  let start = '';
  for (const a of assets) {
    let earliest = '';
    for (const p of a.prices) {
      if (earliest === '' || p.date < earliest) earliest = p.date;
    }
    if (earliest !== '' && earliest > start) start = earliest;
  }
  return start;
}

/**
 * The basket's earliest first-available date across assets — the §14
 * full-window analogue of {@link commonStart}: anchoring MAX here keeps the
 * oldest constituent's entire history in the window (and every younger
 * constituent late) without a spurious clip notice.
 */
function earliestStart(assets: readonly BacktestAsset[]): string {
  let start = '';
  for (const a of assets) {
    for (const p of a.prices) {
      if (start === '' || p.date < start) start = p.date;
    }
  }
  return start;
}

/** ISO `YYYY-MM-DD` `years` calendar years before `today` (UTC). */
function yearsBefore(today: string, years: number): string {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/** Shape the engine's stats into the wire DTO (a faithful field-for-field mirror). */
function toStats(s: BacktestStats): BacktestStatsDto {
  return {
    totalReturnPct: s.totalReturnPct,
    cagrPct: s.cagrPct,
    maxDrawdownPct: s.maxDrawdownPct,
    volatilityPct: s.volatilityPct,
    bestDay: s.bestDay ? { date: s.bestDay.date, returnPct: s.bestDay.returnPct } : null,
    worstDay: s.worstDay ? { date: s.worstDay.date, returnPct: s.worstDay.returnPct } : null,
  };
}

/** Shape the engine's `BacktestResult` (+ the separately-run benchmark) into the wire DTO. */
function toResponse(
  r: BacktestResult,
  benchmark: BacktestBenchmarkResult | null,
): BacktestResponse {
  return {
    startDate: r.startDate,
    endDate: r.endDate,
    series: r.series.map((p) => ({ date: p.date, value: p.value })),
    stats: toStats(r.stats),
    contributions: r.contributions.map((c) => ({
      assetId: c.assetId,
      symbol: c.symbol,
      weight: c.weight,
      returnPct: c.returnPct,
      contributionPct: c.contributionPct,
    })),
    notice: r.notice,
    benchmark,
    mode: r.mode,
    rebalance: r.rebalance,
    entryEvents: r.entryEvents.map((e) => ({
      assetId: e.assetId,
      symbol: e.symbol,
      date: e.date,
    })),
    rebalanceEvents: r.rebalanceEvents.map((e) => ({ date: e.date })),
    idleCashAvgPct: r.idleCashAvgPct,
  };
}

/**
 * Shape a shared sandbox result without any descendant-level identity fields.
 * `unresolvedPct` is the aggregate share that resolved to no asset (#1832) — a
 * number, never an identity: it says how much of the basket the curve is NOT,
 * without naming the child it went missing in.
 */
function toSharedSandboxResponse(
  r: BacktestResult,
  unresolvedPct: number,
): SharedSandboxAggregateResponse {
  return {
    startDate: r.startDate,
    endDate: r.endDate,
    series: r.series.map((p) => ({ date: p.date, value: p.value })),
    stats: toStats(r.stats),
    mode: r.mode,
    rebalance: r.rebalance,
    rebalanceEvents: r.rebalanceEvents.map((e) => ({ date: e.date })),
    idleCashAvgPct: r.idleCashAvgPct,
    unresolvedPct,
  };
}

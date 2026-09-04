import type {
  AssetRef,
  DividendsResponse,
  EarningsCalendarEntry,
  EarningsCalendarResponse,
  EarningsResponse,
  FundamentalsQuery,
  FundamentalsRatios,
  FundamentalsResponse,
  MarketIntelCapabilities,
  MarketIntelStatusResponse,
  NewsDigestGroup,
  NewsDigestResponse,
  NewsResponse,
  SplitsResponse,
} from '@bettertrack/contracts';

import { FUNDAMENTALS_MAX_LIMIT } from '@bettertrack/contracts';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import type { MarketIntelRepository } from '../../data/repositories/marketIntelRepository';
import { notFound } from '../../errors';
import type { MarketDataService } from '../../providers';
import { ParanoidModeError, type ParanoidModeGuard } from '../account/paranoidEnforcement';
import { capRollupSubjects } from './rollupBudget';

/**
 * The per-asset market-intelligence read API (PROJECTPLAN.md §13.5 V5-P5). A
 * thin layer over the provider/cache keystone: it resolves the asset (with the
 * same §10 access scoping every other asset read uses), enforces the global
 * `MARKET_INTEL_ENABLED` gate, and returns each event family in the
 * "unconfigured" shape (`available: false`, empty) whenever the gate is off, the
 * asset's provider lacks the capability, or the upstream errored — never a 5xx.
 * The follow-up UI issues key their visibility off `available`. No UI here.
 */
export interface MarketIntelService {
  /** Capability descriptor for the asset (gate + per-capability availability). */
  capabilities(userId: string, id: string): Promise<MarketIntelStatusResponse>;
  /** Dividend history + upcoming ex/pay + forward yield (arc a). */
  dividends(userId: string, id: string): Promise<DividendsResponse>;
  /** Next + recent earnings reports (arc b). */
  earnings(userId: string, id: string): Promise<EarningsResponse>;
  /** Recent news headlines (arc c). */
  news(userId: string, id: string): Promise<NewsResponse>;
  /** Past + announced splits (arc d). */
  splits(userId: string, id: string): Promise<SplitsResponse>;
  /**
   * Revenue / statement / ratio fundamentals for the asset (arc f, INTEL1). The
   * `query` picks the period granularity (default `annual`) and an optional
   * `limit` the service clamps to 1..{@link FUNDAMENTALS_MAX_LIMIT}. Degrades to
   * `available: false` (empty periods, all-null ratios) when the gate is off, the
   * provider lacks the capability, or the upstream errored — never a 5xx.
   */
  fundamentals(userId: string, id: string, query: FundamentalsQuery): Promise<FundamentalsResponse>;
  /**
   * Upcoming-earnings calendar across the caller's held + watched assets,
   * ascending by date (the Workboard panel, arc b). Unavailable/empty when the
   * gate is off; an asset with no dated upcoming report, one whose report is
   * already in the past (or a provider without the earnings capability, or one
   * that errors) is simply dropped.
   */
  earningsCalendar(userId: string): Promise<EarningsCalendarResponse>;
  /**
   * Recent news headlines across the caller's held + watched assets, grouped per
   * asset (arc c). Groups are ordered by their newest headline and each group's
   * headlines are newest-first. Unavailable/empty when the gate is off; an asset
   * whose provider lacks the news capability (or errors, or has no headlines) is
   * simply dropped. The provider fan-out is capped per request
   * (`MARKET_INTEL_ROLLUP_MAX_ASSETS`); a book larger than the cap yields
   * `truncated: true` rather than a silently partial digest.
   */
  newsDigest(userId: string): Promise<NewsDigestResponse>;
}

export interface MarketIntelServiceDeps {
  marketData: MarketDataService;
  assetRepo: AssetRepository;
  /** Held + watched asset aggregation for the earnings calendar (arc b). */
  intelRepo: Pick<MarketIntelRepository, 'listUserWatchAndHoldAssets' | 'listUserWatchAssets'>;
  /** The `MARKET_INTEL_ENABLED` gate; false ⇒ everything reports unconfigured. */
  enabled: boolean;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
  /** Mixed kept/holding-derived calendar filtering under the account transition lock. */
  paranoid?: Pick<ParanoidModeGuard, 'runAllowed' | 'runAllowedWithOptional'>;
}

const NO_CAPABILITIES: MarketIntelCapabilities = {
  dividends: false,
  earnings: false,
  news: false,
  splits: false,
};

/** The "unconfigured" payloads — the shape the UI reads as "hide this block". */
const UNAVAILABLE_DIVIDENDS: DividendsResponse = {
  available: false,
  currency: null,
  history: [],
  upcoming: [],
  forwardYield: null,
  trailingAmount: null,
  trailingAmountBasis: null,
};
const UNAVAILABLE_EARNINGS: EarningsResponse = { available: false, next: null, recent: [] };
const UNAVAILABLE_NEWS: NewsResponse = { available: false, headlines: [] };
const UNAVAILABLE_SPLITS: SplitsResponse = { available: false, history: [], upcoming: [] };

/** All-null snapshot ratios — the shape a hidden/failed fundamentals read returns. */
const EMPTY_FUNDAMENTALS_RATIOS: FundamentalsRatios = {
  marketCap: null,
  trailingPe: null,
  forwardPe: null,
  priceToBook: null,
  profitMargin: null,
  returnOnEquity: null,
  debtToEquity: null,
  trailingEps: null,
  forwardEps: null,
};

/** The "unconfigured" fundamentals payload, echoing the requested granularity. */
function unavailableFundamentals(period: FundamentalsQuery['period']): FundamentalsResponse {
  return {
    available: false,
    currency: null,
    period,
    periods: [],
    ratios: EMPTY_FUNDAMENTALS_RATIOS,
  };
}

/** Clamp a caller's optional `limit` into 1..{@link FUNDAMENTALS_MAX_LIMIT}. */
function clampFundamentalsLimit(limit: number | undefined): number {
  if (limit === undefined) return FUNDAMENTALS_MAX_LIMIT;
  return Math.max(1, Math.min(limit, FUNDAMENTALS_MAX_LIMIT));
}

export function createMarketIntelService(deps: MarketIntelServiceDeps): MarketIntelService {
  const { marketData, assetRepo, intelRepo, enabled, paranoid } = deps;
  const now = deps.now ?? Date.now;

  /**
   * Resolve the asset to a provider ref, enforcing §10: a global asset or the
   * caller's own custom asset, else a 404 indistinguishable from missing — so
   * nothing leaks about another user's assets, even with the gate off.
   */
  const assetNotFound = () => notFound('Asset not found.', 'ASSET_NOT_FOUND');

  async function withResolvedRef<T>(
    userId: string,
    id: string,
    read: (ref: AssetRef) => Promise<T>,
  ): Promise<T> {
    const candidate = await assetRepo.findByIdForUser(id, userId);
    if (!candidate) throw assetNotFound();
    const toRef = (row: NonNullable<typeof candidate>): AssetRef => ({
      providerId: row.providerId,
      providerRef: row.providerRef,
    });
    if (candidate.ownerId === null || !paranoid) return read(toRef(candidate));
    try {
      return await paranoid.runAllowed(candidate.ownerId, 'portfolioServer', async () => {
        const current = await assetRepo.findByIdForUser(id, userId);
        if (!current || current.ownerId !== candidate.ownerId) throw assetNotFound();
        return read(toRef(current));
      });
    } catch (error) {
      if (error instanceof ParanoidModeError) throw assetNotFound();
      throw error;
    }
  }

  /** Per-capability availability, forced to all-false when the gate is off. */
  function capsFor(ref: AssetRef): MarketIntelCapabilities {
    if (!enabled) return NO_CAPABILITIES;
    return marketData.intelCapabilities(ref);
  }

  async function buildEarningsCalendar(
    userId: string,
    includeHoldings: boolean,
  ): Promise<EarningsCalendarResponse> {
    // Invisible when unconfigured: the gate off ⇒ no book scan, no entries.
    if (!enabled) return { available: false, entries: [] };

    // The paranoid branch uses a physically watchlist-only, GLOBAL-only query.
    // Filtering a combined result after the fact would still make the kept
    // calendar read killed transaction/holding rows — and the account's own
    // custom-asset symbol/name/provider ref — from the server.
    const assets = includeHoldings
      ? await intelRepo.listUserWatchAndHoldAssets(userId)
      : await intelRepo.listUserWatchAssets(userId);

    // "Upcoming" is UTC-day-based: a report dated today still belongs on the
    // panel, anything strictly before today has already happened. The guard is
    // not optional — the keystone serves a cached earnings payload stale for up
    // to STALE_TTL_SECONDS while the provider breaker is open, so a reported
    // date lingers and, being the smallest key, would sort to the very front.
    const todayStart = new Date(now()).toISOString().slice(0, 10);

    const entries: EarningsCalendarEntry[] = [];
    for (const a of assets) {
      const ref: AssetRef = { providerId: a.providerId, providerRef: a.providerRef };
      // Skip assets whose resolved provider can't serve earnings.
      if (!marketData.intelCapabilities(ref).earnings) continue;
      let next;
      try {
        const cached = await marketData.getEarningsEvents(ref);
        next = cached.value.next;
      } catch {
        // A single bad upstream degrades that asset to no-entry — never a 5xx
        // across the whole calendar (§13.5 V5-P5).
        continue;
      }
      // Only dated upcoming reports make the panel; an undated/absent next drops.
      if (!next || !next.date) continue;
      // …and so does a report that already happened (see `todayStart`).
      if (next.date.slice(0, 10) < todayStart) continue;
      entries.push({
        assetId: a.assetId,
        symbol: a.symbol,
        name: a.name,
        date: next.date,
        epsEstimate: next.epsEstimate,
        estimated: next.estimated,
        held: a.held,
        watched: a.watched,
      });
    }
    // Ascending by date — the next report first (the panel reads chronologically).
    entries.sort((x, y) => x.date.localeCompare(y.date));
    return { available: true, entries };
  }

  return {
    async capabilities(userId, id) {
      return withResolvedRef(userId, id, async (ref) => ({
        enabled,
        capabilities: capsFor(ref),
      }));
    },

    async dividends(userId, id) {
      return withResolvedRef(userId, id, async (ref) => {
        if (!capsFor(ref).dividends) return UNAVAILABLE_DIVIDENDS;
        try {
          const cached = await marketData.getDividendEvents(ref);
          return { available: true, ...cached.value };
        } catch {
          // A provider error/timeout (or an open breaker with nothing cached)
          // degrades to unavailable — never a 5xx on an asset page (§13.5 V5-P5).
          return UNAVAILABLE_DIVIDENDS;
        }
      });
    },

    async earnings(userId, id) {
      return withResolvedRef(userId, id, async (ref) => {
        if (!capsFor(ref).earnings) return UNAVAILABLE_EARNINGS;
        try {
          const cached = await marketData.getEarningsEvents(ref);
          return { available: true, ...cached.value };
        } catch {
          return UNAVAILABLE_EARNINGS;
        }
      });
    },

    async news(userId, id) {
      return withResolvedRef(userId, id, async (ref) => {
        if (!capsFor(ref).news) return UNAVAILABLE_NEWS;
        try {
          const cached = await marketData.getNewsHeadlines(ref);
          return { available: true, headlines: cached.value };
        } catch {
          return UNAVAILABLE_NEWS;
        }
      });
    },

    async splits(userId, id) {
      return withResolvedRef(userId, id, async (ref) => {
        if (!capsFor(ref).splits) return UNAVAILABLE_SPLITS;
        try {
          const cached = await marketData.getSplitEvents(ref);
          return { available: true, ...cached.value };
        } catch {
          return UNAVAILABLE_SPLITS;
        }
      });
    },

    async fundamentals(userId, id, query) {
      const period = query.period;
      const limit = clampFundamentalsLimit(query.limit);
      return withResolvedRef(userId, id, async (ref) => {
        // Gate off ⇒ invisible: never consult the provider (mirrors the four
        // families, whose `capsFor` is forced all-false when the gate is off).
        if (!enabled) return unavailableFundamentals(period);
        try {
          // `getFundamentals` rejects with CapabilityUnavailableError when the
          // asset's provider lacks the capability (no upstream call), so a
          // capability-less/Drive-only provider lands in the catch below and
          // degrades cleanly — never a 5xx.
          const cached = await marketData.getFundamentals(ref);
          const all = period === 'annual' ? cached.value.annual : cached.value.quarterly;
          return {
            available: true,
            currency: cached.value.currency,
            period,
            periods: all.slice(0, limit),
            ratios: cached.value.ratios,
          };
        } catch {
          return unavailableFundamentals(period);
        }
      });
    },

    async earningsCalendar(userId) {
      if (!paranoid) return buildEarningsCalendar(userId, true);
      // No required account: a paranoid caller keeps this route, but the optional
      // set tells the callback whether holding-derived provenance is admissible.
      // The lock remains held through provider reads and response construction.
      return paranoid.runAllowedWithOptional([], [userId], 'portfolioServer', (normalUserIds) =>
        buildEarningsCalendar(userId, normalUserIds.has(userId)),
      );
    },

    async newsDigest(userId) {
      // Invisible when unconfigured: the gate off ⇒ no book scan, no groups.
      if (!enabled) return { available: false, groups: [] };

      // One provider call per asset lands on the queue every other consumer
      // shares (§5.3), so the book is capped per request and the response says
      // when that happened. See rollupBudget.ts for the sizing and the ordering.
      const { selected, truncated } = capRollupSubjects(
        await intelRepo.listUserWatchAndHoldAssets(userId),
      );
      const groups: NewsDigestGroup[] = [];
      await Promise.all(
        selected.map(async (a) => {
          const ref: AssetRef = { providerId: a.providerId, providerRef: a.providerRef };
          // Skip assets whose resolved provider can't serve news.
          if (!marketData.intelCapabilities(ref).news) return;
          let headlines;
          try {
            headlines = (await marketData.getNewsHeadlines(ref)).value;
          } catch {
            // A single bad upstream degrades that asset to no-group — never a 5xx
            // across the whole digest (§13.5 V5-P5).
            return;
          }
          if (headlines.length === 0) return;
          // Newest-first within the group; a missing date sorts last.
          const sorted = [...headlines].sort((x, y) =>
            (y.publishedAt ?? '').localeCompare(x.publishedAt ?? ''),
          );
          groups.push({
            assetId: a.assetId,
            symbol: a.symbol,
            name: a.name,
            held: a.held,
            watched: a.watched,
            headlines: sorted,
          });
        }),
      );

      // Groups newest-first by their most recent headline; ties break on symbol
      // so the order is deterministic regardless of the fan-out resolution order.
      groups.sort((x, y) => {
        const cmp = (y.headlines[0]?.publishedAt ?? '').localeCompare(
          x.headlines[0]?.publishedAt ?? '',
        );
        return cmp !== 0 ? cmp : x.symbol.localeCompare(y.symbol);
      });
      return { available: true, groups, ...(truncated ? { truncated: true as const } : {}) };
    },
  };
}

import type {
  AssetRef,
  DividendsResponse,
  EarningsCalendarEntry,
  EarningsCalendarResponse,
  EarningsResponse,
  MarketIntelCapabilities,
  MarketIntelStatusResponse,
  NewsResponse,
  SplitsResponse,
} from '@bettertrack/contracts';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import type { MarketIntelRepository } from '../../data/repositories/marketIntelRepository';
import { notFound } from '../../errors';
import type { MarketDataService } from '../../providers';

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
   * Upcoming-earnings calendar across the caller's held + watched assets,
   * ascending by date (the Workboard panel, arc b). Unavailable/empty when the
   * gate is off; an asset with no dated upcoming report (or a provider without
   * the earnings capability, or one that errors) is simply dropped.
   */
  earningsCalendar(userId: string): Promise<EarningsCalendarResponse>;
}

export interface MarketIntelServiceDeps {
  marketData: MarketDataService;
  assetRepo: AssetRepository;
  /** Held + watched asset aggregation for the earnings calendar (arc b). */
  intelRepo: Pick<MarketIntelRepository, 'listUserWatchAndHoldAssets'>;
  /** The `MARKET_INTEL_ENABLED` gate; false ⇒ everything reports unconfigured. */
  enabled: boolean;
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
};
const UNAVAILABLE_EARNINGS: EarningsResponse = { available: false, next: null, recent: [] };
const UNAVAILABLE_NEWS: NewsResponse = { available: false, headlines: [] };
const UNAVAILABLE_SPLITS: SplitsResponse = { available: false, history: [], upcoming: [] };

export function createMarketIntelService(deps: MarketIntelServiceDeps): MarketIntelService {
  const { marketData, assetRepo, intelRepo, enabled } = deps;

  /**
   * Resolve the asset to a provider ref, enforcing §10: a global asset or the
   * caller's own custom asset, else a 404 indistinguishable from missing — so
   * nothing leaks about another user's assets, even with the gate off.
   */
  async function resolveRef(userId: string, id: string): Promise<AssetRef> {
    const row = await assetRepo.findByIdForUser(id, userId);
    if (!row) throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
    return { providerId: row.providerId, providerRef: row.providerRef };
  }

  /** Per-capability availability, forced to all-false when the gate is off. */
  function capsFor(ref: AssetRef): MarketIntelCapabilities {
    if (!enabled) return NO_CAPABILITIES;
    return marketData.intelCapabilities(ref);
  }

  return {
    async capabilities(userId, id) {
      const ref = await resolveRef(userId, id);
      return { enabled, capabilities: capsFor(ref) };
    },

    async dividends(userId, id) {
      const ref = await resolveRef(userId, id);
      if (!capsFor(ref).dividends) return UNAVAILABLE_DIVIDENDS;
      try {
        const cached = await marketData.getDividendEvents(ref);
        return { available: true, ...cached.value };
      } catch {
        // A provider error/timeout (or an open breaker with nothing cached)
        // degrades to unavailable — never a 5xx on an asset page (§13.5 V5-P5).
        return UNAVAILABLE_DIVIDENDS;
      }
    },

    async earnings(userId, id) {
      const ref = await resolveRef(userId, id);
      if (!capsFor(ref).earnings) return UNAVAILABLE_EARNINGS;
      try {
        const cached = await marketData.getEarningsEvents(ref);
        return { available: true, ...cached.value };
      } catch {
        return UNAVAILABLE_EARNINGS;
      }
    },

    async news(userId, id) {
      const ref = await resolveRef(userId, id);
      if (!capsFor(ref).news) return UNAVAILABLE_NEWS;
      try {
        const cached = await marketData.getNewsHeadlines(ref);
        return { available: true, headlines: cached.value };
      } catch {
        return UNAVAILABLE_NEWS;
      }
    },

    async splits(userId, id) {
      const ref = await resolveRef(userId, id);
      if (!capsFor(ref).splits) return UNAVAILABLE_SPLITS;
      try {
        const cached = await marketData.getSplitEvents(ref);
        return { available: true, ...cached.value };
      } catch {
        return UNAVAILABLE_SPLITS;
      }
    },

    async earningsCalendar(userId) {
      // Invisible when unconfigured: the gate off ⇒ no book scan, no entries.
      if (!enabled) return { available: false, entries: [] };

      const assets = await intelRepo.listUserWatchAndHoldAssets(userId);
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
    },
  };
}

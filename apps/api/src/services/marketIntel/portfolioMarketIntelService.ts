import type {
  AssetRef,
  DividendCalendarEntry,
  DividendCalendarResponse,
  ProjectedDividendHolding,
  ProjectedDividendIncomeResponse,
} from '@bettertrack/contracts';

import type {
  MarketIntelRepository,
  WatchedAssetRow,
} from '../../data/repositories/marketIntelRepository';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import type { CurrencyService } from '../currency/currencyService';

/**
 * The portfolio-level dividend intelligence surfaces (§13.5 V5-P5, arc a): the
 * upcoming ex/pay calendar across held + watchlist assets, and the projected
 * dividend income (monthly + yearly, EUR) for the whole portfolio. Both are
 * **pure reads** computed on demand from the provider/cache keystone — nothing
 * is stored — and both honour the global `MARKET_INTEL_ENABLED` gate exactly
 * like the per-asset reads: gate off ⇒ the "unavailable" shape (`available:
 * false`, empty) so the UI hides the blocks entirely.
 *
 * The projection basis is the provider's trailing-12-month dividend per share
 * (`trailingAmount`) as the forward estimate — the standard "assume it
 * continues" proxy — converted to EUR at the current spot rate through the §5.4
 * currency keystone. The monthly view is an even `yearly / 12` spread, the clean
 * series shape the V5-P6b Forecast will consume.
 */
export interface PortfolioMarketIntelService {
  /** Upcoming ex/pay events across held + watchlist assets, ascending (arc a). */
  dividendCalendar(userId: string): Promise<DividendCalendarResponse>;
  /** Projected dividend income for the whole portfolio, monthly + yearly EUR (arc a). */
  projectedIncome(userId: string): Promise<ProjectedDividendIncomeResponse>;
}

export interface PortfolioMarketIntelDeps {
  marketData: Pick<MarketDataService, 'intelCapabilities' | 'getDividendEvents'>;
  repo: Pick<MarketIntelRepository, 'listHeldPositionsForUser' | 'listWatchlistAssetsForUser'>;
  currency: Pick<CurrencyService, 'convert'>;
  /** The `MARKET_INTEL_ENABLED` gate; false ⇒ everything reports unavailable. */
  enabled: boolean;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
  logger?: Logger;
}

const UNAVAILABLE_CALENDAR: DividendCalendarResponse = { available: false, entries: [] };
const UNAVAILABLE_PROJECTION: ProjectedDividendIncomeResponse = {
  available: false,
  currency: 'EUR',
  monthlyTotalEur: 0,
  yearlyTotalEur: 0,
  holdings: [],
};

/** Round a monetary EUR amount to cents — the API never leaks float noise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The chronological sort key of a calendar event: its earliest known date. */
function eventSortKey(entry: DividendCalendarEntry): string {
  return entry.exDate ?? entry.payDate ?? '';
}

export function createPortfolioMarketIntelService(
  deps: PortfolioMarketIntelDeps,
): PortfolioMarketIntelService {
  const { marketData, repo, currency, enabled, logger } = deps;
  const now = deps.now ?? Date.now;

  const refOf = (row: { providerId: string; providerRef: string }): AssetRef => ({
    providerId: row.providerId,
    providerRef: row.providerRef,
  });

  return {
    async dividendCalendar(userId) {
      if (!enabled) return UNAVAILABLE_CALENDAR;

      const [held, watched] = await Promise.all([
        repo.listHeldPositionsForUser(userId),
        repo.listWatchlistAssetsForUser(userId),
      ]);

      // Held wins over watchlist for the source tag when an asset is both.
      const byAsset = new Map<string, { row: WatchedAssetRow; source: 'holding' | 'watchlist' }>();
      for (const row of held) byAsset.set(row.assetId, { row, source: 'holding' });
      for (const row of watched) {
        if (!byAsset.has(row.assetId)) byAsset.set(row.assetId, { row, source: 'watchlist' });
      }

      // "Upcoming" is any event whose earliest date is >= the start of today
      // (UTC) — an ex-date landing today still belongs on the calendar.
      const todayStart = new Date(now()).toISOString().slice(0, 10);

      const entries: DividendCalendarEntry[] = [];
      await Promise.all(
        [...byAsset.values()].map(async ({ row, source }) => {
          const ref = refOf(row);
          if (!marketData.intelCapabilities(ref).dividends) return;
          let events;
          try {
            events = (await marketData.getDividendEvents(ref)).value;
          } catch (err) {
            // A provider error/timeout degrades to "no events for this asset" —
            // the calendar never 5xxs on one bad upstream (§13.5 V5-P5).
            logger?.debug?.({ err, assetId: row.assetId }, 'dividend calendar fetch failed');
            return;
          }
          for (const event of events.upcoming) {
            const earliest = event.exDate ?? event.payDate;
            if (!earliest) continue;
            if (earliest.slice(0, 10) < todayStart) continue;
            entries.push({
              assetId: row.assetId,
              symbol: row.symbol,
              name: row.name,
              source,
              exDate: event.exDate,
              payDate: event.payDate,
              amount: event.amount,
              currency: event.currency ?? events.currency ?? row.currency,
            });
          }
        }),
      );

      entries.sort((a, b) => {
        const cmp = eventSortKey(a).localeCompare(eventSortKey(b));
        return cmp !== 0 ? cmp : a.symbol.localeCompare(b.symbol);
      });

      return { available: true, entries };
    },

    async projectedIncome(userId) {
      if (!enabled) return UNAVAILABLE_PROJECTION;

      const held = await repo.listHeldPositionsForUser(userId);

      const holdings: ProjectedDividendHolding[] = [];
      await Promise.all(
        held.map(async (row) => {
          const ref = refOf(row);
          if (!marketData.intelCapabilities(ref).dividends) return;
          let events;
          try {
            events = (await marketData.getDividendEvents(ref)).value;
          } catch (err) {
            logger?.debug?.({ err, assetId: row.assetId }, 'dividend projection fetch failed');
            return;
          }
          // Forward annual dividend per share ≈ trailing 12-month per share.
          // Nothing known ⇒ the holding contributes no projected income.
          const annualPerShare = events.trailingAmount;
          if (annualPerShare == null || annualPerShare <= 0) return;
          const divCurrency = events.currency ?? row.currency;
          const annualNative = row.quantity * annualPerShare;
          const annualEur = await currency.convert(annualNative, divCurrency, 'EUR');
          holdings.push({
            assetId: row.assetId,
            symbol: row.symbol,
            name: row.name,
            quantity: row.quantity,
            annualPerShare,
            currency: divCurrency,
            annualIncomeEur: round2(annualEur),
          });
        }),
      );

      holdings.sort((a, b) => b.annualIncomeEur - a.annualIncomeEur);
      const yearlyTotalEur = round2(holdings.reduce((sum, h) => sum + h.annualIncomeEur, 0));
      const monthlyTotalEur = round2(yearlyTotalEur / 12);

      return {
        available: true,
        currency: 'EUR',
        monthlyTotalEur,
        yearlyTotalEur,
        holdings,
      };
    },
  };
}

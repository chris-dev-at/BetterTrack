import type {
  AssetRef,
  DividendCalendarEntry,
  DividendCalendarResponse,
  DividendProjectionBasis,
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
import { marketIntelDisplayDay } from './displayDay';
import { capRollupSubjects, MARKET_INTEL_ROLLUP_MAX_ASSETS } from './rollupBudget';

/**
 * The portfolio-level dividend intelligence surfaces (§13.5 V5-P5, arc a): the
 * upcoming ex/pay calendar across held + watchlist assets, and the projected
 * dividend income (monthly + yearly, EUR) for the whole portfolio. Both are
 * **pure reads** computed on demand from the provider/cache keystone — nothing
 * is stored — and both honour the global `MARKET_INTEL_ENABLED` gate exactly
 * like the per-asset reads: gate off ⇒ the "unavailable" shape (`available:
 * false`, empty) so the UI hides the blocks entirely.
 *
 * The projection basis is the provider's annual dividend per share
 * (`trailingAmount`, whose basis the payload names) as the forward estimate —
 * the standard "assume it continues" proxy — converted **once** into the
 * caller's base currency at the current spot rate through the §5.4 currency
 * keystone. §5.4's rule is that the base is always a parameter and never a
 * literal: this read used to pin EUR, which the V5-P6b Forecast then added to a
 * base-denominated net worth. The monthly view is an even `yearly / 12` spread,
 * the clean series shape the Forecast consumes.
 *
 * That per-holding basis is also summarised onto the response (`basis`), because
 * a `trailing-12m` estimate includes any special dividend of the last twelve
 * months: 1,000 shares of a name that paid a $15 special beside its $4.64
 * regular payout project ~$19,640/yr, over four times the forward figure, and
 * for a year the surfaces called that "projected dividend income" with no
 * caveat. The number is not silently re-picked (that would lose the only figure
 * some providers give); it is published with what it is (#1790).
 */
export interface PortfolioMarketIntelService {
  /**
   * Upcoming ex/pay events across held + watchlist assets, ascending (arc a).
   * The provider fan-out is capped per request (`MARKET_INTEL_ROLLUP_MAX_ASSETS`);
   * a larger book yields `truncated: true` beside the entries it did cover.
   */
  dividendCalendar(userId: string): Promise<DividendCalendarResponse>;
  /**
   * Projected dividend income, monthly + yearly, in the caller's base currency
   * (arc a). All-or-nothing (#1616), so a book over the fan-out cap returns the
   * unavailable shape with `truncated: true` and issues no provider calls.
   *
   * Without `portfolioId` the read spans every active, non-vaulted portfolio —
   * the cross-portfolio income line the portfolio page has always shown. With
   * one it covers that portfolio alone: the V5-P6b Forecast projects a single
   * portfolio's net worth, so adding the other portfolios' dividends to that
   * curve overstates it.
   */
  projectedIncome(
    userId: string,
    opts?: ProjectedIncomeOptions,
  ): Promise<ProjectedDividendIncomeResponse>;
}

/** Per-request narrowing + denomination for {@link PortfolioMarketIntelService.projectedIncome}. */
export interface ProjectedIncomeOptions {
  /** Narrow the read to ONE portfolio (what the Forecast needs); omitted ⇒ user-wide. */
  portfolioId?: string;
  /**
   * The caller's base currency (§5.4 — "always a parameter"). Omitted ⇒ the
   * currency service's own default, which keeps a caller that has no user
   * context on the historical EUR behaviour.
   */
  baseCurrency?: string;
}

export interface PortfolioMarketIntelDeps {
  marketData: Pick<MarketDataService, 'intelCapabilities' | 'getDividendEvents'>;
  repo: Pick<MarketIntelRepository, 'listHeldPositionsForUser' | 'listWatchlistAssetsForUser'>;
  /**
   * The §5.4 conversion keystone. `withBase` is what lets the projection answer
   * in the CALLER's base instead of a hardcoded EUR, over the very same
   * FxRateSource (so the §5.3 caches and coalescing stay shared).
   */
  currency: Pick<CurrencyService, 'baseCurrency' | 'toBase' | 'withBase'>;
  /** The `MARKET_INTEL_ENABLED` gate; false ⇒ everything reports unavailable. */
  enabled: boolean;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
  logger?: Logger;
}

/** A conversion view already pinned to one base — all the projection needs of it. */
type ProjectionFx = Pick<CurrencyService, 'baseCurrency' | 'toBase'>;

const UNAVAILABLE_CALENDAR: DividendCalendarResponse = { available: false, entries: [] };

/**
 * The unavailable projection. `currency` still names the base those zeros are
 * in: a UI that renders "€0.00" to a USD user is the same mislabel the totals
 * used to carry.
 */
function unavailableProjection(currency: string): ProjectedDividendIncomeResponse {
  return {
    available: false,
    currency,
    monthlyTotalBase: 0,
    yearlyTotalBase: 0,
    basis: null,
    holdings: [],
  };
}

/**
 * What the total is made of (#1790). The projection does NOT refuse a book whose
 * holdings carry different bases — providers populate whichever annual per-share
 * field they have, so refusing would blank the whole figure for most real books
 * — it names the mix instead, and the surfaces render that beside the number.
 * Null when nothing contributed: an empty total describes no basis at all.
 */
function projectionBasis(holdings: ProjectedDividendHolding[]): DividendProjectionBasis | null {
  const bases = new Set(holdings.map((h) => h.annualPerShareBasis));
  if (bases.size === 0) return null;
  if (bases.size > 1) return 'mixed';
  return [...bases][0]!;
}

/** Round a monetary amount to cents — the API never leaks float noise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The event's known dates, day-only (UTC), in no particular order. */
function eventDays(entry: Pick<DividendCalendarEntry, 'exDate' | 'payDate'>): string[] {
  const days: string[] = [];
  if (entry.exDate) days.push(entry.exDate.slice(0, 10));
  if (entry.payDate) days.push(entry.payDate.slice(0, 10));
  return days;
}

/**
 * The chronological sort key of a calendar event: the earliest of its dates
 * that has not yet passed. An event that has already gone ex but is not yet
 * paid is still upcoming and sorts on its **pay** date — the date the widget
 * shows for it — not on the ex-date already behind us.
 */
function eventSortKey(entry: DividendCalendarEntry, todayStart: string): string {
  let key = '';
  for (const day of eventDays(entry)) {
    if (day < todayStart) continue;
    if (key === '' || day < key) key = day;
  }
  return key;
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

  /**
   * The §5.4 conversion view for a request's effective base: the caller's
   * per-user base when supplied, the service default otherwise. Same idiom (and
   * the same shared FxRateSource) as `portfolioService.fxFor`.
   */
  const fxFor = (base?: string): ProjectionFx =>
    base === undefined ? currency : currency.withBase(base);

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

      // "Upcoming" is any event with at least one date >= the start of today in
      // the DISPLAY zone (see displayDay.ts) — an ex-date landing today still
      // belongs on the calendar, and so does an event that has already gone ex
      // but whose payout is still to come: that pay date is exactly what the
      // Home widget renders for it. The day has to be the one the entry is
      // rendered in, or between 00:00 and 02:00 Vienna the calendar serves a
      // payout that went ex yesterday under an "Upcoming" heading.
      const todayStart = marketIntelDisplayDay(now());

      // One provider call per asset lands on the queue every other consumer
      // shares (§5.3), so the book is capped per request and the response says
      // when that happened. See rollupBudget.ts for the sizing and the ordering.
      const { selected, truncated } = capRollupSubjects(
        [...byAsset.values()].map(({ row, source }) => ({
          ...row,
          source,
          held: source === 'holding',
        })),
      );

      const entries: DividendCalendarEntry[] = [];
      await Promise.all(
        selected.map(async (row) => {
          const source = row.source;
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
            if (!eventDays(event).some((day) => day >= todayStart)) continue;
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
        const cmp = eventSortKey(a, todayStart).localeCompare(eventSortKey(b, todayStart));
        return cmp !== 0 ? cmp : a.symbol.localeCompare(b.symbol);
      });

      return { available: true, entries, ...(truncated ? { truncated: true as const } : {}) };
    },

    async projectedIncome(userId, opts) {
      // Resolved BEFORE the gate check so every exit — including the ones that
      // publish nothing — declares the denomination its zeros are in.
      const fx = fxFor(opts?.baseCurrency);
      if (!enabled) return unavailableProjection(fx.baseCurrency);

      const held = await repo.listHeldPositionsForUser(userId, opts?.portfolioId);

      // The projection is all-or-nothing (#1616): a total that misses holdings
      // is never published. So a book over the fan-out cap can only ever produce
      // an unavailable response — refuse it BEFORE spending any of the shared
      // provider budget (§5.3) on payloads that would be discarded anyway, and
      // flag `truncated` so the caller can tell "too large to compute" apart
      // from "one holding could not be resolved".
      if (held.length > MARKET_INTEL_ROLLUP_MAX_ASSETS) {
        return { ...unavailableProjection(fx.baseCurrency), truncated: true as const };
      }

      const holdings: ProjectedDividendHolding[] = [];
      // Set by any holding whose contribution could NOT be resolved — a provider
      // error, a half-filled payload, or a failed conversion. Distinct from a
      // holding that resolved to "pays nothing", which contributes a real zero.
      let hasUnresolvedHolding = false;
      await Promise.all(
        held.map(async (row) => {
          const ref = refOf(row);
          // No dividend capability for this asset (a manual/custom holding, say)
          // is a KNOWN zero, not a gap: nothing upstream could have told us more.
          if (!marketData.intelCapabilities(ref).dividends) return;
          let events;
          try {
            events = (await marketData.getDividendEvents(ref)).value;
          } catch (err) {
            hasUnresolvedHolding = true;
            logger?.debug?.({ err, assetId: row.assetId }, 'dividend projection fetch failed');
            return;
          }
          // Forward annual dividend per share ≈ trailing 12-month per share.
          const annualPerShare = events.trailingAmount;
          if (annualPerShare == null) {
            // Null carries two very different meanings. A payload that shows the
            // asset paying dividends (history/upcoming) but carries no per-share
            // amount is a HALF-FAILED fetch — the yahoo provider settles its two
            // halves independently and keeps the survivor, and `trailingAmount`
            // comes only from the summary half. That gap must not silently
            // shrink the total. A payload with no dividend activity at all is a
            // non-payer: a real zero contribution.
            if (events.history.length > 0 || events.upcoming.length > 0) {
              hasUnresolvedHolding = true;
              logger?.debug?.(
                { assetId: row.assetId },
                'dividend projection: partial payload, no trailing amount',
              );
            }
            return;
          }
          if (annualPerShare <= 0) return;
          // Contract invariant: the basis is null exactly when the amount is. A
          // payload that breaks it carries a number nobody can describe — and
          // the two bases differ by a large factor right after a special
          // dividend — so it is a gap, not a silently-trusted figure.
          const basis = events.trailingAmountBasis;
          if (basis == null) {
            hasUnresolvedHolding = true;
            logger?.debug?.(
              { assetId: row.assetId },
              'dividend projection: per-share amount without a basis',
            );
            return;
          }
          const divCurrency = events.currency ?? row.currency;
          const annualNative = row.quantity * annualPerShare;
          // Exactly ONE conversion, native → the caller's base, through the §5.4
          // keystone (identity for a holding already in that base).
          let annualBase: number;
          try {
            annualBase = await fx.toBase(annualNative, divCurrency);
          } catch (err) {
            hasUnresolvedHolding = true;
            logger?.debug?.(
              { err, assetId: row.assetId, currency: divCurrency, base: fx.baseCurrency },
              'dividend projection FX conversion failed',
            );
            return;
          }
          holdings.push({
            assetId: row.assetId,
            symbol: row.symbol,
            name: row.name,
            quantity: row.quantity,
            annualPerShare,
            currency: divCurrency,
            annualPerShareBasis: basis,
            annualIncomeBase: round2(annualBase),
          });
        }),
      );

      // The response has no partial-completeness state. Resolve every holding,
      // but make the entire projection unavailable when any of them could not be
      // resolved — a provider error, a half-filled payload, or a failed
      // conversion — so a smaller total is never presented as complete income
      // (it also feeds the V5-P6b Forecast).
      if (hasUnresolvedHolding) return unavailableProjection(fx.baseCurrency);

      holdings.sort((a, b) => b.annualIncomeBase - a.annualIncomeBase);
      const yearlyTotalBase = round2(holdings.reduce((sum, h) => sum + h.annualIncomeBase, 0));
      const monthlyTotalBase = round2(yearlyTotalBase / 12);

      return {
        available: true,
        currency: fx.baseCurrency,
        monthlyTotalBase,
        yearlyTotalBase,
        basis: projectionBasis(holdings),
        holdings,
      };
    },
  };
}

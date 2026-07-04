import type { HistoryRange } from '@bettertrack/contracts';

import { historyTtlSeconds, rangeStartMs, type MarketDataService } from '../../providers';
import { FxRateUnavailableError, type FxRateSource } from './currencyService';

/**
 * {@link FxRateSource} backed by cached Yahoo quotes (PROJECTPLAN.md §5.4).
 *
 * Yahoo exposes FX as ordinary symbols of the form `EUR{CCY}=X`, whose price is
 * "CCY per 1 EUR". We always cross through EUR rather than relying on a direct
 * `{FROM}{TO}=X` pair existing:
 *
 *   - `eurFromRate` = price of `EUR{from}=X` = `from` per EUR (1.0 when from==EUR)
 *   - `eurToRate`   = price of `EUR{to}=X`   = `to`   per EUR (1.0 when to==EUR)
 *   - rate(from→to) = eurToRate / eurFromRate = `to` per 1 `from`
 *
 * Spot legs come from the cached quote path; historical legs come from the
 * pair's *daily close history* through the same provider keystone (§5.3 —
 * cached/coalesced/serve-stale), so a backtest's dated conversions never make
 * one sync upstream call per day. The {@link CurrencyService} normalises codes
 * and applies its own finite/>0 guard on the returned rate, so this source only
 * needs to validate the raw leg prices it fetches.
 *
 * Historical legs that cannot be produced (provider hard-down past the stale
 * window, no close on/near the date) throw {@link FxRateUnavailableError} so
 * callers can degrade deliberately instead of 500ing; spot legs keep their
 * original propagate-the-quote-error behaviour.
 */

/**
 * FX trades Mon–Fri, so an equity trading day can miss an FX close by a weekend
 * or a holiday cluster. A dated leg falls back to the nearest *prior* close
 * within this many calendar days; a wider gap means the data is genuinely
 * missing and the leg fails loud rather than silently applying a stale rate.
 */
export const FX_NEAREST_PRIOR_MAX_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily-close ranges from narrowest to widest. A leg fetches the narrowest
 * window that still covers `date` (minus the nearest-prior margin); sub-month
 * ranges are skipped — their §5.3 default candles are intraday and a month of
 * daily closes is the smallest series worth caching.
 */
const RANGE_LADDER: readonly HistoryRange[] = ['1M', '6M', '1Y', '5Y', 'MAX'];

/** In-memory memo of one pair's parsed day→close map (see `seriesMemo`). */
interface SeriesEntry {
  /** Position in {@link RANGE_LADDER} — a wider cached window serves narrower needs. */
  ladderRank: number;
  expiresAt: number;
  closes: Promise<ReadonlyMap<string, number>>;
}

export interface CreateMarketDataFxSourceOptions {
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

export function createMarketDataFxSource(
  marketData: MarketDataService,
  options: CreateMarketDataFxSourceOptions = {},
): FxRateSource {
  const now = options.now ?? Date.now;

  /** Price of `EUR{ccy}=X` ("ccy per 1 EUR"), or 1.0 when ccy is EUR itself. */
  async function eurLegRate(ccy: string): Promise<number> {
    if (ccy === 'EUR') return 1;
    const cached = await marketData.getQuote({
      providerId: 'yahoo',
      providerRef: `EUR${ccy}=X`,
    });
    const rate = cached.value.price;
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`FX leg EUR${ccy}=X returned an invalid rate ${rate}`);
    }
    return rate;
  }

  /**
   * Parsed daily closes per currency. The provider layer already caches the raw
   * series in Redis, but a backtest resolves one rate per (currency, trading
   * day) — thousands of lookups — so re-fetching and re-parsing the same series
   * per day would be pure overhead. Memoising the *promise* also coalesces
   * concurrent legs within this process; entries expire on the same freshness
   * TTL the provider cache uses for the fetched range.
   */
  const seriesMemo = new Map<string, SeriesEntry>();

  /** Daily closes of `EUR{ccy}=X` covering at least `RANGE_LADDER[ladderRank]`. */
  function dailyCloses(ccy: string, ladderRank: number): Promise<ReadonlyMap<string, number>> {
    const nowMs = now();
    const existing = seriesMemo.get(ccy);
    if (existing && existing.expiresAt > nowMs && existing.ladderRank >= ladderRank) {
      return existing.closes;
    }

    const range = RANGE_LADDER[ladderRank] ?? 'MAX';
    const closes = marketData
      .getHistory({ providerId: 'yahoo', providerRef: `EUR${ccy}=X` }, range, '1d')
      .then((cached) => {
        // Last candle of a calendar day wins; garbage closes (non-finite, ≤0)
        // are dropped so the nearest-prior fallback skips past them.
        const byDate = new Map<string, number>();
        for (const p of cached.value) {
          if (!Number.isFinite(p.close) || p.close <= 0) continue;
          byDate.set(p.time.slice(0, 10), p.close);
        }
        return byDate;
      });

    const entry: SeriesEntry = {
      ladderRank,
      expiresAt: nowMs + historyTtlSeconds(range) * 1000,
      closes,
    };
    seriesMemo.set(ccy, entry);
    // A failed fetch must not poison the memo for its whole TTL — drop it so
    // the next lookup retries through the provider layer.
    closes.catch(() => {
      if (seriesMemo.get(ccy) === entry) seriesMemo.delete(ccy);
    });
    return closes;
  }

  /** Narrowest ladder rank whose window covers `dateMs` incl. fallback margin. */
  function ladderRankCovering(dateMs: number): number {
    const needed = dateMs - FX_NEAREST_PRIOR_MAX_DAYS * DAY_MS;
    const nowMs = now();
    for (let rank = 0; rank < RANGE_LADDER.length; rank++) {
      const range = RANGE_LADDER[rank] ?? 'MAX';
      if (range === 'MAX' || rangeStartMs(nowMs, range) <= needed) return rank;
    }
    return RANGE_LADDER.length - 1;
  }

  /** Historical close of `EUR{ccy}=X` on `date`, or the nearest prior close. */
  async function eurLegRateAt(ccy: string, date: string, dateMs: number): Promise<number> {
    if (ccy === 'EUR') return 1;

    let closes: ReadonlyMap<string, number>;
    try {
      closes = await dailyCloses(ccy, ladderRankCovering(dateMs));
    } catch (err) {
      throw new FxRateUnavailableError(
        'EUR',
        ccy,
        date,
        `FX history for EUR${ccy}=X is unavailable (provider unreachable and no cached copy).`,
        err,
      );
    }

    for (let back = 0; back <= FX_NEAREST_PRIOR_MAX_DAYS; back++) {
      const day = new Date(dateMs - back * DAY_MS).toISOString().slice(0, 10);
      const close = closes.get(day);
      if (close !== undefined) return close;
    }
    throw new FxRateUnavailableError(
      'EUR',
      ccy,
      date,
      `No EUR${ccy}=X close on or within ${FX_NEAREST_PRIOR_MAX_DAYS} days before ${date}.`,
    );
  }

  return {
    async getSpotRate(from, to) {
      // Codes arrive already normalised (3-char uppercase ISO-4217) from the
      // currency service. Cross through EUR; result is "to per 1 from".
      const [eurFromRate, eurToRate] = await Promise.all([eurLegRate(from), eurLegRate(to)]);
      return eurToRate / eurFromRate;
    },

    async getHistoricalRate(from, to, date) {
      const dateMs = Date.parse(`${date}T00:00:00.000Z`);
      if (!Number.isFinite(dateMs)) {
        // Caller bug, not a data state — fail loud like an invalid currency code.
        throw new Error(`Invalid ISO date for historical FX rate: ${JSON.stringify(date)}`);
      }
      const [eurFromRate, eurToRate] = await Promise.all([
        eurLegRateAt(from, date, dateMs),
        eurLegRateAt(to, date, dateMs),
      ]);
      return eurToRate / eurFromRate;
    },
  };
}

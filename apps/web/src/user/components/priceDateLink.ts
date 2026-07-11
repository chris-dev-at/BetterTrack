import type { PricePoint } from '@bettertrack/contracts';

/**
 * Pure date ↔ price resolution over a cached daily close series, for the
 * transaction dialog's linked fields (#226). All lookups run client-side against
 * an already-fetched series (`GET /assets/:id/daily-closes`) — no provider call
 * per keystroke (§5.3). Daily granularity only; intraday is out of scope.
 */

/** One daily close, keyed by calendar day (`YYYY-MM-DD`). Series are ascending. */
export interface DailyPoint {
  date: string;
  close: number;
}

/**
 * Normalize wire price points (ISO-8601 `time`) into ascending, day-keyed
 * closes. A duplicate day keeps the last point seen (the freshest close), and
 * the result is sorted so lexicographic `YYYY-MM-DD` comparison is monotonic.
 */
export function toDailyPoints(points: readonly PricePoint[]): DailyPoint[] {
  const byDay = new Map<string, number>();
  for (const p of points) {
    if (!Number.isFinite(p.close)) continue;
    byDay.set(p.time.slice(0, 10), p.close);
  }
  return [...byDay.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface PriceForDate {
  /** The close on the resolved trading day. */
  price: number;
  /** The series day actually used (`YYYY-MM-DD`). */
  date: string;
  /**
   * True when the requested date had no point (weekend/holiday, or simply
   * missing) and the last trading day at/before it was used instead.
   */
  adjusted: boolean;
}

/**
 * Close for `date`, or — when `date` was not a trading day — the last trading
 * day's close at/before it (§5.3). Returns `null` when `date` precedes all
 * available history (nothing to fall back to), so the caller leaves the price
 * untouched rather than guessing.
 */
export function priceForDate(series: readonly DailyPoint[], date: string): PriceForDate | null {
  let match: DailyPoint | null = null;
  for (const p of series) {
    if (p.date <= date) match = p;
    else break; // ascending — once we pass `date` nothing later can match
  }
  if (!match) return null;
  return { price: match.close, date: match.date, adjusted: match.date !== date };
}

export interface DateForPrice {
  /** The most recent day the series was at (or crossed) the entered price. */
  date: string;
  /** That day's close. */
  close: number;
}

/**
 * The **most recent** day whose close-to-close range contains `price`. With no
 * OHLC in the daily series (§5.2 stores closes only), a price is "at" a day when
 * it lies between the previous close and that day's close — i.e. the day the
 * series crossed through it. Scans newest-first and returns the first hit.
 *
 * Returns `null` when the series never reached `price` in available history, so
 * the caller keeps the date unchanged and says so — it never guesses a date.
 */
export function dateForPrice(series: readonly DailyPoint[], price: number): DateForPrice | null {
  if (!Number.isFinite(price)) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const cur = series[i]!;
    // Exact hit on this day's close (covers a single-point series, which has no
    // pair to cross).
    if (cur.close === price) return { date: cur.date, close: cur.close };
    if (i > 0) {
      const prev = series[i - 1]!;
      const lo = Math.min(prev.close, cur.close);
      const hi = Math.max(prev.close, cur.close);
      // Strict interior: a boundary value equals one of the two closes and so
      // belongs to *that* day's own exact check, not to this crossing — this
      // keeps an exact historical close attributed to the day it closed at
      // rather than the later day it was merely a starting point for.
      if (price > lo && price < hi) {
        // The crossing lands on `cur` — the day the series reached the price.
        return { date: cur.date, close: cur.close };
      }
    }
  }
  return null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Short weekday name (`Mon`…`Sun`) for a `YYYY-MM-DD` day, computed in UTC. */
export function weekdayShort(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  return WEEKDAYS[d.getUTCDay()] ?? '';
}

import { computeTwrStats } from '@bettertrack/domain/seriesStats';

/**
 * Shared shaping for the client-derived value series (docs/paranoid-design.md
 * §10 + §8 item 12). A paranoid account has no server series endpoint, so every
 * surface that used to read `analytics/…/series` samples the vault's own
 * net-worth curve instead — and each of them has to apply the same trimming the
 * server applies before the numbers mean anything.
 */

/**
 * Trim leading/trailing non-positive points, exactly like the server's
 * `trimZeroValueEdges`. Without it a window that opens before the first held
 * day starts at 0, and every downstream number collapses: `computeSeriesStats`
 * cannot state a CAGR from a zero base and the perf rebase flattens the whole
 * curve to 0 %.
 */
export function trimZeroValueEdges<T extends { valueEur: number }>(points: readonly T[]): T[] {
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi && (points[lo]?.valueEur ?? 0) <= 0) lo += 1;
  while (hi >= lo && (points[hi]?.valueEur ?? 0) <= 0) hi -= 1;
  return points.slice(lo, hi + 1);
}

/**
 * The annualised **time-weighted** return of a client-derived performance
 * curve, or `null` when the window cannot state one (#1759).
 *
 * This replaced a `clientSeriesCagrPct` that annualised the vault's own VALUE
 * curve: that number rises with every deposit the user made, so a saver read
 * their own contributions back as return and the forecast then compounded them
 * on top of the contributions themselves. The vault engine computes the same
 * TWR the server does (`clientMoney`'s server-parity vectors), so a paranoid
 * account can sample a real rate of return instead. No zero-edge trim is needed
 * here: a performance curve carries no value scale to be zeroed, and the domain
 * rebases onto the window's own first point.
 */
export function clientSeriesTwrCagrPct(
  performance: readonly { date: string; pct: number }[],
): number | null {
  return computeTwrStats(performance)?.cagrPct ?? null;
}

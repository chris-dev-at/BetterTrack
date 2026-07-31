import { computeSeriesStats } from '@bettertrack/domain/seriesStats';

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
 * The annualised return of a client-derived value series, or `null` when it
 * cannot be stated (empty/one-point window, or a window that never held value).
 * The zero-edge trim is applied here so the forecast prefill and the analytics
 * header cannot disagree about the same curve — the trim is what makes the
 * first sampled point the first day the portfolio actually held value.
 */
export function clientSeriesCagrPct(
  points: readonly { date: string; valueEur: number }[],
): number | null {
  const trimmed = trimZeroValueEdges(points);
  if (trimmed.length === 0) return null;
  return computeSeriesStats(trimmed.map((point) => ({ date: point.date, value: point.valueEur })))
    .cagrPct;
}

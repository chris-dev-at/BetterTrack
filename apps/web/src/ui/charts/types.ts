import type { Time } from 'lightweight-charts';

/**
 * Shared chart prop types for the reusable charting core (PROJECTPLAN.md §7.3).
 *
 * These components are *pure presentational wrappers* — they take data via
 * props and never fetch. Real quotes/history are wired in later once the
 * provider core (#8) and the asset/quote/history endpoints land (§6.3/§6.4).
 */

/** A single point on a price/time series. `time` is a `lightweight-charts`
 * `Time` (an ISO `YYYY-MM-DD` day string or a UNIX timestamp). */
export interface ChartPoint {
  time: Time;
  value: number;
}

/** Range tokens for the {@link PriceChart} toggle (PROJECTPLAN.md §6.3). The
 * parent owns data fetching per range; the chart only surfaces the choice. */
export const PRICE_RANGES = ['1D', '1W', '1M', '6M', '1Y', '5Y', 'Max'] as const;
export type PriceRange = (typeof PRICE_RANGES)[number];

/** Drawing mode: `area` for market assets, `step` for custom assets whose
 * value points carry forward between sparse entries (PROJECTPLAN.md §6.3). */
export type PriceChartMode = 'area' | 'step';

/** An optional second series drawn over the main one (PROJECTPLAN.md §6.6). */
export interface BenchmarkSeries {
  label: string;
  series: ChartPoint[];
}

/** One slice of an {@link AllocationDonut} (PROJECTPLAN.md §6.5/§6.9). */
export interface AllocationSegment {
  label: string;
  /** Weight or amount; relative size within the donut. Must be ≥ 0. */
  value: number;
  /** Optional explicit colour; falls back to the built-in palette. */
  color?: string;
}

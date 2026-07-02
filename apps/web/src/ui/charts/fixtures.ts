import type { AllocationSegment, BenchmarkSeries, ChartPoint } from './types';

/**
 * Deterministic demo data for the chart components — used by their unit tests
 * and by future Storybook-style previews. No randomness or wall-clock reads, so
 * snapshots and tests stay stable. Real data arrives via props once the
 * provider core (#8) and endpoints land.
 */

/** A daily area series for a market asset (PROJECTPLAN.md §6.3). */
export const samplePriceSeries: ChartPoint[] = [
  { time: '2026-01-02', value: 102.4 },
  { time: '2026-01-05', value: 103.1 },
  { time: '2026-01-06', value: 101.7 },
  { time: '2026-01-07', value: 104.9 },
  { time: '2026-01-08', value: 106.2 },
  { time: '2026-01-09', value: 105.4 },
  { time: '2026-01-12', value: 108.0 },
  { time: '2026-01-13', value: 109.3 },
  { time: '2026-01-14', value: 107.6 },
  { time: '2026-01-15', value: 110.8 },
];

/** A custom asset's sparse value points — drawn as a step line (§6.3/§6.9). */
export const sampleStepSeries: ChartPoint[] = [
  { time: '2025-09-01', value: 250000 },
  { time: '2025-12-01', value: 250000 },
  { time: '2026-03-01', value: 262500 },
  { time: '2026-06-01', value: 270000 },
];

/** A benchmark overlay, e.g. an index normalised alongside (§6.6). */
export const sampleBenchmarkSeries: BenchmarkSeries = {
  label: 'S&P 500',
  series: [
    { time: '2026-01-02', value: 100.0 },
    { time: '2026-01-05', value: 100.6 },
    { time: '2026-01-06', value: 100.2 },
    { time: '2026-01-07', value: 101.5 },
    { time: '2026-01-08', value: 102.1 },
    { time: '2026-01-09', value: 101.8 },
    { time: '2026-01-12', value: 103.0 },
    { time: '2026-01-13', value: 103.4 },
    { time: '2026-01-14', value: 102.9 },
    { time: '2026-01-15', value: 104.2 },
  ],
};

/** Per-asset overlay series for the portfolio graph's compare mode (#122). */
export const sampleOverlaySeries: BenchmarkSeries[] = [
  {
    label: 'BAYN.DE',
    series: [
      { time: '2026-01-02', value: 28.4 },
      { time: '2026-01-05', value: 27.9 },
      { time: '2026-01-06', value: 27.1 },
    ],
  },
  {
    label: 'AAPL',
    series: [
      { time: '2026-01-02', value: 250.2 },
      { time: '2026-01-05', value: 252.8 },
      { time: '2026-01-06', value: 249.9 },
    ],
  },
];

/** A short 1-month sparkline series for the workboard watchlist (§6.4). */
export const sampleSparkline: number[] = [
  27.4, 27.9, 28.3, 28.1, 27.6, 28.8, 29.2, 29.0, 29.7, 30.1, 29.8, 30.6,
];

/** A by-asset allocation breakdown for the donut (§6.5/§6.9). */
export const sampleAllocation: AllocationSegment[] = [
  { label: 'BAYN.DE', value: 32.5 },
  { label: 'AAPL', value: 25 },
  { label: 'VWCE.DE', value: 22.5 },
  { label: 'TEM', value: 12.5 },
  { label: 'Cash', value: 7.5 },
];

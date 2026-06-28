import {
  AreaSeries,
  ColorType,
  createChart,
  LineSeries,
  LineType,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';

import { Spinner } from '../../user/components/ui';
import { cx } from '../../lib/cx';
import {
  PRICE_RANGES,
  type BenchmarkSeries,
  type ChartPoint,
  type PriceChartMode,
  type PriceRange,
} from './types';

export interface PriceChartProps {
  /** The price/time series to draw. Empty ⇒ empty state. */
  series: ChartPoint[];
  /** `area` (market assets) or `step` (custom assets). Defaults to `area`. */
  mode?: PriceChartMode;
  /** Controlled selected range. Omit to let the chart manage its own. */
  range?: PriceRange;
  /** Initial range when uncontrolled. Defaults to `1M`. */
  defaultRange?: PriceRange;
  /**
   * Range tokens to offer in the toggle. Defaults to the full {@link PRICE_RANGES}
   * set; the Portfolio value-over-time chart restricts it to `1M/6M/1Y/Max`
   * (PROJECTPLAN.md §6.9).
   */
  ranges?: readonly PriceRange[];
  /** Notified whenever the user picks a range (the parent refetches). */
  onRangeChange?: (range: PriceRange) => void;
  /** Optional overlay series, e.g. a benchmark index (PROJECTPLAN.md §6.6). */
  benchmark?: BenchmarkSeries | null;
  /** Show a spinner instead of the chart (parent is fetching). */
  loading?: boolean;
  /** Chart height in px. Defaults to 320. */
  height?: number;
  className?: string;
  /** Accessible label for the chart region. */
  ariaLabel?: string;
}

// Palette tuned for the dark UI shell (matches the sky/emerald accents).
const MAIN_LINE = '#38bdf8'; // sky-400
const MAIN_AREA_TOP = 'rgba(56, 189, 248, 0.35)';
const MAIN_AREA_BOTTOM = 'rgba(56, 189, 248, 0.02)';
const BENCHMARK_LINE = '#a78bfa'; // violet-400
const GRID = 'rgba(82, 82, 91, 0.25)'; // neutral-600 @ 25%
const TEXT = '#a1a1aa'; // neutral-400

/**
 * `lightweight-charts` wrapper with a range toggle, area/step modes and an
 * optional benchmark overlay (PROJECTPLAN.md §7.3, consumed by §6.3/§6.6).
 *
 * The chart instance is created once per `mode`/`benchmark`/`height` shape and
 * disposed on unmount or reshape (`chart.remove()`), so there are no leaks when
 * the asset detail page navigates away. Data updates flow through `setData`
 * without tearing the instance down.
 */
export function PriceChart({
  series,
  mode = 'area',
  range,
  defaultRange = '1M',
  ranges = PRICE_RANGES,
  onRangeChange,
  benchmark = null,
  loading = false,
  height = 320,
  className,
  ariaLabel = 'Price chart',
}: PriceChartProps) {
  // Controlled when `range` is provided; otherwise track internally so the
  // toggle works standalone (and in tests with no parent).
  const [internalRange, setInternalRange] = useState<PriceRange>(range ?? defaultRange);
  const activeRange = range ?? internalRange;

  function selectRange(next: PriceRange) {
    if (range === undefined) setInternalRange(next);
    onRangeChange?.(next);
  }

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<'Area'> | ISeriesApi<'Line'> | null>(null);
  const benchRef = useRef<ISeriesApi<'Line'> | null>(null);

  const isEmpty = series.length === 0;
  const hasBenchmark = benchmark !== null && benchmark.series.length > 0;

  // Create / tear down the chart instance. Keyed on the *shape* (mode, presence
  // of a benchmark, height) rather than the data, so wiggling data is cheap.
  useEffect(() => {
    if (loading || isEmpty) return;
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: TEXT,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      rightPriceScale: { borderColor: GRID },
      timeScale: { borderColor: GRID, fixLeftEdge: true, fixRightEdge: true },
      handleScale: false,
      handleScroll: false,
    });
    chartRef.current = chart;

    if (mode === 'step') {
      mainRef.current = chart.addSeries(LineSeries, {
        color: MAIN_LINE,
        lineWidth: 2,
        lineType: LineType.WithSteps,
        priceLineVisible: false,
      });
    } else {
      mainRef.current = chart.addSeries(AreaSeries, {
        lineColor: MAIN_LINE,
        topColor: MAIN_AREA_TOP,
        bottomColor: MAIN_AREA_BOTTOM,
        lineWidth: 2,
        priceLineVisible: false,
      });
    }

    if (hasBenchmark) {
      benchRef.current = chart.addSeries(LineSeries, {
        color: BENCHMARK_LINE,
        lineWidth: 1,
        lineStyle: 2, // dashed
        priceLineVisible: false,
        lastValueVisible: false,
      });
    }

    // Keep the chart sized to its container across responsive layout changes.
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    observer.observe(el);
    chart.applyOptions({ width: el.clientWidth || undefined });

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      benchRef.current = null;
    };
  }, [mode, hasBenchmark, height, loading, isEmpty]);

  // Push data into the existing series instances; refit the visible window.
  useEffect(() => {
    if (mainRef.current) mainRef.current.setData(series);
    if (benchRef.current && benchmark) benchRef.current.setData(benchmark.series);
    chartRef.current?.timeScale().fitContent();
  }, [series, benchmark]);

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between gap-3">
        <RangeToggle active={activeRange} ranges={ranges} onSelect={selectRange} />
        {hasBenchmark ? (
          <span className="flex items-center gap-1.5 text-xs text-neutral-400">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-4"
              style={{ backgroundColor: BENCHMARK_LINE }}
            />
            {benchmark.label}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="grid place-items-center rounded-md bg-neutral-900/40" style={{ height }}>
          <Spinner label="Loading chart…" />
        </div>
      ) : isEmpty ? (
        <div
          role="status"
          className="grid place-items-center rounded-md bg-neutral-900/40 text-sm text-neutral-500"
          style={{ height }}
        >
          No price data for this range yet.
        </div>
      ) : (
        <div
          ref={containerRef}
          role="img"
          aria-label={ariaLabel}
          className="w-full"
          style={{ height }}
        />
      )}
    </div>
  );
}

function RangeToggle({
  active,
  ranges,
  onSelect,
}: {
  active: PriceRange;
  ranges: readonly PriceRange[];
  onSelect: (range: PriceRange) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Select chart range"
      className="inline-flex rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
    >
      {ranges.map((token) => {
        const selected = token === active;
        return (
          <button
            key={token}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(token)}
            className={cx(
              'rounded px-2 py-1 text-xs font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              selected
                ? 'bg-sky-600 text-white'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
            )}
          >
            {token}
          </button>
        );
      })}
    </div>
  );
}

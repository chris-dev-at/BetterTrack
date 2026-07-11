import {
  AreaSeries,
  BaselineSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineType,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';

import { Spinner } from '../../user/components/ui';
import { cx } from '../../lib/cx';
import { formatPercent } from '../../lib/format';
import {
  PRICE_RANGES,
  type BenchmarkSeries,
  type ChartMarker,
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
  /**
   * Hide the built-in range toggle when a caller drives its own range
   * selector over a different token set (e.g. the backtest panel's
   * 1Y/3Y/5Y/Max, PROJECTPLAN.md §6.5/§6.6). Defaults to `true`.
   */
  showRangeToggle?: boolean;
  /** Optional overlay series, e.g. a benchmark index (PROJECTPLAN.md §6.6). */
  benchmark?: BenchmarkSeries | null;
  /**
   * Labelled event markers pinned to axis dates — the §14 backtest entry
   * markers ("X enters"). Drawn as flags above the main series at their date.
   */
  markers?: readonly ChartMarker[];
  /**
   * Per-asset overlay series drawn over the main one (#122). When non-empty the
   * price scale switches to **percentage mode**: every series (main + overlays)
   * is normalized to its own first visible value, so differently-scaled series
   * (a €500 portfolio, a €28 stock) become comparable relative moves — an asset
   * drop visibly lines up with the portfolio drop it caused.
   */
  overlays?: readonly BenchmarkSeries[];
  /**
   * The series values are already percentages (the performance-% portfolio
   * curve, #125): the axis/crosshair format as `x.xx %` and the price scale
   * stays in normal mode even with overlays — every series is expected to
   * arrive pre-expressed in % (no second normalization).
   */
  percentValues?: boolean;
  /** Show a spinner instead of the chart (parent is fetching). */
  loading?: boolean;
  /**
   * Live-append mode (PROJECTPLAN.md §6.3, V3-P7b): when the series merely
   * grows at the tail (streamed live frames), the new points are pushed via
   * `series.update()` instead of a full `setData()` re-draw. Any other change
   * (window switch, asset change) falls back to `setData`.
   */
  live?: boolean;
  /** Empty-state copy override (e.g. "Waiting for live prices…"). */
  emptyMessage?: string;
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
const MARKER_FLAG = '#fbbf24'; // amber-400 — entry-event flags (§14)
const GRID = 'rgba(82, 82, 91, 0.25)'; // neutral-600 @ 25%
const TEXT = '#a1a1aa'; // neutral-400

// Baseline (performance-%) mode: gains glow emerald above 0, losses rose below.
const BASELINE_UP_LINE = '#34d399'; // emerald-400
const BASELINE_UP_FILL_TOP = 'rgba(52, 211, 153, 0.3)';
const BASELINE_UP_FILL_BOTTOM = 'rgba(52, 211, 153, 0.02)';
const BASELINE_DOWN_LINE = '#fb7185'; // rose-400
const BASELINE_DOWN_FILL_TOP = 'rgba(251, 113, 133, 0.02)';
const BASELINE_DOWN_FILL_BOTTOM = 'rgba(251, 113, 133, 0.3)';

/** Distinguishable overlay palette for the dark shell; cycles past its length. */
const OVERLAY_LINES = [
  '#fbbf24', // amber-400
  '#34d399', // emerald-400
  '#fb7185', // rose-400
  '#a78bfa', // violet-400
  '#67e8f9', // cyan-300
  '#a3e635', // lime-400
] as const;

/** Colour for the `i`-th overlay series (and its legend chip). */
export function overlayColor(i: number): string {
  return OVERLAY_LINES[i % OVERLAY_LINES.length]!;
}

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
  showRangeToggle = true,
  benchmark = null,
  markers = [],
  overlays = [],
  percentValues = false,
  loading = false,
  live = false,
  emptyMessage,
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
  const mainRef = useRef<ISeriesApi<'Area'> | ISeriesApi<'Line'> | ISeriesApi<'Baseline'> | null>(
    null,
  );
  const benchRef = useRef<ISeriesApi<'Line'> | null>(null);
  const overlayRefs = useRef<Array<ISeriesApi<'Line'>>>([]);
  // What the main series currently shows, to detect a pure tail-append (live).
  const drawnRef = useRef<{ firstTime: Time | null; length: number }>({
    firstTime: null,
    length: 0,
  });
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const isEmpty = series.length === 0;
  const hasBenchmark = benchmark !== null && benchmark.series.length > 0;
  const overlayCount = overlays.length;

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
      rightPriceScale: {
        borderColor: GRID,
        // Overlay mode compares differently-scaled series (portfolio EUR value
        // vs. single-asset prices), so the scale normalizes every series to its
        // first visible value (percentage mode) — the standard "compare" view.
        // In percentValues mode every series already *is* a % curve, so the
        // scale stays normal: re-normalizing a series that starts at 0 would
        // divide by zero and distort it (#125).
        mode:
          overlayCount > 0 && !percentValues ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
      },
      // Values arriving pre-expressed in % render as "x.xx %" on the axis and
      // crosshair instead of looking like absolute prices (#125).
      ...(percentValues
        ? { localization: { priceFormatter: (p: number) => formatPercent(p) } }
        : {}),
      timeScale: { borderColor: GRID, fixLeftEdge: true, fixRightEdge: true },
      handleScale: false,
      handleScroll: false,
    });
    chartRef.current = chart;

    if (mode === 'baseline') {
      // Performance-% curve (#125): green above 0 %, red below — the zero line
      // is the "did I actually make money" boundary, so it gets its own mark.
      mainRef.current = chart.addSeries(BaselineSeries, {
        baseValue: { type: 'price', price: 0 },
        topLineColor: BASELINE_UP_LINE,
        topFillColor1: BASELINE_UP_FILL_TOP,
        topFillColor2: BASELINE_UP_FILL_BOTTOM,
        bottomLineColor: BASELINE_DOWN_LINE,
        bottomFillColor1: BASELINE_DOWN_FILL_TOP,
        bottomFillColor2: BASELINE_DOWN_FILL_BOTTOM,
        lineWidth: 2,
        priceLineVisible: false,
      });
    } else if (mode === 'step') {
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

    // One thin line per overlay asset (#122); data flows in via the data effect.
    overlayRefs.current = Array.from({ length: overlayCount }, (_, i) =>
      chart.addSeries(LineSeries, {
        color: overlayColor(i),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      }),
    );

    // Keep the chart sized to its container across responsive layout changes.
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    observer.observe(el);
    chart.applyOptions({ width: el.clientWidth || undefined });

    // A brand-new chart instance holds no data yet — never treat the first
    // data push after a (re)create as a live tail-append.
    drawnRef.current = { firstTime: null, length: 0 };

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      benchRef.current = null;
      overlayRefs.current = [];
      drawnRef.current = { firstTime: null, length: 0 };
      markersRef.current = null;
    };
  }, [mode, hasBenchmark, overlayCount, percentValues, height, loading, isEmpty]);

  // Push data into the existing series instances; refit the visible window.
  useEffect(() => {
    const main = mainRef.current;
    if (main) {
      const drawn = drawnRef.current;
      const firstTime = series[0]?.time ?? null;
      // Live-append (§6.3): same series, only grown at the tail → stream the
      // new points into the instance instead of re-drawing everything.
      const isTailAppend =
        live &&
        drawn.length > 0 &&
        firstTime !== null &&
        firstTime === drawn.firstTime &&
        series.length >= drawn.length;
      if (isTailAppend) {
        // Re-update from the last drawn point: update() with an existing time
        // replaces it in place, so this is safe and covers value corrections.
        for (let i = drawn.length - 1; i < series.length; i++) main.update(series[i]!);
      } else {
        main.setData(series);
      }
      drawnRef.current = { firstTime, length: series.length };
      // Event markers ride the main series. The plugin is created lazily on
      // first use and re-set (possibly to empty) on every data pass after that,
      // so toggling markers off clears the flags without a chart rebuild.
      if (markers.length > 0 || markersRef.current) {
        markersRef.current ??= createSeriesMarkers(main, []);
        markersRef.current.setMarkers(
          markers.map((m) => ({
            time: m.time,
            position: 'aboveBar' as const,
            shape: 'arrowDown' as const,
            color: MARKER_FLAG,
            text: m.label,
          })),
        );
      }
    }
    if (benchRef.current && benchmark) benchRef.current.setData(benchmark.series);
    overlayRefs.current.forEach((line, i) => {
      const overlay = overlays[i];
      if (overlay) line.setData(overlay.series);
    });
    chartRef.current?.timeScale().fitContent();
  }, [series, benchmark, markers, overlays, live]);

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {showRangeToggle ? (
          <RangeToggle active={activeRange} ranges={ranges} onSelect={selectRange} />
        ) : (
          <span aria-hidden="true" />
        )}
        {hasBenchmark || overlayCount > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
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
            {overlays.map((overlay, i) => (
              <span
                key={overlay.label}
                className="flex items-center gap-1.5 text-xs text-neutral-400"
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-0.5 w-4"
                  style={{ backgroundColor: overlayColor(i) }}
                />
                {overlay.label}
              </span>
            ))}
          </div>
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
          {emptyMessage ?? 'No price data for this range yet.'}
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
      className="inline-flex gap-0.5 rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
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
              'rounded px-2.5 py-1 text-xs font-medium transition-colors',
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

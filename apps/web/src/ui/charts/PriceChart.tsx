import {
  AreaSeries,
  BaselineSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineType,
  PriceScaleMode,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';

import { LOCALES, useI18n, useT } from '../../i18n';
import { Spinner } from '../../user/components/ui';
import { cx } from '../../lib/cx';
import { DISCREET_MASK, formatPercent, isDiscreetMode } from '../../lib/format';
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
  /**
   * Live generation (§13.5 V5-P1): a **change** ⇒ exactly one `setData` (the
   * ONE clean rebuild — asset/window/rate change or reconnect); an **equal**
   * value ⇒ a tail append via `series.update()`. Supplied by
   * {@link import('../../lib/realtime').useLiveSeries}. When omitted, live mode
   * falls back to the legacy first-time heuristic.
   */
  generation?: number;
  /**
   * Live window span in ms (§13.5 V5-P1 §3). Present ⇒ the chart pins its
   * visible range to `[now − window, now]` after every push and NEVER auto-fits
   * — dense live ticks can no longer crush the seeded history off-screen.
   */
  liveWindowMs?: number;
  /** Market is closed ⇒ anchor the live viewport to the newest datum, not `now`. */
  marketClosed?: boolean;
  /**
   * Fired whenever the #666 catch-fallback re-draws on a non-monotonic update
   * (a safety net). After V5-P1 the merged series is strictly increasing, so in
   * a healthy live stream this must never fire — the acceptance soak asserts it.
   */
  onFallbackRedraw?: () => void;
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

// ─── Time-axis formatting (§13.5 V5-P1 Part C) ───────────────────────────────

/**
 * Coerce a `lightweight-charts` {@link Time} to a `Date`. A number is a UNIX
 * **instant** (intraday/live); a `YYYY-MM-DD` string or `{year,month,day}` is a
 * calendar **date** (daily+ candles) — the caller formats those in UTC so a
 * timezone behind UTC never shifts "22 Jul" back to the 21st.
 */
function timeToDate(time: Time): Date {
  if (typeof time === 'number') return new Date(time * 1000);
  if (typeof time === 'string') return new Date(time);
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

/**
 * A `timeScale.tickMarkFormatter` that HONORS `tickMarkType` (§13.5 V5-P1 Part
 * C): sub-minute live rates show `HH:MM:SS`, other intraday ticks `HH:MM`, day
 * ticks `22 Jul`, month/year as short month / year. This is what stops an
 * intraday axis from repeating a bare day number ("22 22 22") — those ticks are
 * `Time`, so they now render the clock time. Calendar-date ticks format in UTC;
 * instant ticks in the runtime's local zone. Locale drives month names + digits.
 */
function makeTickMarkFormatter(intlLocale: string): (time: Time, type: TickMarkType) => string {
  const cache = new Map<string, Intl.DateTimeFormat>();
  const fmt = (opts: Intl.DateTimeFormatOptions, tz?: string): Intl.DateTimeFormat => {
    const key = `${tz ?? ''}:${JSON.stringify(opts)}`;
    let f = cache.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat(intlLocale, tz ? { ...opts, timeZone: tz } : opts);
      cache.set(key, f);
    }
    return f;
  };
  return (time, type) => {
    const date = timeToDate(time);
    const tz = typeof time === 'number' ? undefined : 'UTC';
    switch (type) {
      case TickMarkType.TimeWithSeconds:
        return fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(
          date,
        );
      case TickMarkType.Time:
        return fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
      case TickMarkType.Month:
        return fmt({ month: 'short' }, tz).format(date);
      case TickMarkType.Year:
        return fmt({ year: 'numeric' }, tz).format(date);
      case TickMarkType.DayOfMonth:
      default:
        return fmt({ day: 'numeric', month: 'short' }, tz).format(date);
    }
  };
}

/**
 * A `localization.timeFormatter` for the crosshair/tooltip (§13.5 V5-P1 Part C):
 * intraday shows a full day + `HH:MM`, so a live/1D crosshair reads
 * "22 Jul, 14:30" instead of a bare date; calendar dates show day + month.
 */
function makeCrosshairFormatter(intlLocale: string): (time: Time) => string {
  const instant = new Intl.DateTimeFormat(intlLocale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const calendar = new Intl.DateTimeFormat(intlLocale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (time) =>
    typeof time === 'number'
      ? instant.format(new Date(time * 1000))
      : calendar.format(timeToDate(time));
}

/**
 * Pin the live viewport to `[now − window, now]` (§13.5 V5-P1 §3) — the ONLY
 * thing that moves the scale in live mode. Dense per-second ticks and a
 * minute-density seed therefore occupy proportional horizontal space on one
 * wall-clock scale; nothing is ever auto-fit or auto-shifted. A closed market
 * (no fresh ticks) anchors to the newest datum so the seeded past window shows
 * instead of an empty right edge.
 */
function applyLiveViewport(
  chart: IChartApi,
  series: ChartPoint[],
  liveWindowMs: number,
  marketClosed: boolean | undefined,
): void {
  if (series.length === 0) return;
  const windowSec = Math.floor(liveWindowMs / 1000);
  const last = series[series.length - 1]!.time;
  const lastSec = typeof last === 'number' ? last : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const to = marketClosed && lastSec !== null ? lastSec : nowSec;
  try {
    chart.timeScale().setVisibleRange({ from: (to - windowSec) as Time, to: to as Time });
  } catch {
    // A range with no bars can reject — a viewport nicety must never bubble to
    // the React boundary and blank the chart (the #666 failure class).
  }
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
  generation,
  liveWindowMs,
  marketClosed,
  onFallbackRedraw,
  emptyMessage,
  height = 320,
  className,
  ariaLabel,
}: PriceChartProps) {
  const t = useT();
  const { locale } = useI18n();
  const intlLocale = LOCALES[locale].intlLocale;
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
  // What the main series currently shows, to detect a pure tail-append (live)
  // and which live generation is drawn (a change ⇒ the one clean rebuild).
  const drawnRef = useRef<{ firstTime: Time | null; length: number; generation: number | null }>({
    firstTime: null,
    length: 0,
    generation: null,
  });
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const isEmpty = series.length === 0;
  const hasBenchmark = benchmark !== null && benchmark.series.length > 0;
  const overlayCount = overlays.length;
  // Snapshot the discreet flag at chart-create time so a toggle mid-life
  // rebuilds the chart with the correct axis formatter (§13.5 V5-P13 arc (a)).
  const discreet = isDiscreetMode();

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
      // Localised intraday time axis + crosshair (§13.5 V5-P1 Part C). Values
      // arriving pre-expressed in % render as "x.xx %" on the axis/crosshair
      // instead of looking like absolute prices (#125); discreet mode (§13.5
      // V5-P13 arc (a)) masks absolute-price axes so a real amount never paints.
      localization: {
        timeFormatter: makeCrosshairFormatter(intlLocale),
        ...(percentValues
          ? { priceFormatter: (p: number) => formatPercent(p) }
          : discreet
            ? { priceFormatter: () => DISCREET_MASK }
            : {}),
      },
      timeScale: {
        borderColor: GRID,
        tickMarkFormatter: makeTickMarkFormatter(intlLocale),
        // Live mode drives the viewport ONLY via setVisibleRange (§13.5 V5-P1
        // §3): the scale must never auto-fit or auto-shift on a new bar, or a
        // dense per-second tail would compress the minute-density seed off the
        // left edge (symptom 3). History views keep their fixed edges.
        ...(live
          ? {
              fixLeftEdge: false,
              fixRightEdge: false,
              rightOffset: 0,
              shiftVisibleRangeOnNewBar: false,
              lockVisibleTimeRangeOnResize: true,
            }
          : { fixLeftEdge: true, fixRightEdge: true }),
      },
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
    drawnRef.current = { firstTime: null, length: 0, generation: null };

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      benchRef.current = null;
      overlayRefs.current = [];
      drawnRef.current = { firstTime: null, length: 0, generation: null };
      markersRef.current = null;
    };
  }, [
    mode,
    hasBenchmark,
    overlayCount,
    percentValues,
    height,
    loading,
    isEmpty,
    discreet,
    live,
    intlLocale,
  ]);

  // Push data into the existing series instances; drive the visible window.
  useEffect(() => {
    const main = mainRef.current;
    if (main) {
      const drawn = drawnRef.current;
      const firstTime = series[0]?.time ?? null;
      if (live && generation !== undefined) {
        // Generation-driven (§13.5 V5-P1): a generation change is the ONE clean
        // rebuild point; an unchanged generation means the merged series only
        // grew at the tail, so stream those points via update() — never a
        // per-tick setData.
        if (generation !== drawn.generation) {
          main.setData(series);
        } else {
          try {
            for (let i = Math.max(0, drawn.length - 1); i < series.length; i++) {
              main.update(series[i]!);
            }
          } catch {
            // Safety net (#666): the merged series is strictly increasing, so a
            // healthy stream never lands here — but if it ever did, re-draw
            // rather than let "Cannot update oldest data" blank the page.
            onFallbackRedraw?.();
            main.setData(series);
          }
        }
        drawnRef.current = { firstTime, length: series.length, generation };
      } else if (live) {
        // Legacy tail-append heuristic (no generation supplied): same series,
        // only grown at the tail → stream the new points; any other change
        // (window/asset switch) falls back to a full re-draw.
        const isTailAppend =
          drawn.length > 0 &&
          firstTime !== null &&
          firstTime === drawn.firstTime &&
          series.length >= drawn.length;
        if (isTailAppend) {
          try {
            for (let i = drawn.length - 1; i < series.length; i++) main.update(series[i]!);
          } catch {
            onFallbackRedraw?.();
            main.setData(series);
          }
        } else {
          main.setData(series);
        }
        drawnRef.current = { firstTime, length: series.length, generation: drawn.generation };
      } else {
        main.setData(series);
        drawnRef.current = { firstTime, length: series.length, generation: drawn.generation };
      }
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
    // Live mode pins [now − window, now] and NEVER fits content (symptom 3);
    // history views fit all their data as before.
    const chart = chartRef.current;
    if (chart) {
      if (live && liveWindowMs) applyLiveViewport(chart, series, liveWindowMs, marketClosed);
      else if (!live) chart.timeScale().fitContent();
    }
  }, [
    series,
    benchmark,
    markers,
    overlays,
    live,
    generation,
    liveWindowMs,
    marketClosed,
    onFallbackRedraw,
  ]);

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
          <Spinner label={t('common.charts.loadingChart')} />
        </div>
      ) : isEmpty ? (
        <div
          role="status"
          className="grid place-items-center rounded-md bg-neutral-900/40 text-sm text-neutral-500"
          style={{ height }}
        >
          {emptyMessage ?? t('common.charts.noPriceData')}
        </div>
      ) : (
        <div
          ref={containerRef}
          role="img"
          aria-label={ariaLabel ?? t('common.charts.priceChartAria')}
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
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t('common.charts.selectRange')}
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

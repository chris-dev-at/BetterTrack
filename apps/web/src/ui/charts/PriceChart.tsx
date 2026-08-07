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
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { LOCALES, useI18n, useT } from '../../i18n';
import * as palette from './palette';
import { Spinner } from '../../user/components/ui';
import { cx } from '../../lib/cx';
import {
  DISCREET_MASK,
  EM_DASH,
  formatDate,
  formatDateTime,
  formatDateTimeSeconds,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedPercent,
  formatUnitPrice,
  isDiscreetMode,
} from '../../lib/format';
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
  /**
   * Which end of the chart's header row the range toggle sits at. `start` (the
   * default) keeps it under the page heading, where a full-page chart wants it;
   * `end` puts it on the right, which is what the Home widgets use — their own
   * title already owns the left of that row, and the toggle lines up with the
   * widget's right edge instead of hanging off its heading. Series legends take
   * the other end either way.
   */
  rangeAlign?: 'start' | 'end';
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
  /**
   * The absolute-money twin of `series`, aligned 1:1 **by time** (owner
   * directive 2026-08-07, mobile board #68 item 4). Supplying it turns on the
   * scrub tooltip: the curve keeps its performance-% shape while hovering any
   * point names the balance in money — prominently — with the % beneath it.
   *
   * Points are matched by their `time` key, never by index, so a series with a
   * hole simply shows an em dash for that point rather than a neighbour's
   * money. Omit the prop entirely (the default) and the chart behaves exactly
   * as it did before: no subscription, no tooltip, nothing to re-style.
   */
  balanceSeries?: readonly ChartPoint[];
  /** ISO currency for {@link PriceChartProps.balanceSeries}. */
  balanceCurrency?: string;
  /**
   * ISO currency for monetary values in the primary series. Omit this for
   * unitless series such as rebased base-100 backtests; `percentValues` takes
   * precedence when both are supplied.
   */
  valueCurrency?: string;
  /**
   * Monetary primary-series values are totals by default. Asset history points
   * are per-unit prices, whose sub-cent precision must remain readable.
   */
  valueFormat?: 'money' | 'unitPrice';
  /**
   * Expose the summary and expandable table for this chart. Callers which
   * cannot yet identify a monetary series' currency may defer this until they
   * can do so, rather than presenting it as a unitless index.
   */
  showDataAlternative?: boolean;
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
   * visible range to `[now − window, now]` after every push and NEVER auto-fits.
   * Pinning stops the scale from jumping/re-fitting onto each new bar; keeping the
   * seed from being *compressed* by the dense tail additionally needs the caller
   * to feed a uniform-density series (this axis is ordinal — see
   * {@link applyLiveViewport}), which {@link import('../../lib/realtime').useLiveSeries}
   * does via its densified `chartPoints`.
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

// Origin chart palette (ui/charts/palette.ts): spec blue for the lone main
// series, the validated categorical order for overlays, semantic green/red
// only where polarity is real, gold only as an event flag.
const MAIN_LINE = palette.MAIN_SERIES;
const MAIN_AREA_TOP = palette.MAIN_AREA_TOP;
const MAIN_AREA_BOTTOM = palette.MAIN_AREA_BOTTOM;
const BENCHMARK_LINE = palette.BENCHMARK;
const MARKER_FLAG = palette.GOLD_FLAG; // entry-event flags (§14)
const GRID = palette.CHART_GRID;
const TEXT = palette.CHART_TEXT;

// Baseline (performance-%) mode: gains above 0, losses below — real polarity.
const BASELINE_UP_LINE = palette.POSITIVE;
const BASELINE_UP_FILL_TOP = 'rgba(52, 211, 153, 0.22)';
const BASELINE_UP_FILL_BOTTOM = 'rgba(52, 211, 153, 0.02)';
const BASELINE_DOWN_LINE = palette.NEGATIVE;
const BASELINE_DOWN_FILL_TOP = 'rgba(251, 113, 133, 0.02)';
const BASELINE_DOWN_FILL_BOTTOM = 'rgba(251, 113, 133, 0.22)';

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

/** Keep the accessible data alternative bounded on dense intraday ranges. */
const ACCESSIBLE_TABLE_POINT_LIMIT = 120;

type ChartDatePrecision = 'date' | 'minute' | 'second';

interface AccessibleChartData {
  start: ChartPoint;
  end: ChartPoint;
  minimum: ChartPoint;
  maximum: ChartPoint;
  tablePoints: readonly ChartPoint[];
  sampled: boolean;
  totalPoints: number;
  datePrecision: ChartDatePrecision;
}

/**
 * Build the points used by the DOM alternative from the same finite data the
 * canvas chart plots. A single point cannot describe a period or a change, so
 * it intentionally has no summary/table rather than producing misleading data.
 */
function accessibleChartData(series: readonly ChartPoint[]): AccessibleChartData | null {
  const plotted = series.filter((point) => Number.isFinite(point.value));
  if (plotted.length < 2) return null;

  let minimum = plotted[0]!;
  let maximum = plotted[0]!;
  let numericPointCount = 0;
  let previousNumericTime: number | null = null;
  let shortestNumericGapSeconds = Infinity;
  const numericDayKeys = new Set<number>();
  for (let index = 0; index < plotted.length; index += 1) {
    const point = plotted[index]!;
    if (point.value < minimum.value) minimum = point;
    if (point.value > maximum.value) maximum = point;

    if (typeof point.time === 'number' && Number.isFinite(point.time)) {
      numericPointCount += 1;
      numericDayKeys.add(Math.floor(point.time / 86_400));
      if (previousNumericTime !== null && point.time > previousNumericTime) {
        shortestNumericGapSeconds = Math.min(
          shortestNumericGapSeconds,
          point.time - previousNumericTime,
        );
      }
      previousNumericTime = point.time;
    }
  }

  // Numeric `Time` alone does not mean intraday: combined daily portfolio
  // series use epoch seconds too. Show a clock only for a genuinely dense
  // series, and retain seconds when neighbouring live points need them.
  const hasIntradayTimes =
    numericPointCount > 1 &&
    (numericDayKeys.size < numericPointCount || shortestNumericGapSeconds < 12 * 60 * 60);
  const datePrecision: ChartDatePrecision = hasIntradayTimes
    ? shortestNumericGapSeconds < 60
      ? 'second'
      : 'minute'
    : 'date';

  const sampled = plotted.length > ACCESSIBLE_TABLE_POINT_LIMIT;
  const tablePoints = sampled
    ? Array.from({ length: ACCESSIBLE_TABLE_POINT_LIMIT }, (_, index) => {
        const position = (index * (plotted.length - 1)) / (ACCESSIBLE_TABLE_POINT_LIMIT - 1);
        return plotted[Math.round(position)]!;
      })
    : plotted;

  return {
    start: plotted[0]!,
    end: plotted.at(-1)!,
    minimum,
    maximum,
    tablePoints,
    sampled,
    totalPoints: plotted.length,
    datePrecision,
  };
}

/** Format each point through the shared date/date-time formatters. */
function formatChartDate(time: Time, precision: ChartDatePrecision): string {
  const date = timeToDate(time);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  const iso = date.toISOString();
  if (typeof time !== 'number' || precision === 'date') return formatDate(iso);
  return precision === 'second' ? formatDateTimeSeconds(iso) : formatDateTime(iso);
}

function formatChartValue(
  value: number,
  percentValues: boolean,
  valueCurrency: string | undefined,
  valueFormat: 'money' | 'unitPrice',
): string {
  if (percentValues) return formatPercent(value);
  // An omitted currency is intentional: backtests and comparisons are rebased
  // indices, not money. `formatQuantity` keeps those values locale-aware and
  // deliberately visible in discreet mode.
  if (valueCurrency === undefined) return formatQuantity(value);
  return valueFormat === 'unitPrice'
    ? formatUnitPrice(value, valueCurrency)
    : formatMoney(value, valueCurrency);
}

/** Mirror MoneyText's explicit positive sign while preserving discreet masking. */
function formatSignedChartValue(
  value: number,
  percentValues: boolean,
  valueCurrency: string | undefined,
  valueFormat: 'money' | 'unitPrice',
): string {
  if (percentValues) return formatSignedPercent(value);
  const formatted = formatChartValue(value, false, valueCurrency, valueFormat);
  return value > 0 && formatted !== DISCREET_MASK ? `+${formatted}` : formatted;
}

function chartPointKey(time: Time): string {
  if (typeof time === 'string' || typeof time === 'number') return String(time);
  return `${time.year}-${time.month}-${time.day}`;
}

// ─── Scrub tooltip (board #68 item 4) ────────────────────────────────────────

/** One hovered point, already formatted — the tooltip itself does no maths. */
interface ScrubReadout {
  /** Crosshair x within the chart container, px. */
  x: number;
  /** Container width when the reading was taken; drives the right-edge flip. */
  width: number;
  date: string;
  /** The balance in money at that point — the headline (owner: € prominent). */
  balance: string;
  /** The curve's own value at that point (the performance %), signed. */
  value: string;
}

/**
 * Index a series by its time key. Matching by key rather than by index is what
 * lets a hole in either series show an em dash instead of a neighbouring
 * point's money — the two arrays are aligned by the API, not by this component.
 */
function indexByTime(points: readonly ChartPoint[]): Map<string, number> {
  const byTime = new Map<string, number>();
  for (const point of points) byTime.set(chartPointKey(point.time), point.value);
  return byTime;
}

/**
 * The money at `time`, or an em dash when the twin has no point there. Shared
 * by the tooltip and the data table so the two can never disagree about which
 * balance belongs to a point — or about discreet masking, which `formatMoney`
 * applies on both paths.
 */
function formatBalanceAt(
  balances: Map<string, number>,
  time: Time,
  currency: string | undefined,
): string {
  const value = balances.get(chartPointKey(time));
  return value === undefined ? EM_DASH : formatMoney(value, currency);
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
 * thing that moves the scale in live mode; nothing is ever auto-fit or
 * auto-shifted. NOTE this axis is ordinal/index-based (`lightweight-charts` has
 * no proportional-time mode), so `setVisibleRange` maps times to point *indices*:
 * it frames the right window but only spaces points proportionally when they are
 * uniform-density. The caller therefore feeds a densified series (one grid step),
 * so a minute seed and a per-second tail occupy proportional horizontal space
 * (issue #690 symptom 3) instead of the seed collapsing to its point-count share.
 * A closed market anchors to the newest datum so the seeded past window shows
 * instead of an empty right edge. This is a live path, not a corner case: the
 * caller drops `marketState:'closed'` frames (they never append), so while the
 * market is shut the newest datum stays the last real pre-close observation —
 * genuinely older than `now` — and the viewport frames it (issue #690 Part A).
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
  rangeAlign = 'start',
  benchmark = null,
  markers = [],
  overlays = [],
  percentValues = false,
  balanceSeries,
  balanceCurrency,
  valueCurrency,
  valueFormat = 'money',
  showDataAlternative = true,
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
  const [isDataTableOpen, setIsDataTableOpen] = useState(false);
  const [scrub, setScrub] = useState<ScrubReadout | null>(null);
  const summaryId = useId();
  const dataTableId = useId();
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
  // The scrub tooltip exists ONLY for callers that hand over a money twin —
  // keyed on the prop being supplied at all, not on it having arrived yet, so a
  // slow companion read fills the tooltip in instead of rebuilding the chart.
  const hasScrubTooltip = balanceSeries !== undefined;
  // Snapshot the discreet flag at chart-create time so a toggle mid-life
  // rebuilds the chart with the correct axis formatter (§13.5 V5-P13 arc (a)).
  const discreet = isDiscreetMode();
  const dataAlternative = useMemo(
    () => (showDataAlternative ? accessibleChartData(series) : null),
    [series, showDataAlternative],
  );
  const summary = useMemo(() => {
    if (!dataAlternative) return null;
    const { datePrecision } = dataAlternative;
    return t('common.charts.priceChartSummary', {
      startDate: formatChartDate(dataAlternative.start.time, datePrecision),
      endDate: formatChartDate(dataAlternative.end.time, datePrecision),
      startValue: formatChartValue(
        dataAlternative.start.value,
        percentValues,
        valueCurrency,
        valueFormat,
      ),
      endValue: formatChartValue(
        dataAlternative.end.value,
        percentValues,
        valueCurrency,
        valueFormat,
      ),
      change: formatSignedChartValue(
        dataAlternative.end.value - dataAlternative.start.value,
        percentValues,
        valueCurrency,
        valueFormat,
      ),
      changePercent: formatSignedPercent(
        dataAlternative.start.value === 0
          ? null
          : ((dataAlternative.end.value - dataAlternative.start.value) /
              dataAlternative.start.value) *
              100,
      ),
      minimum: formatChartValue(
        dataAlternative.minimum.value,
        percentValues,
        valueCurrency,
        valueFormat,
      ),
      minimumDate: formatChartDate(dataAlternative.minimum.time, datePrecision),
      maximum: formatChartValue(
        dataAlternative.maximum.value,
        percentValues,
        valueCurrency,
        valueFormat,
      ),
      maximumDate: formatChartDate(dataAlternative.maximum.time, datePrecision),
    });
  }, [dataAlternative, discreet, locale, percentValues, t, valueCurrency, valueFormat]);

  // Everything the crosshair handler needs, behind a ref: the handler is
  // registered once with the chart instance and must never capture a stale
  // series, but re-subscribing on every data change would mean tearing the
  // chart down mid-hover. Written after every render, read only on a mouse
  // move — which cannot happen before the first commit.
  const scrubRef = useRef<{
    values: Map<string, number>;
    balances: Map<string, number>;
    currency: string | undefined;
    percentValues: boolean;
    precision: ChartDatePrecision;
  } | null>(null);
  // One index of the money twin, shared by the crosshair readout and the
  // accessible data table: both answer "which balance is this point's?" the
  // same way, by time key, or a screen reader and a mouse would disagree.
  const balanceByTime = useMemo(
    () => (hasScrubTooltip ? indexByTime(balanceSeries ?? []) : null),
    [hasScrubTooltip, balanceSeries],
  );
  const valueByTime = useMemo(
    () => (hasScrubTooltip ? indexByTime(series) : null),
    [hasScrubTooltip, series],
  );
  useEffect(() => {
    scrubRef.current =
      balanceByTime !== null && valueByTime !== null
        ? {
            values: valueByTime,
            balances: balanceByTime,
            currency: balanceCurrency,
            percentValues,
            precision: dataAlternative?.datePrecision ?? 'date',
          }
        : null;
  });

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
        // §3): the scale must never auto-fit or auto-shift on a new bar, or it
        // would jump/re-fit onto the dense tail each tick. (Compression of the
        // seed is prevented upstream, by the caller's uniform-density series —
        // this ordinal axis spaces by index, not wall-clock.) History views keep
        // their fixed edges.
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
        color: palette.categoricalColor(i),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      }),
    );

    // Scrub tooltip (board #68 item 4). Subscribed only for callers with a
    // money twin, so every other chart's runtime behaviour is byte-identical.
    // The chart-wide `chart.remove()` in this effect's cleanup disposes the
    // subscription with the instance, so there is nothing left to unhook.
    if (hasScrubTooltip) {
      chart.subscribeCrosshairMove((param) => {
        const data = scrubRef.current;
        // Off the plot (or before the first commit) ⇒ nothing to read.
        if (data === null || param.time === undefined || param.point === undefined) {
          setScrub(null);
          return;
        }
        const value = data.values.get(chartPointKey(param.time));
        setScrub({
          x: param.point.x,
          width: el.clientWidth,
          date: formatChartDate(param.time, data.precision),
          // formatMoney masks to ••• in discreet mode all by itself — the
          // tooltip must not become the one surface that leaks an amount.
          balance: formatBalanceAt(data.balances, param.time, data.currency),
          value:
            value === undefined
              ? EM_DASH
              : formatSignedChartValue(value, data.percentValues, undefined, 'money'),
        });
      });
    }

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
      // A reading belongs to the instance that produced it: never let one
      // survive a mode switch and float over a freshly drawn curve.
      setScrub(null);
    };
  }, [
    mode,
    hasBenchmark,
    overlayCount,
    percentValues,
    hasScrubTooltip,
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

  const toggle = showRangeToggle ? (
    <RangeToggle active={activeRange} ranges={ranges} onSelect={selectRange} />
  ) : null;
  const legend =
    hasBenchmark || overlayCount > 0 ? (
      <div className="flex flex-wrap items-center gap-3">
        {hasBenchmark ? (
          <span className="bt-meta flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-4"
              style={{ backgroundColor: BENCHMARK_LINE }}
            />
            {benchmark.label}
          </span>
        ) : null}
        {overlays.map((overlay, i) => (
          <span className="bt-meta flex items-center gap-1.5" key={overlay.label}>
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-4"
              style={{ backgroundColor: palette.categoricalColor(i) }}
            />
            {overlay.label}
          </span>
        ))}
      </div>
    ) : null;
  // `justify-between` with a placeholder for whichever end is empty: the toggle
  // sits at its declared end whether or not there is a legend to face it.
  const [leading, trailing] = rangeAlign === 'end' ? [legend, toggle] : ([toggle, legend] as const);

  const canvas = (
    <div
      ref={containerRef}
      role="img"
      aria-describedby={summary ? summaryId : undefined}
      aria-label={ariaLabel ?? t('common.charts.priceChartAria')}
      className="w-full"
      style={{ height }}
    />
  );

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {leading ?? <span aria-hidden="true" />}
        {trailing}
      </div>

      {loading ? (
        <div
          className="grid place-items-center rounded-md"
          style={{ height, background: 'var(--bt-surface-soft)' }}
        >
          <Spinner label={t('common.charts.loadingChart')} />
        </div>
      ) : isEmpty ? (
        <div
          role="status"
          className="grid place-items-center rounded-md text-sm"
          style={{ height, background: 'var(--bt-surface-soft)', color: 'var(--bt-muted)' }}
        >
          {emptyMessage ?? t('common.charts.noPriceData')}
        </div>
      ) : (
        <div>
          {summary ? (
            <p className="sr-only" id={summaryId}>
              {summary}
            </p>
          ) : null}
          {hasScrubTooltip ? (
            // The positioning context for the tooltip. Only rendered for the
            // scrub-tooltip callers, so no other chart's DOM shifts by a node.
            <div className="relative">
              {canvas}
              {scrub ? <ScrubTooltip scrub={scrub} /> : null}
            </div>
          ) : (
            canvas
          )}
          {dataAlternative ? (
            <>
              <button
                aria-controls={dataTableId}
                aria-expanded={isDataTableOpen}
                className="mt-1 text-xs bt-muted underline decoration-dotted underline-offset-2"
                onClick={() => setIsDataTableOpen((open) => !open)}
                type="button"
              >
                {t(
                  isDataTableOpen
                    ? 'common.charts.priceChartDataCollapse'
                    : 'common.charts.priceChartDataExpand',
                )}
              </button>
              {isDataTableOpen ? (
                <div className="mt-2 overflow-x-auto" id={dataTableId}>
                  {dataAlternative.sampled ? (
                    <p className="mb-2 text-xs bt-muted">
                      {t('common.charts.priceChartDataSampled', {
                        shown: dataAlternative.tablePoints.length,
                        total: dataAlternative.totalPoints,
                      })}
                    </p>
                  ) : null}
                  <table className="w-full text-left text-xs">
                    <caption className="sr-only">
                      {t('common.charts.priceChartDataTableCaption')}
                    </caption>
                    <thead className="bt-muted">
                      <tr>
                        <th className="py-1 pr-3 font-medium" scope="col">
                          {t('common.charts.priceChartDataDate')}
                        </th>
                        {/* The money twin gets its own column so a % curve is
                            not the one mode where the balance exists for a
                            mouse and nowhere else — same time-key matching as
                            the tooltip, in the same order (balance first). */}
                        {balanceByTime ? (
                          <th className="py-1 pr-3 text-right font-medium" scope="col">
                            {t('common.charts.priceChartDataBalance')}
                          </th>
                        ) : null}
                        <th className="py-1 text-right font-medium" scope="col">
                          {t('common.charts.priceChartDataValue')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {dataAlternative.tablePoints.map((point, index) => (
                        <tr key={`${chartPointKey(point.time)}-${index}`}>
                          <td className="py-1 pr-3">
                            {formatChartDate(point.time, dataAlternative.datePrecision)}
                          </td>
                          {balanceByTime ? (
                            <td className="py-1 pr-3 text-right tabular-nums">
                              {formatBalanceAt(balanceByTime, point.time, balanceCurrency)}
                            </td>
                          ) : null}
                          <td className="py-1 text-right tabular-nums">
                            {formatChartValue(
                              point.value,
                              percentValues,
                              valueCurrency,
                              valueFormat,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The hovered point's readout (board #68 item 4): the money balance is the
 * headline — the owner's whole reason for the mode — with the curve's own
 * percentage as its subtitle, and the date above both for context.
 *
 * Pinned to the top of the plot and following the crosshair horizontally: a
 * tooltip that also tracked `y` would jitter along the curve while the number
 * is being read. It flips to the left of the crosshair past the halfway mark so
 * it never runs off the right edge, and is `pointer-events: none` so it can
 * never eat the very crosshair that drives it.
 */
function ScrubTooltip({ scrub }: { scrub: ScrubReadout }) {
  const flip = scrub.width > 0 && scrub.x > scrub.width / 2;
  return (
    <div
      className="pointer-events-none absolute flex flex-col gap-0.5 rounded-md px-2.5 py-1.5"
      style={{
        left: scrub.x,
        top: 8,
        transform: flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
        background: 'var(--bt-surface-strong)',
        border: '1px solid var(--bt-border)',
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.24)',
        zIndex: 1,
      }}
    >
      <span className="bt-meta">{scrub.date}</span>
      <span className="text-sm font-semibold tabular-nums">{scrub.balance}</span>
      <span className="bt-meta tabular-nums">{scrub.value}</span>
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
    <div aria-label={t('common.charts.selectRange')} className="bt-seg" role="group">
      {ranges.map((token) => {
        const selected = token === active;
        return (
          <button
            aria-pressed={selected}
            className={cx(selected && 'is-active')}
            key={token}
            onClick={() => onSelect(token)}
            type="button"
          >
            {token}
          </button>
        );
      })}
    </div>
  );
}

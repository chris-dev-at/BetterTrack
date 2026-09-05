import { cx } from '../../lib/cx';
import { useT } from '../../i18n';
import * as palette from './palette';

export interface SparklineProps {
  /** Short series of values (e.g. the workboard 1M closes, PROJECTPLAN.md §6.4). */
  data: number[];
  /**
   * Optional time axis: one x position per `data` point, in the same order (ms
   * since the epoch is the natural unit). Given, points are placed
   * proportionally on it instead of evenly — so an irregularly spaced series (a
   * dividend history with a skipped quarter, #1790) reads as the gap it is
   * rather than as a steady cadence. Ignored when it does not describe the
   * series: a different length, a non-finite entry, or positions that are all
   * equal (nothing to scale against) all fall back to even spacing.
   */
  at?: number[];
  width?: number;
  height?: number;
  /** Override the trend colour; by default it is derived from first→last. */
  positive?: boolean;
  className?: string;
  /** Accessible label; falls back to a generic description. */
  ariaLabel?: string;
}

// Trend ink comes off the chart tokens (ui/charts/palette.ts). These are
// `var(...)` references: an SVG `stroke` resolves them per paint, so a theme
// flip repaints a watchlist of dozens of these without any of them re-rendering.
//
// `TREND_DOWN` is its own token rather than `palette.NEGATIVE` because this
// component predates the Origin palette and has always drawn `#f87171`
// (Tailwind red-400), a shade off the `#fb7185` the change pill beside it uses.
// Board #68 is a light-theme change and may not move a dark pixel, so the dark
// value is held exactly as-is and only the light counterpart is new. Unifying
// the two reds is a real (small) design fix — and a separate one.
const UP = palette.POSITIVE;
const DOWN = palette.TREND_DOWN;
const FLAT = palette.FLAT;

/**
 * Compact, axis-less mini-chart for a short series (PROJECTPLAN.md §6.4
 * watchlist sparkline). Rendered as a single inline SVG `<polyline>` — no
 * charting-library instance per row, so a watchlist of dozens stays cheap and
 * leak-free. Colour encodes the trend unless `positive` is given.
 */
export function Sparkline({
  data,
  at,
  width = 96,
  height = 28,
  positive,
  className,
  ariaLabel,
}: SparklineProps) {
  const t = useT();
  // The axis is kept only if it describes THIS series point-for-point; a partial
  // or mismatched one would silently place values at the wrong times, which is
  // worse than the even spacing it replaces.
  const axis =
    at !== undefined && at.length === data.length && at.every((n) => Number.isFinite(n))
      ? at
      : undefined;
  const kept = data
    .map((value, i) => ({ value, at: axis?.[i] }))
    .filter((p) => Number.isFinite(p.value));
  const usable = kept.map((p) => p.value);

  // Empty / single-point: nothing meaningful to draw — show a muted baseline.
  if (usable.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel ?? t('common.charts.noTrendData')}
        className={cx('overflow-visible', className)}
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={FLAT}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const span = max - min;
  // Inset by 1px so the stroke never clips at the edges.
  const pad = 1;
  const innerH = height - pad * 2;
  const innerW = width - pad * 2;
  const stepX = innerW / (usable.length - 1);
  // Time axis (when the kept points all carry one and it actually spans): x is
  // the position in that span, so equal gaps in time render as equal gaps here.
  const times = kept.map((p) => p.at).filter((n): n is number => n !== undefined);
  const minAt = times.length === kept.length ? Math.min(...times) : 0;
  const spanAt = times.length === kept.length ? Math.max(...times) - minAt : 0;

  const points = kept
    .map(({ value, at: position }, i) => {
      const x =
        spanAt > 0 && position !== undefined
          ? pad + ((position - minAt) / spanAt) * innerW
          : pad + i * stepX;
      // Flat series (span 0) sits on the centre line; else normalise to height.
      const y = span === 0 ? pad + innerH / 2 : pad + innerH - ((value - min) / span) * innerH;
      return `${round(x)},${round(y)}`;
    })
    .join(' ');

  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  const trendUp = positive ?? last >= first;
  const stroke = span === 0 ? FLAT : trendUp ? UP : DOWN;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={
        ariaLabel ?? (trendUp ? t('common.charts.trendUp') : t('common.charts.trendDown'))
      }
      className={cx('overflow-visible', className)}
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Trim sub-pixel noise so the SVG path stays small and stable in snapshots. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

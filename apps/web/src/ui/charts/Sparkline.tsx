import { cx } from '../../lib/cx';
import { useT } from '../../i18n';
import * as palette from './palette';

export interface SparklineProps {
  /** Short series of values (e.g. the workboard 1M closes, PROJECTPLAN.md §6.4). */
  data: number[];
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
  width = 96,
  height = 28,
  positive,
  className,
  ariaLabel,
}: SparklineProps) {
  const t = useT();
  const usable = data.filter((n) => Number.isFinite(n));

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

  const points = usable
    .map((value, i) => {
      const x = pad + i * stepX;
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

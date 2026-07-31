import { useId } from 'react';

import type { CashTrendPoint } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatMoney } from '../../../lib/format';

/**
 * MONEY IN AND OUT PER MONTH, with the net as a line over the top.
 *
 * ── WHY ONE AXIS ──
 *
 * In, out and net are all euros, so all three share a single scale and the
 * chart stays readable as one picture. A second axis would let the net line be
 * drawn at any height the author liked, which is the fastest way to make a
 * chart lie — so there isn't one.
 *
 * ── WHY THE BASELINE IS ZERO AND SITS INSIDE THE PLOT ──
 *
 * Net goes negative in any month you spent more than you took in, and that is
 * the single most important thing this chart can tell you. Clipping it at the
 * floor, or drawing bars from a non-zero base, would hide exactly that. So the
 * scale spans `min(0, …)` to `max(0, …)` and the zero line is drawn.
 *
 * ── NO POINT MARKERS ON THE NET LINE ──
 *
 * The plot stretches to its container with `preserveAspectRatio="none"`, which
 * scales x and y by different factors — so a `<circle>` renders as a squashed
 * ellipse whose shape changes with the window width. Rather than fight that
 * with counter-transforms, the line carries the net on its own and each month's
 * figures live on its bars' tooltips, where a pointer already goes.
 *
 * ── WHY NOT A LIBRARY ──
 *
 * Same reason the rest of this app's charts are hand-drawn SVG: it is a few
 * dozen lines, it inherits the design tokens directly, and it ships nothing.
 */

export interface CashflowChartProps {
  points: readonly CashTrendPoint[];
  /** Localized short month label, e.g. "Jul". */
  monthLabel: (month: string) => string;
}

const HEIGHT = 168;
const PAD_TOP = 8;
const PAD_BOTTOM = 20;

export function CashflowChart({ points, monthLabel }: CashflowChartProps) {
  const t = useT();
  const titleId = useId();

  if (points.length === 0) return null;

  const nets = points.map((point) => point.inflow - point.outflow);
  // Zero is always in range — see the note above.
  const upper = Math.max(0, ...points.map((point) => point.inflow), ...nets);
  const lower = Math.min(0, ...points.map((point) => -point.outflow), ...nets);
  const span = upper - lower || 1;

  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const y = (value: number) => PAD_TOP + ((upper - value) / span) * plotHeight;
  const zeroY = y(0);

  const slotWidth = 100 / points.length;
  // Two bars per month inside the slot, with the slot's outer thirds as gutters.
  const barWidth = slotWidth * 0.22;

  const netPath = nets
    .map((net, index) => `${index === 0 ? 'M' : 'L'} ${slotWidth * (index + 0.5)} ${y(net)}`)
    .join(' ');

  return (
    <figure className="bt-cashchart" style={{ margin: 0 }}>
      <svg
        aria-labelledby={titleId}
        preserveAspectRatio="none"
        role="img"
        style={{ display: 'block', height: HEIGHT, width: '100%' }}
        viewBox={`0 0 100 ${HEIGHT}`}
      >
        <title id={titleId}>{t('cashflow.overview.trend')}</title>

        {/* Zero baseline — the reference the whole chart is read against. */}
        <line
          stroke="var(--bt-border)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          x1={0}
          x2={100}
          y1={zeroY}
          y2={zeroY}
        />

        {points.map((point, index) => {
          const slotStart = slotWidth * index;
          const inX = slotStart + slotWidth * 0.5 - barWidth - 0.6;
          const outX = slotStart + slotWidth * 0.5 + 0.6;
          const inTop = y(point.inflow);
          const outBottom = y(-point.outflow);
          const label = monthLabel(point.month);
          return (
            <g key={point.month}>
              <rect
                fill="var(--bt-pos)"
                height={Math.max(0, zeroY - inTop)}
                rx={0.6}
                width={barWidth}
                x={inX}
                y={inTop}
              >
                <title>{`${label} · ${t('cashflow.overview.inflow')}: ${formatMoney(point.inflow, 'EUR')}`}</title>
              </rect>
              <rect
                fill="var(--bt-neg)"
                height={Math.max(0, outBottom - zeroY)}
                rx={0.6}
                width={barWidth}
                x={outX}
                y={zeroY}
              >
                <title>{`${label} · ${t('cashflow.overview.outflow')}: ${formatMoney(point.outflow, 'EUR')}`}</title>
              </rect>
            </g>
          );
        })}

        {/* Net last, so it reads over the bars rather than behind them. */}
        <path
          d={netPath}
          fill="none"
          stroke="var(--bt-blue)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="bt-cashchart__axis">
        {points.map((point) => (
          <span key={point.month}>{monthLabel(point.month)}</span>
        ))}
      </div>
    </figure>
  );
}

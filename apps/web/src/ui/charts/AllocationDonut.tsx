import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { useT } from '../../i18n';
import { cx } from '../../lib/cx';
import { DISCREET_MASK, formatPercent, formatQuantity, isDiscreetMode } from '../../lib/format';
import type { AllocationSegment } from './types';

export interface AllocationDonutProps {
  /** Weighted/segment data (PROJECTPLAN.md §6.5 weights, §6.9 allocation). */
  data: AllocationSegment[];
  /** Donut diameter in px. Defaults to 200. */
  size?: number;
  className?: string;
  /** Accessible summary of the whole donut. */
  title?: string;
}

import { CATEGORICAL_SERIES } from './palette';

// Fixed-order categorical palette (ui/charts/palette.ts) — validated with the
// dataviz six-checks script; the slice gaps + the labelled legend carry
// identity alongside colour.
const PALETTE = CATEGORICAL_SERIES;

/**
 * Recharts donut for weighted/segment data with an accessible legend
 * (PROJECTPLAN.md §7.3, consumed by the Builder §6.5 and Portfolio §6.9).
 *
 * The legend is rendered as our own list (not Recharts' canvas-measured one) so
 * labels, colours and shares are real DOM — accessible and reliably testable.
 */
export function AllocationDonut({ data, size = 200, className, title }: AllocationDonutProps) {
  const t = useT();
  const chartTitle = title ?? t('common.charts.allocationFallbackTitle');
  const segments = data
    .filter((s) => Number.isFinite(s.value) && s.value > 0)
    .map((s, i) => ({ ...s, color: s.color ?? PALETTE[i % PALETTE.length] }));

  const total = segments.reduce((sum, s) => sum + s.value, 0);

  if (segments.length === 0 || total === 0) {
    return (
      <div
        role="status"
        className={cx('grid place-items-center rounded-md text-sm', className)}
        style={{ minHeight: size, background: 'var(--bt-surface-soft)', color: 'var(--bt-muted)' }}
      >
        {t('common.charts.noAllocationData')}
      </div>
    );
  }

  const summary = segments.map((s) => `${s.label} ${formatShare(s.value / total)}`).join(', ');

  return (
    <div className={cx('flex flex-col items-center gap-4 sm:flex-row sm:items-center', className)}>
      <div
        role="img"
        aria-label={`${chartTitle}: ${summary}`}
        style={{ width: size, height: size }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={segments}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={1}
              stroke="none"
              isAnimationActive={false}
            >
              {segments.map((s) => (
                <Cell key={s.label} fill={s.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, name) => {
                const v = Number(value) || 0;
                // §13.5 V5-P13 arc (a): the raw segment value is an absolute
                // amount (EUR-denominated portfolio value); mask it under
                // discreet mode so only the relative share still surfaces.
                const rawLabel = isDiscreetMode() ? DISCREET_MASK : formatQuantity(v);
                return [`${formatShare(v / total)} (${rawLabel})`, String(name)];
              }}
              contentStyle={{
                background: 'var(--bt-surface-strong)',
                border: '1px solid var(--bt-border-strong)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--bt-text)',
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="flex w-full min-w-0 flex-col gap-1.5 text-sm">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className="bt-soft min-w-0 flex-1 truncate">{s.label}</span>
            <span className="bt-muted tabular-nums">{formatShare(s.value / total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Locale-aware 2 dp percentage of a 0–1 fraction, e.g. `0.125 → "12,50 %"` (§7.1 rule 2). */
function formatShare(fraction: number): string {
  return formatPercent(fraction * 100);
}

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { DISCREET_MASK, formatMoney, isDiscreetMode } from '../../lib/format';

export interface ProjectionChartSeries {
  id: string;
  label: string;
  color: string;
}

/** Recharts-only renderer, dynamically loaded by the forecast surface. */
export function ProjectionChart({
  baseColor,
  baseLabel,
  data,
  overlays,
}: {
  /** Owned by the caller, which paints the same colour on the legend chip. */
  baseColor: string;
  baseLabel: string;
  data: Array<Record<string, number | string>>;
  overlays: ProjectionChartSeries[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="bt-projection-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={baseColor} stopOpacity={0.2} />
            <stop offset="78%" stopColor={baseColor} stopOpacity={0.025} />
            <stop offset="100%" stopColor={baseColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--bt-chart-grid)" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(value: string) => value.slice(0, 4)}
          minTickGap={48}
          stroke="var(--bt-chart-text)"
          fontSize={12}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          width={64}
          tickFormatter={formatCompactEur}
          stroke="var(--bt-chart-text)"
          fontSize={12}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          formatter={(value) => formatMoney(Number(value))}
          contentStyle={{
            background: 'var(--bt-surface-strong)',
            border: '1px solid var(--bt-border-strong)',
            borderRadius: 8,
            color: 'var(--bt-text)',
            fontSize: 12,
            boxShadow: '0 12px 32px color-mix(in srgb, var(--bt-bg) 48%, transparent)',
          }}
          cursor={{ stroke: 'var(--bt-border-strong)', strokeDasharray: '3 3' }}
        />
        <Area
          type="monotone"
          dataKey="base"
          name={baseLabel}
          stroke={baseColor}
          strokeWidth={2}
          fill="url(#bt-projection-fill)"
          fillOpacity={1}
          dot={false}
          isAnimationActive={false}
        />
        {overlays.map((overlay) => (
          <Line
            key={overlay.id}
            type="monotone"
            dataKey={overlay.id}
            name={overlay.label}
            stroke={overlay.color}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function formatCompactEur(value: number): string {
  if (isDiscreetMode()) return DISCREET_MASK;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `€${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `€${Math.round(value / 1_000)}k`;
  return `€${Math.round(value)}`;
}

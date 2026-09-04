import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatCompactMoney, formatMoney } from '../../lib/format';

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
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid stroke="var(--bt-chart-grid)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(value: string) => value.slice(0, 4)}
          minTickGap={48}
          stroke="var(--bt-chart-text)"
          fontSize={12}
        />
        {/* The axis labels the same arithmetic the curve draws, so it reads the
            active base currency and the active locale's magnitude abbreviations
            (`1,2 Mio. €` in de-AT vs `1.2m €` in en-GB) rather than a hardcoded
            `€…M`/`€…k` pair.
            `formatCompactMoney` keeps the discreet-mode mask it always had. */}
        <YAxis
          width={80}
          tickFormatter={(value: number) => formatCompactMoney(value)}
          stroke="var(--bt-chart-text)"
          fontSize={12}
        />
        <Tooltip
          formatter={(value) => formatMoney(Number(value))}
          contentStyle={{
            background: 'var(--bt-surface-strong)',
            border: '1px solid var(--bt-border-strong)',
            borderRadius: 8,
            color: 'var(--bt-text)',
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="base"
          name={baseLabel}
          stroke={baseColor}
          strokeWidth={2}
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
      </LineChart>
    </ResponsiveContainer>
  );
}

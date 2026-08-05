import {
  CartesianGrid,
  Line,
  LineChart,
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
  baseLabel,
  data,
  overlays,
}: {
  baseLabel: string;
  data: Array<Record<string, number | string>>;
  overlays: ProjectionChartSeries[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid stroke="rgba(82, 82, 91, 0.25)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(value: string) => value.slice(0, 4)}
          minTickGap={48}
          stroke="#a1a1aa"
          fontSize={12}
        />
        <YAxis width={64} tickFormatter={formatCompactEur} stroke="#a1a1aa" fontSize={12} />
        <Tooltip
          formatter={(value) => formatMoney(Number(value))}
          contentStyle={{
            background: '#0b0e14',
            border: '1px solid #3f3f46',
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="base"
          name={baseLabel}
          stroke="#38bdf8"
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

function formatCompactEur(value: number): string {
  if (isDiscreetMode()) return DISCREET_MASK;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `€${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `€${Math.round(value / 1_000)}k`;
  return `€${Math.round(value)}`;
}

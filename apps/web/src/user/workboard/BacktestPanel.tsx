import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Time } from 'lightweight-charts';

import {
  BACKTEST_BENCHMARKS,
  BACKTEST_PREVIEW_RANGES,
  type BacktestBenchmark,
  type BacktestPreviewPosition,
  type BacktestPreviewRange,
} from '@bettertrack/contracts';

import { previewBacktest } from '../../lib/backtestApi';
import { cx } from '../../lib/cx';
import { formatDate, formatPercent, formatSignedPercent } from '../../lib/format';
import { EmptyState, Skeleton, StatCard } from '../../ui';
import { PriceChart, type BenchmarkSeries, type ChartPoint } from '../../ui/charts';
import { Alert } from '../components/ui';

export interface BacktestPanelProps {
  /** The (possibly unsaved) basket to backtest — assetId + relative weight (§6.5). */
  positions: BacktestPreviewPosition[];
  className?: string;
}

const RANGE_LABELS: Record<BacktestPreviewRange, string> = {
  '1Y': '1Y',
  '3Y': '3Y',
  '5Y': '5Y',
  MAX: 'Max',
};

const BENCHMARK_LABELS: Record<BacktestBenchmark, string> = {
  '^GSPC': 'S&P 500',
  '^GDAXI': 'DAX',
  URTH: 'MSCI World',
};

function toChartPoints(series: Array<{ date: string; value: number }>): ChartPoint[] {
  return series.map((point) => ({ time: point.date as Time, value: point.value }));
}

function RangeSelector({
  active,
  onSelect,
}: {
  active: BacktestPreviewRange;
  onSelect: (range: BacktestPreviewRange) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Select backtest range"
      className="inline-flex rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
    >
      {BACKTEST_PREVIEW_RANGES.map((token) => {
        const selected = token === active;
        return (
          <button
            key={token}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(token)}
            className={cx(
              'rounded px-2 py-1 text-xs font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              selected
                ? 'bg-sky-600 text-white'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
            )}
          >
            {RANGE_LABELS[token]}
          </button>
        );
      })}
    </div>
  );
}

function BenchmarkToggle({
  active,
  onSelect,
}: {
  active: BacktestBenchmark | null;
  onSelect: (benchmark: BacktestBenchmark | null) => void;
}) {
  return (
    <div role="group" aria-label="Toggle benchmark overlay" className="flex flex-wrap gap-1.5">
      {BACKTEST_BENCHMARKS.map((ticker) => {
        const selected = ticker === active;
        return (
          <button
            key={ticker}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(selected ? null : ticker)}
            className={cx(
              'rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              selected
                ? 'bg-violet-600/20 text-violet-200 ring-violet-600'
                : 'text-neutral-400 ring-neutral-700 hover:bg-neutral-800 hover:text-neutral-100',
            )}
          >
            {BENCHMARK_LABELS[ticker]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Reusable backtest panel (PROJECTPLAN.md §6.5 Right — live preview, §6.6
 * Backtest engine): range selector, benchmark overlay toggle, `PriceChart` of
 * the base-100 index, and headline stats. Takes the basket as props so it
 * drops into both the Conglomerate detail page (saved positions) and the
 * Builder's live preview (debounced draft weights) without change.
 */
export function BacktestPanel({ positions, className }: BacktestPanelProps) {
  const [range, setRange] = useState<BacktestPreviewRange>('5Y');
  const [benchmark, setBenchmark] = useState<BacktestBenchmark | null>(null);

  const hasPositions = positions.length > 0;

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ['backtest-preview', positions, range, benchmark],
    queryFn: ({ signal }) => previewBacktest(positions, range, benchmark, signal),
    enabled: hasPositions,
  });

  const chartSeries = data ? toChartPoints(data.series) : [];
  const benchmarkSeries: BenchmarkSeries | null =
    data?.benchmark && benchmark
      ? { label: BENCHMARK_LABELS[benchmark], series: toChartPoints(data.benchmark.series) }
      : null;

  return (
    <div className={cx('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeSelector active={range} onSelect={setRange} />
        <BenchmarkToggle active={benchmark} onSelect={setBenchmark} />
      </div>

      {!hasPositions ? (
        <EmptyState title="Add positions to preview a backtest" />
      ) : isLoading ? (
        <Skeleton height="h-80" />
      ) : isError ? (
        <Alert tone="error">Could not run the backtest. Please try again.</Alert>
      ) : !data ? null : (
        <>
          {data.notice ? <Alert tone="info">{data.notice}</Alert> : null}
          <PriceChart
            series={chartSeries}
            benchmark={benchmarkSeries}
            showRangeToggle={false}
            loading={isFetching}
            ariaLabel="Conglomerate backtest chart"
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Total return" value={formatSignedPercent(data.stats.totalReturnPct)} />
            <StatCard label="CAGR" value={formatSignedPercent(data.stats.cagrPct)} />
            <StatCard label="Max drawdown" value={formatSignedPercent(data.stats.maxDrawdownPct)} />
            <StatCard label="Volatility (ann.)" value={formatPercent(data.stats.volatilityPct)} />
            <StatCard
              label="Best day"
              value={formatSignedPercent(data.stats.bestDay?.returnPct)}
              subValue={formatDate(data.stats.bestDay?.date)}
            />
            <StatCard
              label="Worst day"
              value={formatSignedPercent(data.stats.worstDay?.returnPct)}
              subValue={formatDate(data.stats.worstDay?.date)}
            />
          </div>
        </>
      )}
    </div>
  );
}

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
import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { EmptyState, Skeleton, StatCard } from '../../ui';
import { PriceChart, type BenchmarkSeries, type ChartPoint } from '../../ui/charts';
import { Alert } from '../components/ui';

export interface BacktestPanelProps {
  /** The (possibly unsaved) basket to backtest — assetId + relative weight (§6.5). */
  positions: BacktestPreviewPosition[];
  className?: string;
}

function rangeLabels(t: TranslateFn): Record<BacktestPreviewRange, string> {
  return {
    '1Y': t('workboard.backtest.range.oneYear'),
    '3Y': t('workboard.backtest.range.threeYear'),
    '5Y': t('workboard.backtest.range.fiveYear'),
    MAX: t('workboard.backtest.range.max'),
  };
}

function benchmarkLabels(t: TranslateFn): Record<BacktestBenchmark, string> {
  return {
    '^GSPC': t('workboard.backtest.benchmark.sp500'),
    '^GDAXI': t('workboard.backtest.benchmark.dax'),
    URTH: t('workboard.backtest.benchmark.msciWorld'),
  };
}

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
  const t = useT();
  const labels = rangeLabels(t);
  return (
    <div
      role="group"
      aria-label={t('workboard.backtest.rangeAriaLabel')}
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
            {labels[token]}
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
  const t = useT();
  const labels = benchmarkLabels(t);
  return (
    <div
      role="group"
      aria-label={t('workboard.backtest.benchmarkAriaLabel')}
      className="flex flex-wrap gap-1.5"
    >
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
            {labels[ticker]}
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
  const t = useT();
  const labels = benchmarkLabels(t);
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
      ? { label: labels[benchmark], series: toChartPoints(data.benchmark.series) }
      : null;

  return (
    <div className={cx('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeSelector active={range} onSelect={setRange} />
        <BenchmarkToggle active={benchmark} onSelect={setBenchmark} />
      </div>

      {!hasPositions ? (
        <EmptyState title={t('workboard.backtest.noPositions')} />
      ) : isLoading ? (
        <Skeleton height="h-80" />
      ) : isError ? (
        <Alert tone="error">{t('workboard.backtest.error')}</Alert>
      ) : !data ? null : (
        <>
          {data.notice ? <Alert tone="info">{data.notice}</Alert> : null}
          <PriceChart
            series={chartSeries}
            benchmark={benchmarkSeries}
            showRangeToggle={false}
            loading={isFetching}
            ariaLabel={t('workboard.backtest.chartAriaLabel')}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard
              label={t('workboard.backtest.stats.totalReturn')}
              value={formatSignedPercent(data.stats.totalReturnPct)}
            />
            <StatCard
              label={t('workboard.backtest.stats.cagr')}
              value={formatSignedPercent(data.stats.cagrPct)}
            />
            <StatCard
              label={t('workboard.backtest.stats.maxDrawdown')}
              value={formatSignedPercent(data.stats.maxDrawdownPct)}
            />
            <StatCard
              label={t('workboard.backtest.stats.volatility')}
              value={formatPercent(data.stats.volatilityPct)}
            />
            <StatCard
              label={t('workboard.backtest.stats.bestDay')}
              value={formatSignedPercent(data.stats.bestDay?.returnPct)}
              subValue={formatDate(data.stats.bestDay?.date)}
            />
            <StatCard
              label={t('workboard.backtest.stats.worstDay')}
              value={formatSignedPercent(data.stats.worstDay?.returnPct)}
              subValue={formatDate(data.stats.worstDay?.date)}
            />
          </div>
        </>
      )}
    </div>
  );
}

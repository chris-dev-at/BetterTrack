import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Time } from 'lightweight-charts';

import {
  BACKTEST_BENCHMARKS,
  BACKTEST_MODES,
  BACKTEST_PREVIEW_RANGES,
  type BacktestBenchmark,
  type BacktestMode,
  type BacktestPreviewPosition,
  type BacktestPreviewRange,
  type BacktestResponse,
} from '@bettertrack/contracts';

import { previewBacktest } from '../../lib/backtestApi';
import { cx } from '../../lib/cx';
import { formatDate, formatPercent, formatSignedPercent } from '../../lib/format';
import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { EmptyState, Skeleton, StatCard } from '../../ui';
import {
  PriceChart,
  type BenchmarkSeries,
  type ChartMarker,
  type ChartPoint,
} from '../../ui/charts';
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

function modeLabels(t: TranslateFn): Record<BacktestMode, string> {
  return {
    clip: t('workboard.backtest.mode.clip'),
    cash: t('workboard.backtest.mode.cash'),
    redistribute: t('workboard.backtest.mode.redistribute'),
  };
}

/**
 * The mode-adaptive notice (§14): in the full-window modes the clipping message
 * gives way to a sentence naming each late constituent's entry and stating the
 * chosen rule (uninvested cash, or the equal split + entry-day rebalance).
 * `null` when nothing was late — the modes are then equivalent to `clip`.
 */
function modeNotice(t: TranslateFn, data: BacktestResponse): string | null {
  if (data.mode === 'clip' || data.entryEvents.length === 0) return null;
  const entries = data.entryEvents.map((e) => `${e.symbol} (${formatDate(e.date)})`).join(', ');
  return data.mode === 'cash'
    ? t('workboard.backtest.modeNotice.cash', { entries })
    : t('workboard.backtest.modeNotice.redistribute', { entries });
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

function ModeSelector({
  active,
  onSelect,
}: {
  active: BacktestMode;
  onSelect: (mode: BacktestMode) => void;
}) {
  const t = useT();
  const labels = modeLabels(t);
  return (
    <div
      role="group"
      aria-label={t('workboard.backtest.modeAriaLabel')}
      className="inline-flex flex-wrap rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
    >
      {BACKTEST_MODES.map((token) => {
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
 * Backtest engine, §14 late-listing modes): range + mode selectors, benchmark
 * overlay toggle, `PriceChart` of the base-100 index with entry markers, and
 * headline stats. Takes the basket as props so it drops into both the
 * Conglomerate detail page (saved positions) and the Builder's live preview
 * (debounced draft weights) without change.
 */
export function BacktestPanel({ positions, className }: BacktestPanelProps) {
  const t = useT();
  const labels = benchmarkLabels(t);
  const [range, setRange] = useState<BacktestPreviewRange>('5Y');
  const [mode, setMode] = useState<BacktestMode>('clip');
  const [benchmark, setBenchmark] = useState<BacktestBenchmark | null>(null);

  const hasPositions = positions.length > 0;

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ['backtest-preview', positions, range, benchmark, mode],
    queryFn: ({ signal }) => previewBacktest(positions, range, benchmark, mode, signal),
    enabled: hasPositions,
  });

  const chartSeries = data ? toChartPoints(data.series) : [];
  const benchmarkSeries: BenchmarkSeries | null =
    data?.benchmark && benchmark
      ? { label: labels[benchmark], series: toChartPoints(data.benchmark.series) }
      : null;
  // One flag per §14 entry event — "X enters" at the late constituent's date.
  const entryMarkers: ChartMarker[] = data
    ? data.entryEvents.map((e) => ({
        time: e.date as Time,
        label: t('workboard.backtest.entryMarker', { symbol: e.symbol }),
      }))
    : [];
  const notice = data ? modeNotice(t, data) : null;

  return (
    <div className={cx('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <RangeSelector active={range} onSelect={setRange} />
          <ModeSelector active={mode} onSelect={setMode} />
        </div>
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
          {notice ? <Alert tone="info">{notice}</Alert> : null}
          {/* The server notice: the clip message in clip mode; in the §14 modes
              it only appears when even the earliest constituent starts after
              the requested window — a data limit no mode can widen. */}
          {data.notice ? <Alert tone="info">{data.notice}</Alert> : null}
          <PriceChart
            series={chartSeries}
            benchmark={benchmarkSeries}
            markers={entryMarkers}
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
            {data.mode === 'cash' && data.idleCashAvgPct !== null ? (
              <StatCard
                label={t('workboard.backtest.stats.idleCash')}
                value={formatPercent(data.idleCashAvgPct)}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

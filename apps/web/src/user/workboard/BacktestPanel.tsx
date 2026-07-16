import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Time } from 'lightweight-charts';

import {
  BACKTEST_BENCHMARKS,
  BACKTEST_MODES,
  BACKTEST_PREVIEW_RANGES,
  REBALANCE_FREQUENCIES,
  type BacktestBenchmark,
  type BacktestBenchmarkInput,
  type BacktestBenchmarkResult,
  type BacktestMode,
  type BacktestPreviewPosition,
  type BacktestPreviewRange,
  type BacktestResponse,
  type BacktestStats,
  type IdeaSource,
  type RebalanceFrequency,
} from '@bettertrack/contracts';

import { previewBacktest } from '../../lib/backtestApi';
import { listConglomerates } from '../../lib/conglomerateApi';
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
import { AssetSearchBox } from '../components/AssetSearchBox';
import { Alert, Button } from '../components/ui';
import { SaveIdeaDialog } from './SaveIdeaDialog';

/** The backtest knobs a saved idea reproduces (V4-P9), minus the basket source. */
export interface BacktestParams {
  range: BacktestPreviewRange;
  benchmark: BacktestBenchmarkInput | null;
  mode: BacktestMode;
  rebalance: RebalanceFrequency;
}

export interface BacktestPanelProps {
  /** The (possibly unsaved) basket to backtest — assetId + relative weight (§6.5). */
  positions: BacktestPreviewPosition[];
  className?: string;
  /**
   * When set, a "Save as idea" action persists this basket (the given source) plus
   * the panel's current backtest params as a saved idea (V4-P9). Omitted where no
   * savable analysis exists.
   */
  source?: IdeaSource;
  /** Seed the range/mode/rebalance/benchmark controls — reopening a saved idea. */
  initialParams?: BacktestParams;
}

/** The committed benchmark choice: the wire input plus a display label (V4-P7). */
interface BenchmarkChoice {
  input: BacktestBenchmarkInput;
  label: string;
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

/**
 * Rebuild the committed benchmark choice from a saved idea's wire input (V4-P9):
 * a preset keeps its localized label; an asset/conglomerate benchmark shows a
 * generic "custom" label (its real name is re-resolved by the preview response).
 */
function benchmarkChoiceFromInput(input: BacktestBenchmarkInput, t: TranslateFn): BenchmarkChoice {
  if ('preset' in input) return { input, label: benchmarkLabels(t)[input.preset] };
  return { input, label: t('workboard.backtest.benchmark.saved') };
}

function modeLabels(t: TranslateFn): Record<BacktestMode, string> {
  return {
    clip: t('workboard.backtest.mode.clip'),
    cash: t('workboard.backtest.mode.cash'),
    redistribute: t('workboard.backtest.mode.redistribute'),
  };
}

function rebalanceLabels(t: TranslateFn): Record<RebalanceFrequency, string> {
  return {
    none: t('workboard.backtest.rebalance.none'),
    monthly: t('workboard.backtest.rebalance.monthly'),
    quarterly: t('workboard.backtest.rebalance.quarterly'),
    yearly: t('workboard.backtest.rebalance.yearly'),
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

/**
 * The rebalance notice (V4-P7): with a schedule active it states the frequency
 * and how many boundary-day rebalances the window contained. `null` when the
 * schedule is off or never fired (e.g. a window shorter than one period).
 */
function rebalanceNotice(t: TranslateFn, data: BacktestResponse): string | null {
  if (data.rebalance === 'none' || data.rebalanceEvents.length === 0) return null;
  return t('workboard.backtest.rebalanceNotice', {
    frequency: t(`workboard.backtest.rebalanceNoticeFrequency.${data.rebalance}`),
    count: String(data.rebalanceEvents.length),
  });
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

/** Rebalance-frequency picker (V4-P7): `none` (buy & hold) or a calendar schedule. */
function RebalanceSelector({
  active,
  onSelect,
}: {
  active: RebalanceFrequency;
  onSelect: (frequency: RebalanceFrequency) => void;
}) {
  const t = useT();
  const labels = rebalanceLabels(t);
  return (
    <div
      role="group"
      aria-label={t('workboard.backtest.rebalanceAriaLabel')}
      className="inline-flex flex-wrap rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
    >
      {REBALANCE_FREQUENCIES.map((token) => {
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

/** Which extra benchmark source is expanded below the pills. */
type BenchmarkSource = 'none' | 'search' | 'conglomerate';

/**
 * Benchmark picker (§13.4 V4-P7): the one-click presets stay as pills, plus a
 * local asset search (§6.2) and a "my conglomerates" source. Exactly one
 * benchmark at a time — picking from any source replaces the previous choice,
 * so the UI cannot express two.
 */
function BenchmarkPicker({
  value,
  onChange,
}: {
  value: BenchmarkChoice | null;
  onChange: (next: BenchmarkChoice | null) => void;
}) {
  const t = useT();
  const labels = benchmarkLabels(t);
  const [source, setSource] = useState<BenchmarkSource>('none');

  const conglomeratesQuery = useQuery({
    queryKey: ['conglomerates'],
    queryFn: ({ signal }) => listConglomerates(signal),
    enabled: source === 'conglomerate',
    staleTime: 30_000,
  });
  const conglomerates = conglomeratesQuery.data?.conglomerates ?? [];

  const activePreset = value && 'preset' in value.input ? value.input.preset : null;
  const pillClass = (selected: boolean) =>
    cx(
      'rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
      selected
        ? 'bg-violet-600/20 text-violet-200 ring-violet-600'
        : 'text-neutral-400 ring-neutral-700 hover:bg-neutral-800 hover:text-neutral-100',
    );

  return (
    <div className="flex flex-col gap-2">
      <div
        role="group"
        aria-label={t('workboard.backtest.benchmarkAriaLabel')}
        className="flex flex-wrap items-center gap-1.5"
      >
        {BACKTEST_BENCHMARKS.map((ticker) => {
          const selected = ticker === activePreset;
          return (
            <button
              key={ticker}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setSource('none');
                onChange(selected ? null : { input: { preset: ticker }, label: labels[ticker] });
              }}
              className={pillClass(selected)}
            >
              {labels[ticker]}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={source === 'search'}
          onClick={() => setSource(source === 'search' ? 'none' : 'search')}
          className={pillClass(source === 'search')}
        >
          {t('workboard.backtest.benchmark.search')}
        </button>
        <button
          type="button"
          aria-pressed={source === 'conglomerate'}
          onClick={() => setSource(source === 'conglomerate' ? 'none' : 'conglomerate')}
          className={pillClass(source === 'conglomerate')}
        >
          {t('workboard.backtest.benchmark.myConglomerates')}
        </button>
        {value && !('preset' in value.input) ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-600/20 px-2.5 py-1 text-xs font-medium text-violet-200 ring-1 ring-inset ring-violet-600">
            {value.label}
            <button
              type="button"
              aria-label={t('workboard.backtest.benchmark.clear')}
              onClick={() => onChange(null)}
              className="rounded-full leading-none text-violet-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              ×
            </button>
          </span>
        ) : null}
      </div>

      {source === 'search' ? (
        <AssetSearchBox
          placeholder={t('workboard.backtest.benchmark.searchPlaceholder')}
          onSelect={(item) => {
            onChange({ input: { assetId: item.id }, label: item.symbol });
            setSource('none');
          }}
        />
      ) : null}

      {source === 'conglomerate' ? (
        conglomeratesQuery.isLoading ? (
          <p className="text-xs text-neutral-500">{t('workboard.backtest.benchmark.loading')}</p>
        ) : conglomeratesQuery.isError ? (
          <p className="text-xs text-rose-400">{t('common.genericError')}</p>
        ) : conglomerates.length === 0 ? (
          <p className="text-xs text-neutral-500">
            {t('workboard.backtest.benchmark.noConglomerates')}
          </p>
        ) : (
          <select
            aria-label={t('workboard.backtest.benchmark.pickConglomerate')}
            value={value && 'conglomerateId' in value.input ? value.input.conglomerateId : ''}
            onChange={(e) => {
              const picked = conglomerates.find((c) => c.id === e.target.value);
              if (picked) {
                onChange({ input: { conglomerateId: picked.id }, label: picked.name });
                setSource('none');
              }
            }}
            className={cx(
              'w-full max-w-xs rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
              'ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500',
            )}
          >
            <option value="">
              {t('workboard.backtest.benchmark.pickConglomeratePlaceholder')}
            </option>
            {conglomerates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )
      ) : null}
    </div>
  );
}

/** One row of the side-by-side stats table: a metric for both series. */
interface StatRow {
  key: string;
  label: string;
  basket: number | null;
  bench: number | null;
  basketSub?: string;
  benchSub?: string;
  /** Signed metrics (+/−) vs plain-magnitude metrics (volatility). */
  signed: boolean;
}

function statRows(t: TranslateFn, basket: BacktestStats, bench: BacktestStats): StatRow[] {
  return [
    {
      key: 'totalReturn',
      label: t('workboard.backtest.stats.totalReturn'),
      basket: basket.totalReturnPct,
      bench: bench.totalReturnPct,
      signed: true,
    },
    {
      key: 'cagr',
      label: t('workboard.backtest.stats.cagr'),
      basket: basket.cagrPct,
      bench: bench.cagrPct,
      signed: true,
    },
    {
      key: 'maxDrawdown',
      label: t('workboard.backtest.stats.maxDrawdown'),
      basket: basket.maxDrawdownPct,
      bench: bench.maxDrawdownPct,
      signed: true,
    },
    {
      key: 'volatility',
      label: t('workboard.backtest.stats.volatility'),
      basket: basket.volatilityPct,
      bench: bench.volatilityPct,
      signed: false,
    },
    {
      key: 'bestDay',
      label: t('workboard.backtest.stats.bestDay'),
      basket: basket.bestDay?.returnPct ?? null,
      bench: bench.bestDay?.returnPct ?? null,
      basketSub: basket.bestDay ? formatDate(basket.bestDay.date) : undefined,
      benchSub: bench.bestDay ? formatDate(bench.bestDay.date) : undefined,
      signed: true,
    },
    {
      key: 'worstDay',
      label: t('workboard.backtest.stats.worstDay'),
      basket: basket.worstDay?.returnPct ?? null,
      bench: bench.worstDay?.returnPct ?? null,
      basketSub: basket.worstDay ? formatDate(basket.worstDay.date) : undefined,
      benchSub: bench.worstDay ? formatDate(bench.worstDay.date) : undefined,
      signed: true,
    },
  ];
}

/**
 * Side-by-side stats (§13.4 V4-P7): every bottom-panel stat rendered for the
 * basket AND the benchmark, with an optional Δ column (basket − benchmark, in
 * percentage points). The Δ stays neutral-coloured — whether "higher" is
 * better depends on the metric (return yes, volatility no).
 */
function StatsTable({
  stats,
  benchmark,
  showDelta,
}: {
  stats: BacktestStats;
  benchmark: BacktestBenchmarkResult;
  showDelta: boolean;
}) {
  const t = useT();
  const rows = statRows(t, stats, benchmark.stats);
  return (
    <div className="overflow-x-auto rounded-lg bg-neutral-900/60 ring-1 ring-inset ring-neutral-800">
      <table
        aria-label={t('workboard.backtest.statsTable.ariaLabel')}
        className="w-full min-w-96 text-sm"
      >
        <thead>
          <tr className="border-b border-neutral-800 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('workboard.backtest.statsTable.metric')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t('workboard.backtest.statsTable.basket')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {benchmark.label}
            </th>
            {showDelta ? (
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t('workboard.backtest.statsTable.delta')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const fmt = row.signed ? formatSignedPercent : formatPercent;
            const delta = row.basket !== null && row.bench !== null ? row.basket - row.bench : null;
            return (
              <tr key={row.key} className="border-b border-neutral-800/60 last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-medium text-neutral-400">
                  {row.label}
                </th>
                <td className="px-3 py-2 text-right text-neutral-100">
                  {fmt(row.basket)}
                  {row.basketSub ? (
                    <span className="block text-xs text-neutral-500">{row.basketSub}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right text-neutral-100">
                  {fmt(row.bench)}
                  {row.benchSub ? (
                    <span className="block text-xs text-neutral-500">{row.benchSub}</span>
                  ) : null}
                </td>
                {showDelta ? (
                  <td className="px-3 py-2 text-right text-neutral-300">
                    {formatSignedPercent(delta)}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Reusable backtest panel (PROJECTPLAN.md §6.5 Right — live preview, §6.6
 * Backtest engine, §14 late-listing modes, §13.4 V4-P7 custom benchmarks +
 * scheduled rebalancing): range / mode / rebalance selectors, a benchmark
 * picker (presets, local asset search, own conglomerates), `PriceChart` of the
 * base-100 index with entry + rebalance markers, and headline stats — rendered
 * side-by-side against the benchmark with an optional Δ column when one is
 * active. Takes the basket as props so it drops into both the Conglomerate
 * detail page (saved positions) and the Builder's live preview (debounced
 * draft weights) without change.
 */
export function BacktestPanel({ positions, className, source, initialParams }: BacktestPanelProps) {
  const t = useT();
  const [range, setRange] = useState<BacktestPreviewRange>(initialParams?.range ?? '5Y');
  const [mode, setMode] = useState<BacktestMode>(initialParams?.mode ?? 'clip');
  const [rebalance, setRebalance] = useState<RebalanceFrequency>(
    initialParams?.rebalance ?? 'none',
  );
  const [benchmark, setBenchmark] = useState<BenchmarkChoice | null>(
    initialParams?.benchmark ? benchmarkChoiceFromInput(initialParams.benchmark, t) : null,
  );
  const [showRebalanceMarkers, setShowRebalanceMarkers] = useState(true);
  const [showDelta, setShowDelta] = useState(true);
  const [saveOpen, setSaveOpen] = useState(false);

  const hasPositions = positions.length > 0;

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ['backtest-preview', positions, range, benchmark?.input ?? null, mode, rebalance],
    queryFn: ({ signal }) =>
      previewBacktest(
        { positions, range, benchmark: benchmark?.input ?? null, mode, rebalance },
        signal,
      ),
    enabled: hasPositions,
  });

  const chartSeries = data ? toChartPoints(data.series) : [];
  const benchmarkSeries: BenchmarkSeries | null = data?.benchmark
    ? { label: data.benchmark.label, series: toChartPoints(data.benchmark.series) }
    : null;
  // Flags on the chart: one per §14 entry event ("X enters"), plus — when not
  // hidden — one per executed scheduled rebalance (V4-P7), sorted by date as
  // the markers plugin requires.
  const markers: ChartMarker[] = data
    ? [
        ...data.entryEvents.map((e) => ({
          time: e.date as Time,
          label: t('workboard.backtest.entryMarker', { symbol: e.symbol }),
        })),
        ...(showRebalanceMarkers
          ? data.rebalanceEvents.map((e) => ({
              time: e.date as Time,
              label: t('workboard.backtest.rebalanceMarker'),
            }))
          : []),
      ].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
    : [];
  const notice = data ? modeNotice(t, data) : null;
  const rebalNotice = data ? rebalanceNotice(t, data) : null;

  return (
    <div className={cx('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <RangeSelector active={range} onSelect={setRange} />
        <ModeSelector active={mode} onSelect={setMode} />
        <RebalanceSelector active={rebalance} onSelect={setRebalance} />
        {source ? (
          <Button variant="secondary" className="ml-auto" onClick={() => setSaveOpen(true)}>
            {t('workboard.ideas.save.action')}
          </Button>
        ) : null}
      </div>
      <BenchmarkPicker value={benchmark} onChange={setBenchmark} />

      {!hasPositions ? (
        <EmptyState title={t('workboard.backtest.noPositions')} />
      ) : isLoading ? (
        <Skeleton height="h-80" />
      ) : isError ? (
        <Alert tone="error">{t('workboard.backtest.error')}</Alert>
      ) : !data ? null : (
        <>
          {notice ? <Alert tone="info">{notice}</Alert> : null}
          {rebalNotice ? <Alert tone="info">{rebalNotice}</Alert> : null}
          {/* The server notice: the clip message in clip mode; in the §14 modes
              it only appears when even the earliest constituent starts after
              the requested window — a data limit no mode can widen. */}
          {data.notice ? <Alert tone="info">{data.notice}</Alert> : null}
          {data.rebalanceEvents.length > 0 || data.benchmark ? (
            <div className="flex flex-wrap items-center gap-4">
              {data.rebalanceEvents.length > 0 ? (
                <label className="inline-flex items-center gap-1.5 text-xs text-neutral-400">
                  <input
                    type="checkbox"
                    checked={showRebalanceMarkers}
                    onChange={(e) => setShowRebalanceMarkers(e.target.checked)}
                    className="size-3.5 accent-sky-600"
                  />
                  {t('workboard.backtest.showRebalanceMarkers')}
                </label>
              ) : null}
              {data.benchmark ? (
                <label className="inline-flex items-center gap-1.5 text-xs text-neutral-400">
                  <input
                    type="checkbox"
                    checked={showDelta}
                    onChange={(e) => setShowDelta(e.target.checked)}
                    className="size-3.5 accent-sky-600"
                  />
                  {t('workboard.backtest.statsTable.showDelta')}
                </label>
              ) : null}
            </div>
          ) : null}
          <PriceChart
            series={chartSeries}
            benchmark={benchmarkSeries}
            markers={markers}
            showRangeToggle={false}
            loading={isFetching}
            ariaLabel={t('workboard.backtest.chartAriaLabel')}
          />
          {data.benchmark ? (
            <>
              <StatsTable stats={data.stats} benchmark={data.benchmark} showDelta={showDelta} />
              {data.mode === 'cash' && data.idleCashAvgPct !== null ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <StatCard
                    label={t('workboard.backtest.stats.idleCash')}
                    value={formatPercent(data.idleCashAvgPct)}
                  />
                </div>
              ) : null}
            </>
          ) : (
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
          )}
        </>
      )}

      {saveOpen && source ? (
        <SaveIdeaDialog
          state={{ source, range, benchmark: benchmark?.input ?? null, mode, rebalance }}
          onClose={() => setSaveOpen(false)}
        />
      ) : null}
    </div>
  );
}

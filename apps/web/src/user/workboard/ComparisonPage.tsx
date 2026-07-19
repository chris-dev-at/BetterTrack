import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { Time } from 'lightweight-charts';

import {
  BACKTEST_PREVIEW_RANGES,
  COMPARISON_MAX_SERIES,
  COMPARISON_MIN_SERIES,
  type BacktestPreviewRange,
  type ComparisonMetricKey,
  type ComparisonSeries,
  type ConglomerateSummary,
} from '@bettertrack/contracts';

import { listConglomerates } from '../../lib/conglomerateApi';
import { compareConglomerates, CONGLOMERATE_COMPARE_QUERY_KEY } from '../../lib/workboardApi';
import { ApiError } from '../../lib/apiClient';
import { cx } from '../../lib/cx';
import { formatDate, formatPercent, formatSignedPercent } from '../../lib/format';
import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { overlayColor, PriceChart, type ChartPoint } from '../../ui/charts';
import { Alert } from '../components/ui';

/**
 * Conglomerate comparison page (PROJECTPLAN.md §13.5 V5-P6 arc a): pick 2–6 of
 * your own conglomerates, overlay their base-100 curves on one chart and read a
 * full stats grid with per-metric deltas against a selectable baseline. The
 * heavy lifting is server-side (`POST /backtest/compare`, one engine run per
 * series over the first pick's window); this surface is deliberately compact
 * (anti-bloat): a selection list, one chart, one grid.
 */

/** Colour of the `i`-th overlaid series — index 0 is the chart's main (sky) line. */
function seriesColor(i: number): string {
  return i === 0 ? '#38bdf8' /* sky-400, PriceChart's MAIN_LINE */ : overlayColor(i - 1);
}

function toChartPoints(series: ReadonlyArray<{ date: string; value: number }>): ChartPoint[] {
  return series.map((point) => ({ time: point.date as Time, value: point.value }));
}

function rangeLabels(t: TranslateFn): Record<BacktestPreviewRange, string> {
  return {
    '1Y': t('workboard.backtest.range.oneYear'),
    '3Y': t('workboard.backtest.range.threeYear'),
    '5Y': t('workboard.backtest.range.fiveYear'),
    MAX: t('workboard.backtest.range.max'),
  };
}

/** Compact range segmented control (reuses the backtest range labels). */
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

/** The list of the caller's conglomerates as a 2–6 multi-select. */
function ConglomeratePicker({
  conglomerates,
  selected,
  onToggle,
}: {
  conglomerates: ConglomerateSummary[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const t = useT();
  const atCap = selected.length >= COMPARISON_MAX_SERIES;
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm font-medium text-neutral-300">
        {t('workboard.comparison.selectHeading')}
      </legend>
      <p className="mb-1 text-xs text-neutral-500">
        {t('workboard.comparison.selectHint', {
          min: COMPARISON_MIN_SERIES,
          max: COMPARISON_MAX_SERIES,
        })}
      </p>
      <ul className="flex flex-col gap-1">
        {conglomerates.map((c) => {
          const isSelected = selected.includes(c.id);
          const noPositions = c.positionCount === 0;
          const disabled = noPositions || (!isSelected && atCap);
          return (
            <li key={c.id}>
              <label
                className={cx(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm ring-1 ring-inset',
                  isSelected
                    ? 'bg-sky-950/40 text-neutral-100 ring-sky-800'
                    : 'text-neutral-300 ring-neutral-800',
                  disabled
                    ? 'cursor-not-allowed opacity-50'
                    : 'cursor-pointer hover:bg-neutral-900',
                )}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => onToggle(c.id)}
                  className="size-4 accent-sky-600"
                />
                <span className="flex-1 truncate">{c.name}</span>
                {noPositions ? (
                  <span className="text-xs text-neutral-500">
                    {t('workboard.comparison.emptyPositions')}
                  </span>
                ) : (
                  <span className="text-xs text-neutral-500">
                    {c.positionCount === 1
                      ? t('workboard.conglomerates.positionCountOne', { count: c.positionCount })
                      : t('workboard.conglomerates.positionCountOther', { count: c.positionCount })}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-xs text-neutral-500" aria-live="polite">
        {t('workboard.comparison.selectionCount', {
          count: selected.length,
          max: COMPARISON_MAX_SERIES,
        })}
      </p>
    </fieldset>
  );
}

/** Colour-chip legend mapping each overlaid series to its name. */
function ChartLegend({ series }: { series: ComparisonSeries[] }) {
  const t = useT();
  return (
    <ul
      className="flex flex-wrap gap-x-4 gap-y-1"
      aria-label={t('workboard.comparison.legendAriaLabel')}
    >
      {series.map((s, i) => (
        <li
          key={s.conglomerateId}
          className="inline-flex items-center gap-1.5 text-xs text-neutral-300"
        >
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-full"
            style={{ backgroundColor: seriesColor(i) }}
          />
          <span className="truncate">{s.name}</span>
        </li>
      ))}
    </ul>
  );
}

/** One stat row of the grid: how to pull its value + delta out of a series. */
interface MetricRow {
  key: ComparisonMetricKey;
  labelKey: string;
  /** Signed metrics carry a +/− (returns); volatility is a plain magnitude. */
  signed: boolean;
}

const METRIC_ROWS: readonly MetricRow[] = [
  { key: 'totalReturnPct', labelKey: 'workboard.backtest.stats.totalReturn', signed: true },
  { key: 'cagrPct', labelKey: 'workboard.backtest.stats.cagr', signed: true },
  { key: 'maxDrawdownPct', labelKey: 'workboard.backtest.stats.maxDrawdown', signed: true },
  { key: 'volatilityPct', labelKey: 'workboard.backtest.stats.volatility', signed: false },
  { key: 'bestDayPct', labelKey: 'workboard.backtest.stats.bestDay', signed: true },
  { key: 'worstDayPct', labelKey: 'workboard.backtest.stats.worstDay', signed: true },
];

/** The raw metric value + optional date sub-label for a series' stat vector. */
function metricValue(
  series: ComparisonSeries,
  key: ComparisonMetricKey,
): { value: number | null; sub?: string } {
  const { stats } = series;
  switch (key) {
    case 'bestDayPct':
      return {
        value: stats.bestDay?.returnPct ?? null,
        sub: stats.bestDay ? formatDate(stats.bestDay.date) : undefined,
      };
    case 'worstDayPct':
      return {
        value: stats.worstDay?.returnPct ?? null,
        sub: stats.worstDay ? formatDate(stats.worstDay.date) : undefined,
      };
    default:
      // The remaining keys (total return, CAGR, drawdown, volatility) map
      // one-to-one onto the wire stats.
      return { value: stats[key] };
  }
}

/** Metric-by-conglomerate grid with per-metric deltas against the baseline column. */
function ComparisonGrid({
  series,
  baselineId,
  onPickBaseline,
}: {
  series: ComparisonSeries[];
  baselineId: string;
  onPickBaseline: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="overflow-x-auto rounded-lg bg-neutral-900/60 ring-1 ring-inset ring-neutral-800">
      <table
        aria-label={t('workboard.comparison.grid.ariaLabel')}
        className="w-full min-w-[36rem] text-sm"
      >
        <thead>
          <tr className="border-b border-neutral-800 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('workboard.comparison.grid.metric')}
            </th>
            {series.map((s, i) => {
              const isBaseline = s.conglomerateId === baselineId;
              return (
                <th
                  key={s.conglomerateId}
                  scope="col"
                  className={cx('px-3 py-2 text-right font-medium', isBaseline && 'bg-sky-950/40')}
                >
                  <span className="inline-flex items-center justify-end gap-1.5">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 rounded-full"
                      style={{ backgroundColor: seriesColor(i) }}
                    />
                    <span className="normal-case text-neutral-200">{s.name}</span>
                  </span>
                  <label className="mt-1 flex items-center justify-end gap-1 text-[0.65rem] font-normal normal-case text-neutral-400">
                    <input
                      type="radio"
                      name="comparison-baseline"
                      checked={isBaseline}
                      onChange={() => onPickBaseline(s.conglomerateId)}
                      aria-label={t('workboard.comparison.setBaseline', { name: s.name })}
                      className="size-3 accent-sky-600"
                    />
                    {t('workboard.comparison.baselineLabel')}
                  </label>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {METRIC_ROWS.map((row) => {
            const fmt = row.signed ? formatSignedPercent : formatPercent;
            return (
              <tr key={row.key} className="border-b border-neutral-800/60 last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-medium text-neutral-400">
                  {t(row.labelKey)}
                </th>
                {series.map((s) => {
                  const isBaseline = s.conglomerateId === baselineId;
                  const { value, sub } = metricValue(s, row.key);
                  const delta = s.deltas[row.key];
                  return (
                    <td
                      key={s.conglomerateId}
                      className={cx(
                        'px-3 py-2 text-right text-neutral-100',
                        isBaseline && 'bg-sky-950/40',
                      )}
                    >
                      {fmt(value)}
                      {sub ? <span className="block text-xs text-neutral-500">{sub}</span> : null}
                      {!isBaseline ? (
                        <span className="block text-xs text-neutral-400">
                          {formatSignedPercent(delta)}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ComparisonPage() {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [range, setRange] = useState<BacktestPreviewRange>('5Y');
  const [baselineId, setBaselineId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['conglomerates'],
    queryFn: ({ signal }) => listConglomerates(signal),
  });
  const conglomerates = useMemo(() => listQuery.data?.conglomerates ?? [], [listQuery.data]);

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= COMPARISON_MAX_SERIES
          ? prev
          : [...prev, id],
    );
  }

  // The baseline only applies while it stays selected; otherwise the server
  // defaults it to the first pick (and re-picking is a cheap recompute).
  const effectiveBaseline = baselineId && selected.includes(baselineId) ? baselineId : undefined;
  const canCompare = selected.length >= COMPARISON_MIN_SERIES;

  const compareQuery = useQuery({
    queryKey: [...CONGLOMERATE_COMPARE_QUERY_KEY, selected, range, effectiveBaseline ?? null],
    queryFn: ({ signal }) =>
      compareConglomerates(
        {
          conglomerateIds: selected,
          range,
          mode: 'clip',
          rebalance: 'none',
          baselineId: effectiveBaseline,
        },
        signal,
      ),
    enabled: canCompare,
    // Keep the grid/chart on screen while a baseline switch (or an added pick)
    // refetches — the server-side core is cached, so the recompute feels instant.
    placeholderData: keepPreviousData,
  });

  const data = compareQuery.data;
  const errorCode = compareQuery.error instanceof ApiError ? compareQuery.error.code : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-neutral-100">
          {t('workboard.comparison.title')}
        </h1>
        <p className="text-sm text-neutral-400">{t('workboard.comparison.description')}</p>
      </header>

      {listQuery.isLoading ? (
        <Skeleton height="h-40" />
      ) : conglomerates.length < COMPARISON_MIN_SERIES ? (
        <EmptyState
          title={t('workboard.comparison.noConglomerates')}
          description={t('workboard.comparison.noConglomeratesHint')}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <ConglomeratePicker conglomerates={conglomerates} selected={selected} onToggle={toggle} />

          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <RangeSelector active={range} onSelect={setRange} />
            </div>

            {!canCompare ? (
              <EmptyState
                title={t('workboard.comparison.needTwo', { min: COMPARISON_MIN_SERIES })}
              />
            ) : compareQuery.isLoading ? (
              <Skeleton height="h-80" />
            ) : compareQuery.isError ? (
              <Alert tone="error">
                {errorCode === 'BACKTEST_UNAVAILABLE'
                  ? t('workboard.comparison.windowError')
                  : t('workboard.comparison.error')}
              </Alert>
            ) : !data ? null : (
              <>
                <PriceChart
                  series={toChartPoints(data.series[0]!.series)}
                  overlays={data.series
                    .slice(1)
                    .map((s) => ({ label: s.name, series: toChartPoints(s.series) }))}
                  showRangeToggle={false}
                  loading={compareQuery.isFetching}
                  ariaLabel={t('workboard.comparison.chartAriaLabel')}
                />
                <ChartLegend series={data.series} />
                <ComparisonGrid
                  series={data.series}
                  baselineId={data.baselineId}
                  onPickBaseline={setBaselineId}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

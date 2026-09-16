import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { Time } from 'lightweight-charts';

import {
  BACKTEST_PREVIEW_RANGES,
  COMPARISON_MAX_SERIES,
  COMPARISON_MIN_SERIES,
  parseComparisonWindowMismatch,
  type BacktestPreviewRange,
  type ComparisonMetricKey,
  type ComparisonSeries,
  type ComparisonWindowMismatch,
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
import { Button, PageHead } from '../../ui/origin';
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

/**
 * Colour of the `i`-th compared series. Every series — the primary included —
 * is drawn as a chart OVERLAY (see the render), so the categorical palette is
 * assigned straight through and the grid's chips match the chart's legend
 * swatch for the same basket.
 */
function seriesColor(i: number): string {
  return overlayColor(i);
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
    <div aria-label={t('workboard.backtest.rangeAriaLabel')} className="bt-seg" role="group">
      {BACKTEST_PREVIEW_RANGES.map((token) => {
        const selected = token === active;
        return (
          <button
            aria-pressed={selected}
            className={cx(selected && 'is-active')}
            key={token}
            onClick={() => onSelect(token)}
            type="button"
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
      <legend className="bt-h3 mb-1">{t('workboard.comparison.selectHeading')}</legend>
      <p className="bt-meta mb-1">
        {t('workboard.comparison.selectHint', {
          min: COMPARISON_MIN_SERIES,
          max: COMPARISON_MAX_SERIES,
        })}
      </p>
      <ul className="bt-panel bt-band">
        {conglomerates.map((c) => {
          const isSelected = selected.includes(c.id);
          const noPositions = c.positionCount === 0;
          const disabled = noPositions || (!isSelected && atCap);
          return (
            <li key={c.id}>
              <label
                className={cx(
                  'bt-band__row flex items-center gap-2.5',
                  disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                )}
                style={isSelected ? { background: 'var(--bt-surface-soft)' } : undefined}
              >
                <input
                  checked={isSelected}
                  className="size-4"
                  disabled={disabled}
                  onChange={() => onToggle(c.id)}
                  style={{ accentColor: 'var(--bt-gold-graphic)' }}
                  type="checkbox"
                />
                <span className="bt-row-title flex-1 truncate">{c.name}</span>
                {noPositions ? (
                  <span className="bt-meta">{t('workboard.comparison.emptyPositions')}</span>
                ) : (
                  <span className="bt-meta">
                    {c.positionCount === 1
                      ? t('workboard.conglomerates.positionCountOne', { count: c.positionCount })
                      : t('workboard.conglomerates.positionCountOther', {
                          count: c.positionCount,
                        })}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      <p aria-live="polite" className="bt-meta mt-1">
        {t('workboard.comparison.selectionCount', {
          count: selected.length,
          max: COMPARISON_MAX_SERIES,
        })}
      </p>
    </fieldset>
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
    <div className="bt-table-wrap bt-table-wrap--panel">
      <table
        aria-label={t('workboard.comparison.grid.ariaLabel')}
        className="bt-table"
        style={{ minWidth: '36rem' }}
      >
        <thead>
          <tr>
            <th scope="col">{t('workboard.comparison.grid.metric')}</th>
            {series.map((s, i) => {
              const isBaseline = s.conglomerateId === baselineId;
              return (
                <th
                  className="is-num"
                  key={s.conglomerateId}
                  scope="col"
                  style={isBaseline ? { background: 'var(--bt-blue-soft)' } : undefined}
                >
                  <span className="inline-flex items-center justify-end gap-1.5">
                    <span
                      aria-hidden="true"
                      className="bt-dot"
                      style={{ background: seriesColor(i) }}
                    />
                    <span className="bt-soft">{s.name}</span>
                  </span>
                  {/* The slice of this basket that resolved to no asset (#1755):
                      the curve and every stat below cover only the rest of it,
                      normalized to 100, so the column is not the whole blueprint. */}
                  {s.unresolvedPct > 0 ? (
                    <span className="bt-meta block">
                      {t('workboard.comparison.unresolvedShare', {
                        pct: formatPercent(s.unresolvedPct),
                      })}
                    </span>
                  ) : null}
                  <label className="bt-meta mt-1 flex items-center justify-end gap-1">
                    <input
                      aria-label={t('workboard.comparison.setBaseline', { name: s.name })}
                      checked={isBaseline}
                      className="size-3"
                      name="comparison-baseline"
                      onChange={() => onPickBaseline(s.conglomerateId)}
                      style={{ accentColor: 'var(--bt-gold-graphic)' }}
                      type="radio"
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
              <tr key={row.key}>
                <th scope="row">{t(row.labelKey)}</th>
                {series.map((s) => {
                  const isBaseline = s.conglomerateId === baselineId;
                  const { value, sub } = metricValue(s, row.key);
                  const delta = s.deltas[row.key];
                  return (
                    <td
                      className="is-num"
                      key={s.conglomerateId}
                      style={isBaseline ? { background: 'var(--bt-blue-soft)' } : undefined}
                    >
                      {fmt(value)}
                      {sub ? <span className="bt-meta block">{sub}</span> : null}
                      {!isBaseline ? (
                        <span className="bt-meta block">{formatSignedPercent(delta)}</span>
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

/**
 * The page's OWN sentence for a comparison-window refusal (#1659). The server's
 * `message` is operator-facing English prose; what reaches the reader is built
 * here from the structured cause, so it is localized, names the one basket that
 * broke the window, and quotes only dates the payload actually carries.
 */
function windowMismatchMessage(t: TranslateFn, mismatch: ComparisonWindowMismatch): string {
  switch (mismatch.reason) {
    case 'starts-late':
      return t('workboard.comparison.windowMismatch.startsLate', {
        name: mismatch.name,
        seriesStart: formatDate(mismatch.seriesStart),
        windowStart: formatDate(mismatch.windowStart),
      });
    case 'ends-early':
      return t('workboard.comparison.windowMismatch.endsEarly', {
        name: mismatch.name,
        seriesEnd: formatDate(mismatch.seriesEnd),
        windowEnd: formatDate(mismatch.windowEnd),
      });
    // The engine's clip notice is prose, not a field: there is no honest date of
    // this series' own to quote, so the copy names the basket and stops.
    case 'clipped':
      return t('workboard.comparison.windowMismatch.clipped', { name: mismatch.name });
  }
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
  const apiError = compareQuery.error instanceof ApiError ? compareQuery.error : null;
  const errorCode = apiError?.code ?? null;
  // A window refusal is DETERMINISTIC — the identical request fails identically
  // for as long as the basket's history does — so when the server names the
  // offending basket we drop the retry and offer the one action that can change
  // the outcome instead. Without the structured cause (an older API, or another
  // 422 that shares the code) nothing here can tell which basket, or even
  // whether it is the window at all, so that branch keeps its generic copy and
  // its retry.
  const windowMismatch =
    errorCode === 'BACKTEST_UNAVAILABLE' ? parseComparisonWindowMismatch(apiError?.details) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHead
        sub={t('workboard.comparison.description')}
        title={t('workboard.comparison.title')}
      />

      {listQuery.isLoading ? (
        <Skeleton height="h-40" />
      ) : listQuery.isError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert tone="error">{t('workboard.comparison.listError')}</Alert>
          <Button onClick={() => void listQuery.refetch()}>{t('common.retry')}</Button>
        </div>
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
              <div className="flex flex-col items-start gap-2">
                <Alert tone="error">
                  {windowMismatch
                    ? `${windowMismatchMessage(t, windowMismatch)} ${t('workboard.comparison.windowMismatch.hint')}`
                    : errorCode === 'BACKTEST_UNAVAILABLE'
                      ? t('workboard.comparison.windowError')
                      : t('workboard.comparison.error')}
                </Alert>
                {/*
                  The drop affordance needs a pick to drop. When the named
                  basket is no longer in the selection the refusal is stale — the
                  next request is a DIFFERENT one, so a retry can genuinely
                  succeed and the alert never ends without an action.
                */}
                {windowMismatch && selected.includes(windowMismatch.conglomerateId) ? (
                  <Button onClick={() => toggle(windowMismatch.conglomerateId)}>
                    {t('workboard.comparison.windowMismatch.drop', { name: windowMismatch.name })}
                  </Button>
                ) : (
                  <Button onClick={() => void compareQuery.refetch()}>{t('common.retry')}</Button>
                )}
              </div>
            ) : !data ? null : (
              <>
                {/*
                  ONE legend for all N series. PriceChart builds its legend from
                  `overlays` alone, so passing only series 1..n left the page with
                  two: the chart's (missing the primary) above the page's own
                  (complete). Every series is an overlay here instead — the
                  primary also feeds the main-series slot, which the shared chart
                  needs to anchor its scale and draws under its own overlay line —
                  so the chart's single legend names them all, in the same
                  categorical colours the stats grid chips use.
                */}
                <PriceChart
                  series={toChartPoints(data.series[0]!.series)}
                  overlays={data.series.map((s) => ({
                    label: s.name,
                    series: toChartPoints(s.series),
                  }))}
                  showRangeToggle={false}
                  loading={compareQuery.isFetching}
                  ariaLabel={t('workboard.comparison.chartAriaLabel')}
                />
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

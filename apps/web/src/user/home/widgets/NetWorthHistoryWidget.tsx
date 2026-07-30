import { useQueries } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type { PortfolioHistoryPoint } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { getPortfolioHistory } from '../../../lib/portfolioApi';
import { PriceChart } from '../../../ui/charts';
import type { ChartPoint, PriceRange } from '../../../ui/charts';
import { Empty } from '../../../ui/origin';
import { PERFORMANCE_RANGES, toHistoryRange } from './PerformanceChartWidget';
import type { WidgetProps } from './types';

/**
 * **Every** portfolio's value over time, summed into one curve — the graph the
 * `performance-chart` widget deliberately refuses to draw.
 *
 * That refusal was right for a *per-portfolio* widget: naively overlaying or
 * adding curves whose portfolios start on different dates draws a step that
 * never happened. This widget exists because the question ("what is my whole net
 * worth doing?") is worth answering properly, so it does the aggregation
 * honestly instead of pretending the endpoint is already user-level:
 *
 *  - every point is normalized to an **epoch-second** stamp. Intraday points
 *    (1D/1W/1M) carry `time`, daily ones only `date` (#556) — mixing the two
 *    keying styles in one series would sort wrongly, so both collapse to seconds;
 *  - the curve is sampled at the **sorted union** of every portfolio's stamps, so
 *    no portfolio's movement is dropped just because another has no point there;
 *  - between its own points a portfolio contributes its **last known value**
 *    (forward fill), and before its **first** point it contributes **0**. So a
 *    portfolio opened last month lifts the total on the day it opened, and the
 *    curve before that is the honest total of what existed then — not a
 *    back-projected fiction, and not a step at the left edge.
 *
 * Fanned out under the same `['portfolio', id, 'history', range]` keys and the
 * same hour-long `staleTime` as the portfolio page and `performance-chart`, so a
 * board holding this widget *and* a per-portfolio chart pays for each series
 * once. Unscoped by design — it IS the all-portfolios view.
 */

/**
 * Portfolios charted at most. A board-level widget must not turn into a
 * 40-request burst on a heavily-partitioned account; past a dozen curves the sum
 * is also no longer legible as a shape. The excess is dropped from the *sum*
 * rather than silently mis-totalled — see {@link NetWorthHistoryWidget}'s note.
 */
/** Fan-out ceiling for the combined curve; shared with the performance chart. */
export const MAX_HISTORY_PORTFOLIOS = 12;

/** §6.9 caches the series for an hour server-side; mirror it client-side. */
const HISTORY_STALE_MS = 3_600_000;

interface Sample {
  /** Epoch seconds — the one keying style this widget works in. */
  seconds: number;
  value: number;
}

function asRange(value: string | undefined): PriceRange {
  return PERFORMANCE_RANGES.includes(value as PriceRange) ? (value as PriceRange) : '6M';
}

/**
 * One portfolio's points → ascending epoch-second samples. Unparseable stamps are
 * skipped rather than becoming `NaN` keys that would poison the union.
 */
export function normalizeSamples(points: readonly PortfolioHistoryPoint[]): Sample[] {
  const samples: Sample[] = [];
  for (const point of points) {
    const seconds = Math.floor(Date.parse(point.time ?? point.date) / 1000);
    if (!Number.isFinite(seconds)) continue;
    samples.push({ seconds, value: point.valueEur });
  }
  return samples.sort((a, b) => a.seconds - b.seconds);
}

/**
 * Sum per-portfolio sample sets onto the union of their stamps, forward-filling
 * each portfolio's last known value and treating "before its first point" as 0.
 *
 * Single pass per portfolio: the stamps are ascending and each cursor only moves
 * forward, so this is O(total points) rather than a per-stamp binary search.
 */
export function combineSamples(sets: readonly Sample[][]): ChartPoint[] {
  const stamps = [...new Set(sets.flatMap((set) => set.map((sample) => sample.seconds)))].sort(
    (a, b) => a - b,
  );
  const cursors = sets.map(() => 0);
  // 0 = "this portfolio did not exist yet", which is exactly its contribution.
  const carried = sets.map(() => 0);

  return stamps.map((stamp) => {
    let total = 0;
    for (const [index, set] of sets.entries()) {
      let cursor = cursors[index] ?? 0;
      // Consume every sample at or before this stamp; the last one wins, so
      // several intraday points sharing a second collapse correctly.
      while (cursor < set.length && (set[cursor]?.seconds ?? Infinity) <= stamp) {
        carried[index] = set[cursor]?.value ?? 0;
        cursor += 1;
      }
      cursors[index] = cursor;
      total += carried[index] ?? 0;
    }
    return { time: stamp as Time, value: total };
  });
}

export function NetWorthHistoryWidget({
  settings,
  onSettingsChange,
  scopedPortfolios,
  portfoliosLoading,
  size,
}: WidgetProps) {
  const t = useT();
  const range = asRange(settings.range);
  const historyRange = toHistoryRange(range);
  const charted = scopedPortfolios.slice(0, MAX_HISTORY_PORTFOLIOS);

  // `combine` runs inside React Query and its result is structurally cached, so
  // the chart receives a stable `series` identity and redraws only when the
  // numbers actually change — not on every parent render.
  const combined = useQueries({
    queries: charted.map((portfolio) => ({
      queryKey: ['portfolio', portfolio.id, 'history', historyRange],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getPortfolioHistory(portfolio.id, historyRange, false, signal),
      staleTime: HISTORY_STALE_MS,
    })),
    combine: (results) => ({
      series: combineSamples(results.map((result) => normalizeSamples(result.data?.points ?? []))),
      loading: results.some((result) => result.isLoading || result.isFetching),
      baseCurrency: results.find((result) => result.data !== undefined)?.data?.baseCurrency,
    }),
  });

  if (!portfoliosLoading && charted.length === 0) {
    return <Empty title={t('home.widgets.netWorthHistory.empty')} />;
  }

  return (
    <div className="bt-chart">
      <PriceChart
        ariaLabel={t('home.widgets.netWorthHistory.ariaLabel', {
          label: t('home.builder.scopeAll'),
        })}
        height={size === 'l' ? 300 : 220}
        loading={portfoliosLoading || combined.loading}
        mode="area"
        onRangeChange={(next) => onSettingsChange({ range: next })}
        range={range}
        ranges={PERFORMANCE_RANGES}
        series={combined.series}
        valueCurrency={combined.baseCurrency}
      />
    </div>
  );
}

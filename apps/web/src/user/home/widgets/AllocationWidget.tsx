import { useT } from '../../../i18n';
import { formatPercent } from '../../../lib/format';
import { AllocationDonut } from '../../../ui/charts';
import type { AllocationSegment } from '../../../ui/charts';
import { categoricalColor } from '../../../ui/charts/palette';
import { MoneyText } from '../../../ui';
import { Empty, SkeletonBlock } from '../../../ui/origin';
import { widgetVariant } from '../config';
import { usePortfolioSummaries } from '../homeData';
import { mergeHoldings } from '../holdings';
import type { WidgetProps } from './types';

/**
 * Composition of what the scoped portfolios hold. Cash is part of what a portfolio
 * is worth (#311), so it gets its own slice and the shares describe the net-worth
 * figure the hero shows.
 *
 * The tail is folded rather than coloured: a categorical palette stops being
 * readable past its token ceiling, so only the largest positions get an
 * identity and the rest merge into one "Other" slice.
 *
 * **Two forms.** `donut` (default) shows the shape of the whole — good for "is this
 * balanced?" at a glance. `bars` ranks the same segments as a list with the share
 * and amount printed per row, which is what you actually need to answer "how much
 * is in X?" — a question a donut can only ever approximate. Same segments, same
 * order, same colours; only the encoding differs.
 */

/** Named slices before the tail folds into "Other" (plus the cash slice). */
const NAMED_SLICES = 6;

export function AllocationWidget({
  settings,
  scopedPortfolios,
  portfoliosLoading,
  size,
}: WidgetProps) {
  const t = useT();
  const results = usePortfolioSummaries(scopedPortfolios);
  const loading = portfoliosLoading || results.some((result) => result.isLoading);

  if (loading) return <SkeletonBlock height={200} />;

  const holdings = mergeHoldings(results.map((result) => result.data?.holdings ?? []));
  const cash = results.reduce((total, result) => total + (result.data?.totals.cashEur ?? 0), 0);

  const positions = holdings
    .filter((holding) => holding.marketValueEur != null && holding.marketValueEur > 0)
    .sort((a, b) => (b.marketValueEur ?? 0) - (a.marketValueEur ?? 0));

  const segments: AllocationSegment[] = positions
    .slice(0, NAMED_SLICES)
    .map((holding) => ({ label: holding.asset.symbol, value: holding.marketValueEur! }));

  const tail = positions
    .slice(NAMED_SLICES)
    .reduce((total, holding) => total + (holding.marketValueEur ?? 0), 0);
  if (tail > 0) segments.push({ label: t('home.widgets.allocation.other'), value: tail });
  if (cash > 0) segments.push({ label: t('home.widgets.allocation.cash'), value: cash });

  if (segments.length === 0) return <Empty title={t('home.widgets.allocation.empty')} />;

  if (widgetVariant('allocation', settings) === 'bars') {
    return <AllocationBars segments={segments} />;
  }

  return (
    <AllocationDonut
      data={segments}
      size={size === 's' ? 150 : 190}
      title={t('home.widgets.allocation.chartTitle')}
    />
  );
}

/**
 * The same segments as a ranked bar list. Each row's bar is scaled to the *largest*
 * segment rather than to the total, so the shape of the ranking stays legible even
 * when one position dominates — the printed share is what carries the absolute
 * reading, and it is right there on the row.
 *
 * Colours come from the shared categorical palette in the same index order the
 * donut assigns, so switching form never re-colours a position.
 */
function AllocationBars({ segments }: { segments: readonly AllocationSegment[] }) {
  const t = useT();
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const peak = Math.max(...segments.map((segment) => segment.value), 0);
  if (total <= 0) return <Empty title={t('home.widgets.allocation.empty')} />;

  return (
    <ul className="bt-home-alloc">
      {segments.map((segment, index) => (
        <li className="bt-home-alloc__row" key={segment.label}>
          <span className="bt-home-alloc__head">
            <span className="bt-row-title bt-home-alloc__name" title={segment.label}>
              {segment.label}
            </span>
            <span className="bt-num bt-home-alloc__pct">
              {formatPercent((segment.value / total) * 100)}
            </span>
          </span>
          <span aria-hidden="true" className="bt-home-alloc__track">
            <span
              style={{
                background: categoricalColor(index),
                width: peak > 0 ? `${(segment.value / peak) * 100}%` : '0%',
              }}
            />
          </span>
          <span className="bt-meta bt-home-alloc__amount">
            <MoneyText amount={segment.value} />
          </span>
        </li>
      ))}
    </ul>
  );
}

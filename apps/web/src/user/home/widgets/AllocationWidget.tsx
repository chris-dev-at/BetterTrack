import { useT } from '../../../i18n';
import { AllocationDonut } from '../../../ui/charts';
import type { AllocationSegment } from '../../../ui/charts';
import { Empty, SkeletonBlock } from '../../../ui/origin';
import { usePortfolioSummaries } from '../homeData';
import { mergeHoldings } from '../holdings';
import type { WidgetProps } from './types';

/**
 * Composition of what the scoped portfolios hold, as the shared allocation
 * donut. Cash is part of what a portfolio is worth (#311), so it gets its own
 * slice and the shares describe the net-worth figure the hero shows.
 *
 * The tail is folded rather than coloured: a categorical palette stops being
 * readable past its token ceiling, so only the largest positions get an
 * identity and the rest merge into one "Other" slice.
 */

/** Named slices before the tail folds into "Other" (plus the cash slice). */
const NAMED_SLICES = 6;

export function AllocationWidget({ scopedPortfolios, portfoliosLoading, size }: WidgetProps) {
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

  return (
    <AllocationDonut
      data={segments}
      size={size === 's' ? 150 : 190}
      title={t('home.widgets.allocation.chartTitle')}
    />
  );
}

import { Link } from 'react-router-dom';

import { useT } from '../../../i18n';
import { formatPercent } from '../../../lib/format';
import { Empty, SkeletonBlock } from '../../../ui/origin';
import { usePortfolioSummaries } from '../homeData';
import { mergeHoldings } from '../holdings';
import type { WidgetProps } from './types';

/**
 * How much of the scoped portfolios rides on their single biggest position, and
 * on the top three together.
 *
 * Built from exactly the holdings the allocation widget already reads — the same
 * `['portfolio', id]` entries, merged the same way — so the two can never tell
 * different stories about the same board. The denominator is `totalValueEur`
 * (cash included), because that is the figure the net-worth hero shows and
 * therefore the whole a share should be a share *of*; a concentration measured
 * against market value alone would climb whenever the user spent cash, which is
 * not what the number is asking.
 *
 * Stated, not graded. "Concentrated" is only bad relative to an intent this app
 * does not know, so there is no threshold, no colour and no warning — just the two
 * shares and which position drives them.
 */

/** Positions in the "top N" figure beside the leader. */
const TOP_N = 3;

export function ConcentrationWidget({ scopedPortfolios, portfoliosLoading }: WidgetProps) {
  const t = useT();
  const results = usePortfolioSummaries(scopedPortfolios);
  const loading = portfoliosLoading || results.some((result) => result.isLoading);

  if (loading) return <SkeletonBlock height={92} />;

  const totalValue = results.reduce(
    (sum, result) => sum + (result.data?.totals.totalValueEur ?? 0),
    0,
  );
  const ranked = mergeHoldings(results.map((result) => result.data?.holdings ?? []))
    .filter((holding) => holding.marketValueEur != null && holding.marketValueEur > 0)
    .sort((a, b) => (b.marketValueEur ?? 0) - (a.marketValueEur ?? 0));

  const leader = ranked[0];
  if (leader === undefined || totalValue <= 0) {
    return <Empty title={t('home.widgets.concentration.empty')} />;
  }

  const share = (value: number) => Math.min(100, Math.max(0, (value / totalValue) * 100));
  const leaderPct = share(leader.marketValueEur ?? 0);
  const topPct = share(
    ranked.slice(0, TOP_N).reduce((sum, holding) => sum + (holding.marketValueEur ?? 0), 0),
  );

  return (
    <div className="bt-home-ind bt-home-ind--stack">
      <div className="bt-home-ind__figures">
        <p className="bt-num bt-home-ind__value">{formatPercent(leaderPct)}</p>
        <p className="bt-meta">
          {t('home.widgets.concentration.inWord')}{' '}
          <Link className="bt-home-txn__link" to={`/assets/${leader.asset.id}`}>
            {leader.asset.symbol}
          </Link>
        </p>
      </div>
      {/* A share of a whole, so it gets a track: the empty part is as meaningful
          as the filled part. Neutral ink — see the module note on not grading. */}
      <div aria-hidden="true" className="bt-home-ind__track">
        <span style={{ width: `${leaderPct}%` }} />
      </div>
      <p className="bt-meta">
        {t('home.widgets.concentration.topN', { n: TOP_N, pct: formatPercent(topPct) })}
      </p>
    </div>
  );
}

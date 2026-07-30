import { useQueries } from '@tanstack/react-query';

import type { CashSource } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { listCashSources } from '../../../lib/portfolioApi';
import { MoneyText } from '../../../ui';
import { Empty, SkeletonBlock } from '../../../ui/origin';
import type { WidgetProps } from './types';

/**
 * Where the cash actually sits: every active cash source with its balance, and
 * the total underneath.
 *
 * Fanned out under the portfolio page's exact `['portfolio', id, 'cash-sources',
 * false]` key (active-only), so a board scoped to a portfolio the user also
 * visits shares one entry with the cash pages instead of issuing a parallel
 * request.
 *
 * Nothing is truncated. The footer total is the sum of exactly the rows above it
 * — a "total" that silently included sources the user cannot see would be worse
 * than no total at all, and cash sources are few enough (a handful per portfolio)
 * that the honest version also fits.
 */

/** Portfolios fanned out at most, mirroring the other multi-portfolio widgets. */
const MAX_PORTFOLIOS = 12;

interface Group {
  portfolioId: string;
  portfolioName: string;
  sources: readonly CashSource[];
}

export function CashBalancesWidget({
  scopedPortfolios,
  scopedPortfolio,
  portfoliosLoading,
}: WidgetProps) {
  const t = useT();
  const sourced = scopedPortfolios.slice(0, MAX_PORTFOLIOS);

  const merged = useQueries({
    queries: sourced.map((portfolio) => ({
      queryKey: ['portfolio', portfolio.id, 'cash-sources', false],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listCashSources(portfolio.id, false, signal),
      // The page's own staleness for this key — same entry, same rules.
      staleTime: 30_000,
    })),
    combine: (results) => ({
      groups: results
        .map((result, index) => ({
          portfolioId: sourced[index]?.id ?? '',
          portfolioName: sourced[index]?.name ?? '',
          sources: result.data?.sources ?? [],
        }))
        .filter((group) => group.sources.length > 0),
      loading: results.some((result) => result.isLoading),
    }),
  });

  if (portfoliosLoading || merged.loading) return <SkeletonBlock height={120} />;
  if (merged.groups.length === 0) return <Empty title={t('home.widgets.cashBalances.empty')} />;

  const total = merged.groups.reduce(
    (sum, group) => sum + group.sources.reduce((inner, source) => inner + source.balanceEur, 0),
    0,
  );
  // Group headers only earn their space when there is more than one portfolio in
  // play; scoped to one, the frame's badge already names it.
  const grouped = scopedPortfolio === null && merged.groups.length > 1;

  return (
    <div>
      {grouped ? (
        merged.groups.map((group) => (
          <CashGroup group={group} key={group.portfolioId} withHeading />
        ))
      ) : (
        <SourceList sources={merged.groups.flatMap((group) => group.sources)} />
      )}
      <p className="bt-home-cash__total">
        <span className="bt-label">{t('home.widgets.cashBalances.total')}</span>
        <span className="bt-num">
          <MoneyText amount={total} currency="EUR" />
        </span>
      </p>
    </div>
  );
}

function CashGroup({ group, withHeading }: { group: Group; withHeading: boolean }) {
  return (
    <div className="bt-home-cash__group">
      {withHeading ? (
        <p className="bt-label bt-home-cash__portfolio" title={group.portfolioName}>
          {group.portfolioName}
        </p>
      ) : null}
      <SourceList sources={group.sources} />
    </div>
  );
}

function SourceList({ sources }: { sources: readonly CashSource[] }) {
  return (
    <ul className="bt-band">
      {sources.map((source) => (
        <li className="bt-home-row bt-home-row--split" key={source.id}>
          <span className="bt-home-row__main">
            <span className="bt-row-title bt-home-cash__name" title={source.name}>
              {source.name}
            </span>
          </span>
          <span className="bt-num">
            {/* The cash ledger is EUR-native (§5.4) — never the user's base by default. */}
            <MoneyText amount={source.balanceEur} currency="EUR" />
          </span>
        </li>
      ))}
    </ul>
  );
}

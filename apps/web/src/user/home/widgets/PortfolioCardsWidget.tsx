import { Link } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';

import { useT } from '../../../i18n';
import { EM_DASH, formatPercent } from '../../../lib/format';
import { getPortfolioHistory } from '../../../lib/portfolioApi';
import { MAIN_SERIES } from '../../../ui/charts/palette';
import { MoneyText } from '../../../ui';
import { Badge, Button, Empty, SkeletonBlock } from '../../../ui/origin';
import { ACTIVE_PORTFOLIO_PARAM } from '../../portfolio/PortfolioSwitcher';
import {
  isVaultedPortfolio,
  lockedPortfolioCount,
  portfolioDisplayName,
  type PortfolioVaultStub,
} from '../../portfolio/lockedPortfolio';
import { VaultStateAction } from '../../vault/ui/VaultStateAction';
import { useVaultEndpointState } from '../../vault/ui/useVaultEndpointState';
import { widgetVariant } from '../config';
import { usePortfolioSummaries } from '../homeData';
import { hasUnsafeAggregateMember, UnavailableHomeAggregate } from './aggregateSafety';
import type { WidgetProps } from './types';

/**
 * Every active portfolio — the "overview over all my portfolios" the owner asked
 * for. Both reads reuse the portfolio pages' cache entries (`['portfolio', id]` and
 * `['portfolio', id, 'history', '1M']`), so a user who also keeps a performance
 * widget on 1M pays for the series once.
 *
 * **Scope.** Shows every active portfolio by default, or exactly the ones the user
 * picked — "only these three" is the case this widget exists to serve, so it reads
 * `scopedPortfolios` rather than the full list.
 *
 * **Two forms.** `cards` (default) gives each portfolio a tile with its value,
 * today's move and a month-shaped sparkline — browsable, and it survives a narrow
 * column. `table` drops the sparklines for aligned columns plus each portfolio's
 * **share of the total**, which is the comparison a card grid cannot make: figures
 * in separate tiles are read one at a time, figures in a column are read against
 * each other. That share is deliberately share-of-what-is-shown: over a chosen set
 * it answers "how do these three divide up between them?", which is the question a
 * set implies, and the header tag states that a set is in play so the 100 % can
 * never be misread as the whole account.
 */

/** The sparkline window. Matches the portfolio page's default range. */
const SPARK_RANGE = '1M' as const;

/** Placeholder while one cell's own figure is still loading. */
const ELLIPSIS = '…';

/**
 * A trend shape, not a chart: no axes, no ticks, no hover. Drawn inline so a
 * board with a dozen portfolios does not spin up a charting instance per row.
 * Neutral analytical blue on purpose — the day-change figure beside it already
 * carries the up/down meaning, and colouring both would double-encode it.
 */
function MiniSpark({ values, label }: { values: readonly number[]; label: string }) {
  const width = 104;
  const height = 30;
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length < 2) return <span className="bt-home-pcard__spark" />;

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const span = max - min || 1;
  const step = width / (usable.length - 1);
  const points = usable
    .map((value, index) => {
      const x = index * step;
      // 1px inset top and bottom so the 1.6px stroke never clips at the edges.
      const y = height - 1.5 - ((value - min) / span) * (height - 3);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      aria-label={label}
      className="bt-home-pcard__spark"
      height={height}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <polyline
        fill="none"
        points={points}
        stroke={MAIN_SERIES}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
      />
    </svg>
  );
}

export function PortfolioCardsWidget({
  settings,
  // Aliased: everything below reads "the portfolios this widget shows", which is
  // now the *scoped* set — all of them, or the ones the user picked.
  scopedPortfolios: portfolios,
  portfoliosLoading,
}: WidgetProps) {
  const t = useT();
  const summaries = usePortfolioSummaries(portfolios);
  const histories = useQueries({
    queries: portfolios.map((portfolio) => ({
      queryKey: ['portfolio', portfolio.id, 'history', SPARK_RANGE],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getPortfolioHistory(portfolio.id, SPARK_RANGE, false, signal),
      enabled: !isVaultedPortfolio(portfolio),
      staleTime: 3_600_000,
    })),
  });

  const loading =
    portfoliosLoading ||
    summaries.some((summary) => summary.isLoading) ||
    histories.some((history) => history.isLoading);

  if (loading) {
    return (
      <div className="bt-home-pcards">
        <SkeletonBlock height={92} />
        <SkeletonBlock height={92} />
      </div>
    );
  }

  if (portfolios.length === 0) return <Empty title={t('home.widgets.portfolioCards.empty')} />;
  if (
    hasUnsafeAggregateMember(portfolios, summaries) ||
    hasUnsafeAggregateMember(portfolios, histories)
  ) {
    return <UnavailableHomeAggregate />;
  }

  const lockedCount = lockedPortfolioCount(portfolios);
  const lockedFallback = t('vault.lockedStub.fallbackAlias');

  if (widgetVariant('portfolio-cards', settings) === 'table') {
    const totalValue = portfolios.reduce(
      (sum, _portfolio, index) => sum + (summaries[index]?.data?.totals.totalValueEur ?? 0),
      0,
    );
    return (
      <>
        {lockedCount > 0 ? (
          <p className="bt-meta mb-2">
            {t(lockedCount === 1 ? 'vault.lockedStub.countOne' : 'vault.lockedStub.count', {
              count: lockedCount,
            })}
          </p>
        ) : null}
        <table className="bt-table bt-home-ptable">
          <thead>
            <tr>
              <th scope="col">{t('home.widgets.portfolioCards.colName')}</th>
              <th className="is-num" scope="col">
                {t('home.widgets.portfolioCards.colValue')}
              </th>
              <th className="is-num" scope="col">
                {t('home.widgets.portfolioCards.colToday')}
              </th>
              <th className="is-num" scope="col">
                {t('home.widgets.portfolioCards.colShare')}
              </th>
            </tr>
          </thead>
          <tbody>
            {portfolios.map((portfolio, index) => {
              if (isVaultedPortfolio(portfolio)) {
                return (
                  <LockedPortfolioTableRow
                    fallback={lockedFallback}
                    key={portfolio.id}
                    portfolio={portfolio}
                  />
                );
              }
              const totals = summaries[index]?.data?.totals ?? null;
              return (
                <tr key={portfolio.id}>
                  <td>
                    <Link
                      className="bt-home-txn__link"
                      to={`/portfolio?${ACTIVE_PORTFOLIO_PARAM}=${portfolio.id}`}
                    >
                      {portfolioDisplayName(portfolio, lockedFallback)}
                    </Link>
                    {/* One failed row retries itself; the other nine keep their
                        figures instead of being replaced by a single panel. */}
                    {summaries[index]?.isError || histories[index]?.isError ? (
                      <button
                        className="bt-link ml-2 text-xs"
                        onClick={() => {
                          void summaries[index]?.refetch();
                          void histories[index]?.refetch();
                        }}
                        type="button"
                      >
                        {t('common.retry')}
                      </button>
                    ) : null}
                  </td>
                  <td className="is-num">
                    {summaries[index]?.isPending ? (
                      ELLIPSIS
                    ) : totals === null ? (
                      EM_DASH
                    ) : (
                      <MoneyText amount={totals.totalValueEur} />
                    )}
                  </td>
                  <td className="is-num">
                    {totals === null ? EM_DASH : <MoneyText amount={totals.dayChangeEur} signed />}
                  </td>
                  <td className="is-num bt-muted">
                    {totals === null || totalValue <= 0
                      ? EM_DASH
                      : formatPercent((totals.totalValueEur / totalValue) * 100)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {lockedCount > 0 ? (
        <p className="bt-meta">
          {t(lockedCount === 1 ? 'vault.lockedStub.countOne' : 'vault.lockedStub.count', {
            count: lockedCount,
          })}
        </p>
      ) : null}
      <div className="bt-home-pcards">
        {portfolios.map((portfolio, index) => {
          if (isVaultedPortfolio(portfolio)) {
            return (
              <LockedPortfolioCard
                fallback={lockedFallback}
                key={portfolio.id}
                portfolio={portfolio}
              />
            );
          }
          const totals = summaries[index]?.data?.totals ?? null;
          // No trend shape while this portfolio's own series is loading or
          // failed — the cell degrades, the board does not.
          const values =
            histories[index]?.isPending || histories[index]?.isError
              ? []
              : (histories[index]?.data?.points ?? []).map((point) => point.valueEur);
          return (
            <Link
              className="bt-panel bt-panel--soft bt-home-pcard"
              key={portfolio.id}
              to={`/portfolio?${ACTIVE_PORTFOLIO_PARAM}=${portfolio.id}`}
            >
              <span className="bt-home-pcard__head">
                <span className="bt-row-title bt-home-pcard__name">
                  {portfolioDisplayName(portfolio, lockedFallback)}
                </span>
                {portfolio.isDefault ? <Badge>{t('home.defaultPortfolio')}</Badge> : null}
              </span>
              <span className="bt-home-pcard__body">
                <span className="bt-home-pcard__figures">
                  <span className="bt-num bt-home-pcard__value">
                    {summaries[index]?.isPending ? (
                      ELLIPSIS
                    ) : totals === null ? (
                      EM_DASH
                    ) : (
                      <MoneyText amount={totals.totalValueEur} />
                    )}
                  </span>
                  <span className="bt-meta">
                    {summaries[index]?.isError ? (
                      t('common.unavailable')
                    ) : totals === null ? null : (
                      <MoneyText amount={totals.dayChangeEur} signed />
                    )}
                  </span>
                </span>
                <MiniSpark
                  label={t('home.widgets.portfolioCards.sparkAriaLabel', {
                    name: portfolioDisplayName(portfolio, lockedFallback),
                  })}
                  values={values}
                />
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function LockedPortfolioTableRow({
  fallback,
  portfolio,
}: {
  fallback: string;
  portfolio: PortfolioVaultStub;
}) {
  const t = useT();
  const state = useVaultEndpointState(portfolio.vaultId);
  return (
    <tr data-vault-stub="true">
      <td className="bt-row-title">{portfolioDisplayName(portfolio, fallback)}</td>
      <td colSpan={3}>
        {state.data ? (
          <VaultStateAction state={state.data} vaultId={portfolio.vaultId} />
        ) : (
          <Button
            disabled={state.isPending}
            onClick={() => void state.refetch()}
            size="sm"
            type="button"
            variant="quiet"
          >
            {state.isError ? t('common.retry') : t('common.loading')}
          </Button>
        )}
      </td>
    </tr>
  );
}

function LockedPortfolioCard({
  fallback,
  portfolio,
}: {
  fallback: string;
  portfolio: PortfolioVaultStub;
}) {
  const t = useT();
  const state = useVaultEndpointState(portfolio.vaultId);
  return (
    <article className="bt-panel bt-panel--soft bt-home-pcard" data-vault-stub="true">
      <span className="bt-home-pcard__head">
        <span className="bt-row-title bt-home-pcard__name">
          {portfolioDisplayName(portfolio, fallback)}
        </span>
        <Badge>{t('vault.lockedStub.badge')}</Badge>
      </span>
      {state.data ? (
        <VaultStateAction state={state.data} vaultId={portfolio.vaultId} />
      ) : (
        <Button
          disabled={state.isPending}
          onClick={() => void state.refetch()}
          size="sm"
          type="button"
          variant="quiet"
        >
          {state.isError ? t('common.retry') : t('common.loading')}
        </Button>
      )}
    </article>
  );
}

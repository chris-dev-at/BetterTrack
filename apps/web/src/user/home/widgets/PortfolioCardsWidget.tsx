import { Link } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';

import { useT } from '../../../i18n';
import { getPortfolioHistory } from '../../../lib/portfolioApi';
import { MAIN_SERIES } from '../../../ui/charts/palette';
import { MoneyText } from '../../../ui';
import { Badge, Empty, SkeletonBlock } from '../../../ui/origin';
import { ACTIVE_PORTFOLIO_PARAM } from '../../portfolio/PortfolioSwitcher';
import { usePortfolioSummaries } from '../homeData';
import type { WidgetProps } from './types';

/**
 * Every active portfolio as one compact card — the "overview over all my
 * portfolios" the owner asked for. Name, current value, today's move and a
 * month-shaped sparkline; the whole card opens that portfolio.
 *
 * Both reads reuse the portfolio pages' cache entries (`['portfolio', id]` and
 * `['portfolio', id, 'history', '1M']`), so a user who also keeps a performance
 * widget on 1M pays for the series once.
 */

/** The sparkline window. Matches the portfolio page's default range. */
const SPARK_RANGE = '1M' as const;

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

export function PortfolioCardsWidget({ portfolios, portfoliosLoading }: WidgetProps) {
  const t = useT();
  const summaries = usePortfolioSummaries(portfolios);
  const histories = useQueries({
    queries: portfolios.map((portfolio) => ({
      queryKey: ['portfolio', portfolio.id, 'history', SPARK_RANGE],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getPortfolioHistory(portfolio.id, SPARK_RANGE, false, signal),
      staleTime: 3_600_000,
    })),
  });

  if (portfoliosLoading) {
    return (
      <div className="bt-home-pcards">
        <SkeletonBlock height={92} />
        <SkeletonBlock height={92} />
      </div>
    );
  }

  if (portfolios.length === 0) return <Empty title={t('home.widgets.portfolioCards.empty')} />;

  return (
    <div className="bt-home-pcards">
      {portfolios.map((portfolio, index) => {
        const totals = summaries[index]?.data?.totals ?? null;
        const values = (histories[index]?.data?.points ?? []).map((point) => point.valueEur);
        return (
          <Link
            className="bt-panel bt-panel--soft bt-home-pcard"
            key={portfolio.id}
            to={`/portfolio?${ACTIVE_PORTFOLIO_PARAM}=${portfolio.id}`}
          >
            <span className="bt-home-pcard__head">
              <span className="bt-row-title bt-home-pcard__name">{portfolio.name}</span>
              {portfolio.isDefault ? <Badge>{t('home.defaultPortfolio')}</Badge> : null}
            </span>
            <span className="bt-home-pcard__body">
              <span className="bt-home-pcard__figures">
                <span className="bt-num bt-home-pcard__value">
                  {totals === null ? '…' : <MoneyText amount={totals.totalValueEur} />}
                </span>
                <span className="bt-meta">
                  {totals === null ? null : <MoneyText amount={totals.dayChangeEur} signed />}
                </span>
              </span>
              <MiniSpark
                label={t('home.widgets.portfolioCards.sparkAriaLabel', { name: portfolio.name })}
                values={values}
              />
            </span>
          </Link>
        );
      })}
    </div>
  );
}

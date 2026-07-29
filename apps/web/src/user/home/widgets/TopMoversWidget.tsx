import { Link } from 'react-router-dom';

import type { Holding } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { cx } from '../../../lib/cx';
import { formatSignedPercent } from '../../../lib/format';
import { MoneyText } from '../../../ui';
import { Empty, Seg, SkeletonBlock } from '../../../ui/origin';
import { usePortfolioSummaries } from '../homeData';
import { mergeHoldings } from '../holdings';
import type { MoverMetric } from '../config';
import type { WidgetProps } from './types';

/**
 * Top climbers and fallers across the scoped portfolios — the owner's "my top
 * climber generally" when scoped to all, or one portfolio's movers when scoped.
 *
 * At size S only the climbers list is shown (that is the question people
 * actually ask a small tile); M and L show both columns. The metric toggle is
 * direct manipulation and persists into the widget's settings.
 */

const LIMIT = 4;

interface Ranked {
  holding: Holding;
  pct: number;
  deltaEur: number | null;
}

function rank(holdings: readonly Holding[], metric: MoverMetric): Ranked[] {
  const ranked: Ranked[] = [];
  for (const holding of holdings) {
    const pct = metric === 'day' ? holding.dayChangePct : holding.unrealizedPnlPct;
    if (pct == null) continue;
    ranked.push({
      holding,
      pct,
      deltaEur: metric === 'day' ? holding.dayChangeEur : holding.unrealizedPnlEur,
    });
  }
  return ranked;
}

function MoverList({ title, items }: { title: string; items: readonly Ranked[] }) {
  const t = useT();
  return (
    <div>
      <h3 className="bt-h3 bt-home-movers__title">{title}</h3>
      {items.length === 0 ? (
        <p className="bt-meta bt-home-movers__none">{t('home.widgets.topMovers.none')}</p>
      ) : (
        <ul className="bt-band">
          {items.map(({ holding, pct, deltaEur }) => (
            <li className="bt-home-mover" key={holding.asset.id}>
              <span className="bt-home-mover__ident">
                <Link
                  className="bt-row-title bt-home-mover__link"
                  to={`/assets/${holding.asset.id}`}
                >
                  {holding.asset.symbol}
                </Link>
                <span className="bt-row-sub bt-home-mover__name" title={holding.asset.name}>
                  {holding.asset.name}
                </span>
              </span>
              <span className="bt-home-mover__figures">
                <span
                  className={cx('bt-num', pct > 0 ? 'bt-pos' : pct < 0 ? 'bt-neg' : 'bt-muted')}
                >
                  {formatSignedPercent(pct)}
                </span>
                {deltaEur != null ? (
                  <span className="bt-meta">
                    <MoneyText amount={deltaEur} signed />
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TopMoversWidget({
  settings,
  onSettingsChange,
  scopedPortfolios,
  portfoliosLoading,
  size,
}: WidgetProps) {
  const t = useT();
  const metric: MoverMetric = settings.metric === 'total' ? 'total' : 'day';
  const results = usePortfolioSummaries(scopedPortfolios);
  const loading = portfoliosLoading || results.some((result) => result.isLoading);

  if (loading) return <SkeletonBlock height={150} />;

  const ranked = rank(mergeHoldings(results.map((result) => result.data?.holdings ?? [])), metric);
  if (ranked.length === 0) return <Empty title={t('home.widgets.topMovers.empty')} />;

  const climbers = ranked
    .filter((item) => item.pct > 0)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, LIMIT);
  const fallers = ranked
    .filter((item) => item.pct < 0)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, LIMIT);

  return (
    <div>
      <div className="bt-home-movers__bar">
        <Seg
          ariaLabel={t('home.widgets.topMovers.metricAriaLabel')}
          onChange={(next) => onSettingsChange({ metric: next })}
          options={[
            { value: 'day', label: t('home.widgets.topMovers.dayMetric') },
            { value: 'total', label: t('home.widgets.topMovers.totalMetric') },
          ]}
          value={metric}
        />
      </div>
      <div className="bt-home-movers">
        <MoverList items={climbers} title={t('home.widgets.topMovers.climbers')} />
        {size === 's' ? null : (
          <MoverList items={fallers} title={t('home.widgets.topMovers.fallers')} />
        )}
      </div>
    </div>
  );
}

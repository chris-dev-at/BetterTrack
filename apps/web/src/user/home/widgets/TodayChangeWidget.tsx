import { useT } from '../../../i18n';
import { formatSignedPercent } from '../../../lib/format';
import { MoneyText } from '../../../ui';
import { SkeletonBlock, Stat, StatStrip } from '../../../ui/origin';
import { useRollup } from '../homeData';
import type { WidgetProps } from './types';

/**
 * Today's move as a compact stat, scope-aware. The quiet counterpart to the
 * hero: for a board that leads with a chart or a portfolio list rather than the
 * net-worth headline, this is how "what changed today" still gets a slot.
 */
export function TodayChangeWidget({ scopedPortfolios, portfoliosLoading }: WidgetProps) {
  const t = useT();
  const rollup = useRollup(scopedPortfolios);
  const loading = portfoliosLoading || rollup.loading;

  if (loading) return <SkeletonBlock height={58} />;
  if (rollup.status === 'unavailable') {
    return <p className="bt-soft text-sm">{t('common.unavailable')}</p>;
  }

  return (
    <div>
      <StatStrip>
        <Stat
          delta={formatSignedPercent(rollup.dayChangePct.valuePct)}
          deltaTone={
            rollup.dayChange.valueEur > 0 ? 'pos' : rollup.dayChange.valueEur < 0 ? 'neg' : 'muted'
          }
          label={t('home.widgets.todayChange.label')}
          value={<MoneyText amount={rollup.dayChange.valueEur} signed />}
        />
        <Stat
          label={t('home.widgets.todayChange.totalLabel')}
          value={<MoneyText amount={rollup.totalValue.valueEur} />}
        />
      </StatStrip>
      {rollup.totalValue.coverage.kind === 'partial' ? (
        <p className="bt-meta">
          {t(rollup.totalValue.coverage.qualifier.messageKey, {
            count: rollup.totalValue.coverage.qualifier.count,
          })}
        </p>
      ) : null}
    </div>
  );
}

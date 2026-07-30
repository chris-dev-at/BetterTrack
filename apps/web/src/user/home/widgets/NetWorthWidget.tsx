import { useT } from '../../../i18n';
import { cx } from '../../../lib/cx';
import { formatSignedPercent } from '../../../lib/format';
import { MoneyText } from '../../../ui';
import { SkeletonBlock } from '../../../ui/origin';
import { useRollup } from '../homeData';
import type { WidgetProps } from './types';

/**
 * The net-worth hero — the page's single focal point (owner intent: "one thing
 * my eyes land on"). The headline value, one rounded change tag directly
 * beneath it reading `money | percent`, and the invested/cash composition kept
 * deliberately quiet underneath. Everything else on the board is calmer than
 * this by design.
 *
 * Scope 'all' rolls every active portfolio up; a portfolio scope shows just that
 * one (the frame's tag names it, so the widget never repeats it).
 */
export function NetWorthWidget({ scopedPortfolios, portfoliosLoading }: WidgetProps) {
  const t = useT();
  const rollup = useRollup(scopedPortfolios);
  const loading = portfoliosLoading || rollup.loading;

  if (loading) {
    return (
      <div className="bt-home-hero">
        <SkeletonBlock height={44} width={280} />
        <SkeletonBlock height={26} width={190} />
      </div>
    );
  }

  const positive = rollup.dayChange > 0;
  const negative = rollup.dayChange < 0;

  return (
    <div className="bt-home-hero">
      <p className="bt-hero-value">
        <MoneyText amount={rollup.totalValue} />
      </p>
      <p
        className={cx('bt-change-pill', positive && 'is-pos', negative && 'is-neg')}
        title={t('home.widgets.netWorth.changeTitle')}
      >
        <MoneyText amount={rollup.dayChange} signed />
        <span aria-hidden="true" className="bt-change-pill__sep">
          |
        </span>
        <span className="bt-num">{formatSignedPercent(rollup.dayChangePct)}</span>
      </p>
      <p className="bt-meta bt-home-hero__sub">
        <MoneyText amount={rollup.invested} /> {t('home.widgets.netWorth.investedWord')}
        <span aria-hidden="true"> · </span>
        <MoneyText amount={rollup.cash} /> {t('home.widgets.netWorth.cashWord')}
      </p>
    </div>
  );
}

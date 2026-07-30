import { useT } from '../../../i18n';
import { formatPercent } from '../../../lib/format';
import { MAIN_SERIES, POSITIVE } from '../../../ui/charts/palette';
import { MoneyText } from '../../../ui';
import { Empty, SkeletonBlock } from '../../../ui/origin';
import { widgetVariant } from '../config';
import { usePortfolioSummaries } from '../homeData';
import type { WidgetProps } from './types';

/**
 * How much of the scoped portfolios is cash rather than invested.
 *
 * The one indicator the owner named, and it needs no new data: the portfolio
 * totals already carry `cashEur` and `totalValueEur`, and the portfolio page's own
 * liquidity ring (§V3-P0, #322) splits exactly this pair. The split is stated the
 * same way here on purpose — invested share = `marketValueEur / totalValueEur`,
 * liquid share = the remainder — so the widget and that page can never disagree
 * about the same portfolio. (Since `totalValue = marketValue + cash`, reading the
 * liquid side straight off `cashEur / totalValueEur` is the same number; it is
 * computed from the cash side here because that is the side the widget is about.)
 *
 * Deliberately NOT a judgement. There is no "good" liquidity ratio to grade
 * against, so nothing here is coloured pos/neg: the two shares get the same
 * invested-blue / liquid-jade identity pair the portfolio page uses, and the user
 * draws their own conclusion.
 */

interface Split {
  cashEur: number;
  totalEur: number;
  cashPct: number;
}

function split(rows: readonly { cashEur: number; totalValueEur: number }[]): Split | null {
  const cashEur = rows.reduce((sum, row) => sum + row.cashEur, 0);
  const totalEur = rows.reduce((sum, row) => sum + row.totalValueEur, 0);
  if (totalEur <= 0) return null;
  // Clamped like the portfolio page: a pending valuation can briefly make the
  // parts disagree with the whole, and a 103 %-full ring is worse than a full one.
  const cashPct = Math.min(100, Math.max(0, (cashEur / totalEur) * 100));
  return { cashEur, totalEur, cashPct };
}

export function LiquidityWidget({
  settings,
  scopedPortfolios,
  portfoliosLoading,
  size,
}: WidgetProps) {
  const t = useT();
  const results = usePortfolioSummaries(scopedPortfolios);
  const loading = portfoliosLoading || results.some((result) => result.isLoading);

  if (loading) return <SkeletonBlock height={92} />;

  const totals = split(
    results
      .map((result) => result.data?.totals)
      .filter((entry): entry is NonNullable<typeof entry> => entry != null),
  );
  if (totals === null) return <Empty title={t('home.widgets.liquidity.empty')} />;

  const variant = widgetVariant('liquidity', settings);

  return (
    <div className="bt-home-ind">
      {variant === 'bar' ? (
        <LiquidityBar cashPct={totals.cashPct} />
      ) : (
        <LiquidityArc cashPct={totals.cashPct} size={size === 's' ? 68 : 82} />
      )}
      <div className="bt-home-ind__figures">
        <p className="bt-num bt-home-ind__value">{formatPercent(totals.cashPct)}</p>
        <p className="bt-meta">
          <MoneyText amount={totals.cashEur} currency="EUR" /> {t('home.widgets.liquidity.ofWord')}{' '}
          <MoneyText amount={totals.totalEur} />
        </p>
      </div>
    </div>
  );
}

/**
 * The ratio as two arcs of one ring. Decorative — the percentage and both amounts
 * are stated in text beside it, so the shape carries no information of its own.
 */
function LiquidityArc({ cashPct, size }: { cashPct: number; size: number }) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const cashLength = (cashPct / 100) * circumference;

  return (
    <svg
      aria-hidden="true"
      className="bt-home-ind__arc"
      height={size}
      viewBox="0 0 64 64"
      width={size}
    >
      {/* Track under both arcs, so any rounding gap reads as neutral. */}
      <circle
        cx="32"
        cy="32"
        fill="none"
        r={radius}
        stroke="var(--bt-surface-strong)"
        strokeWidth="8"
      />
      <circle
        cx="32"
        cy="32"
        fill="none"
        r={radius}
        stroke={POSITIVE}
        strokeDasharray={`${cashLength} ${circumference}`}
        strokeWidth="8"
        transform="rotate(-90 32 32)"
      />
      <circle
        cx="32"
        cy="32"
        fill="none"
        r={radius}
        stroke={MAIN_SERIES}
        strokeDasharray={`${circumference - cashLength} ${circumference}`}
        strokeDashoffset={-cashLength}
        strokeWidth="8"
        transform="rotate(-90 32 32)"
      />
    </svg>
  );
}

/** The same ratio as one split bar — survives a narrow tile beside a long number. */
function LiquidityBar({ cashPct }: { cashPct: number }) {
  return (
    <div aria-hidden="true" className="bt-home-ind__bar">
      <span style={{ background: POSITIVE, width: `${cashPct}%` }} />
      <span style={{ background: MAIN_SERIES, width: `${100 - cashPct}%` }} />
    </div>
  );
}

import type { AnalyticsContributionRow } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { EM_DASH, formatPercent, formatSignedPercent } from '../../../lib/format';
import { MoneyText } from '../../../ui';

/**
 * Per-asset contribution table (PROJECTPLAN.md §13.3 V3-P9). One row per VISIBLE
 * asset with its current value / cost / unrealized P&L (holdings facts, base
 * currency), its `weight` as a share of the visible set, and its
 * `contributionPct` — the asset's share of the filtered series' period change,
 * so the visible rows sum to the filtered total return. Reacts to the same
 * visibility / group filters as the chart (the parent re-requests; hidden rows
 * simply drop out of `contributions`).
 *
 * When no row can state that period share (`contributionPct` null — a paranoid
 * account derives its holdings client-side and has no per-asset history), the
 * column is dropped with one line of explanation. It is never filled with a
 * different quantity under the same header.
 *
 * Phone-friendly: the table scrolls horizontally rather than clipping (§7.4).
 */
export function ContributionTable({
  rows,
  baseCurrency,
}: {
  rows: readonly AnalyticsContributionRow[];
  baseCurrency: string;
}) {
  const t = useT();

  if (rows.length === 0) {
    return (
      <p className="bt-analytics-contribution-empty bt-muted">
        {t('portfolio.analytics.contribution.empty')}
      </p>
    );
  }

  const showContribution = rows.some((row) => row.contributionPct !== null);

  return (
    <div className="bt-phone-scroll-table bt-analytics-contribution-table">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t('portfolio.analytics.contribution.caption')}</caption>
        <thead>
          <tr className="bt-label text-left" style={{ borderBottom: '1px solid var(--bt-border)' }}>
            <th scope="col" className="bt-phone-scroll-table__lead py-2 pr-3 font-medium">
              {t('portfolio.analytics.contribution.asset')}
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              {t('portfolio.analytics.contribution.value')}
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              {t('portfolio.analytics.contribution.cost')}
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              {t('portfolio.analytics.contribution.pnl')}
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              {t('portfolio.analytics.contribution.weight')}
            </th>
            {showContribution ? (
              <th scope="col" className="py-2 text-right font-medium">
                {t('portfolio.analytics.contribution.contribution')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.asset.id} className="bt-analytics-contribution-row">
              <td
                className="bt-phone-scroll-table__lead bt-analytics-contribution-asset py-2 pr-3"
                data-label={t('portfolio.analytics.contribution.asset')}
              >
                <span className="bt-row-title">{row.asset.symbol}</span>
                <span className="bt-row-sub ml-2 truncate">{row.asset.name}</span>
              </td>
              <td
                className="py-2 pr-3 text-right"
                data-label={t('portfolio.analytics.contribution.value')}
              >
                <MoneyText amount={row.value} currency={baseCurrency} />
              </td>
              <td
                className="py-2 pr-3 text-right"
                data-label={t('portfolio.analytics.contribution.cost')}
              >
                <MoneyText amount={row.cost} currency={baseCurrency} />
              </td>
              <td
                className="bt-analytics-contribution-delta py-2 pr-3 text-right"
                data-label={t('portfolio.analytics.contribution.pnl')}
              >
                <MoneyText amount={row.pnl} currency={baseCurrency} signed />
              </td>
              <td
                className="bt-soft py-2 pr-3 text-right tabular-nums"
                data-label={t('portfolio.analytics.contribution.weight')}
              >
                {formatPercent(row.weight * 100)}
              </td>
              {showContribution ? (
                <td
                  className={
                    row.contributionPct == null
                      ? 'bt-muted py-2 text-right tabular-nums'
                      : `${row.contributionPct > 0 ? 'bt-pos' : row.contributionPct < 0 ? 'bt-neg' : 'bt-soft'} py-2 text-right tabular-nums`
                  }
                  data-label={t('portfolio.analytics.contribution.contribution')}
                >
                  {row.contributionPct === null
                    ? EM_DASH
                    : formatSignedPercent(row.contributionPct)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {showContribution ? null : (
        <p className="bt-muted mt-2 text-xs">
          {t('portfolio.analytics.contribution.periodUnavailable')}
        </p>
      )}
    </div>
  );
}

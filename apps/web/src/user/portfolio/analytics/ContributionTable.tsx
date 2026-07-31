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
      <p className="bt-panel bt-panel--soft bt-muted px-3 py-4 text-sm">
        {t('portfolio.analytics.contribution.empty')}
      </p>
    );
  }

  const showContribution = rows.some((row) => row.contributionPct !== null);

  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <caption className="sr-only">{t('portfolio.analytics.contribution.caption')}</caption>
        <thead>
          <tr className="bt-label text-left" style={{ borderBottom: '1px solid var(--bt-border)' }}>
            <th scope="col" className="py-2 pr-3 font-medium">
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
            <tr key={row.asset.id} className="">
              <td className="py-2 pr-3">
                <span className="bt-row-title">{row.asset.symbol}</span>
                <span className="bt-row-sub ml-2 truncate">{row.asset.name}</span>
              </td>
              <td className="py-2 pr-3 text-right">
                <MoneyText amount={row.value} currency={baseCurrency} />
              </td>
              <td className="py-2 pr-3 text-right">
                <MoneyText amount={row.cost} currency={baseCurrency} />
              </td>
              <td className="py-2 pr-3 text-right">
                <MoneyText amount={row.pnl} currency={baseCurrency} signed />
              </td>
              <td className="bt-soft py-2 pr-3 text-right tabular-nums">
                {formatPercent(row.weight * 100)}
              </td>
              {showContribution ? (
                <td className="bt-soft py-2 text-right tabular-nums">
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

import type { AnalyticsContributionRow } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatPercent, formatSignedPercent } from '../../../lib/format';
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
      <p className="rounded-md bg-neutral-900/60 px-3 py-4 text-sm text-neutral-500">
        {t('portfolio.analytics.contribution.empty')}
      </p>
    );
  }

  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <caption className="sr-only">{t('portfolio.analytics.contribution.caption')}</caption>
        <thead>
          <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
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
            <th scope="col" className="py-2 text-right font-medium">
              {t('portfolio.analytics.contribution.contribution')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.asset.id} className="border-b border-neutral-900">
              <td className="py-2 pr-3">
                <span className="font-mono text-neutral-100">{row.asset.symbol}</span>
                <span className="ml-2 truncate text-xs text-neutral-500">{row.asset.name}</span>
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
              <td className="py-2 pr-3 text-right tabular-nums text-neutral-300">
                {formatPercent(row.weight * 100)}
              </td>
              <td className="py-2 text-right tabular-nums text-neutral-300">
                {formatSignedPercent(row.contributionPct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

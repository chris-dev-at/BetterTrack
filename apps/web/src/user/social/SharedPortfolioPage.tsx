import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type { Holding, PortfolioTotals } from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../i18n';
import { getSharedPortfolio } from '../../lib/socialApi';
import { cx } from '../../lib/cx';
import { formatQuantity, formatSignedPercent } from '../../lib/format';
import { EmptyState, MoneyText, Skeleton, StatCard } from '../../ui';
import { AllocationDonut, PriceChart } from '../../ui/charts';
import { ItemFollowButton } from './ItemFollowButton';
import type { AllocationSegment } from '../../ui/charts';
import { Alert } from '../components/ui';

/** Mirrors `assetTypeLabels` on the owner's overview, so group names match. */
function assetTypeLabels(t: TranslateFn): Record<string, string> {
  return {
    stock: t('portfolio.overview.assetType.stock'),
    etf: t('portfolio.overview.assetType.etf'),
    index: t('portfolio.overview.assetType.index'),
    fx: t('portfolio.overview.assetType.fx'),
    commodity: t('portfolio.overview.assetType.commodity'),
    crypto: t('portfolio.overview.assetType.crypto'),
    cash_like: t('portfolio.overview.assetType.cashLike'),
    other: t('portfolio.overview.assetType.other'),
  };
}

function DeltaPct({ value }: { value: number | null }) {
  const cls =
    value == null
      ? 'text-neutral-400'
      : value > 0
        ? 'text-emerald-400'
        : value < 0
          ? 'text-red-400'
          : 'text-neutral-400';
  return <span className={cx('tabular-nums', cls)}>{formatSignedPercent(value)}</span>;
}

function TotalsHeader({ totals }: { totals: PortfolioTotals }) {
  const t = useT();
  return (
    <section
      aria-label={t('social.shared.totalsAria')}
      className="grid grid-cols-2 gap-3 sm:grid-cols-4"
    >
      <StatCard
        label={t('portfolio.overview.field.marketValue')}
        value={<MoneyText amount={totals.marketValueEur} />}
      />
      <StatCard
        label={t('portfolio.overview.field.invested')}
        value={<MoneyText amount={totals.investedEur} />}
      />
      <StatCard
        label={t('portfolio.overview.field.unrealizedPnl')}
        value={<MoneyText amount={totals.unrealizedPnlEur} signed />}
        subValue={<DeltaPct value={totals.unrealizedPnlPct} />}
      />
      <StatCard
        label={t('portfolio.overview.field.dayChange')}
        value={<MoneyText amount={totals.dayChangeEur} signed />}
        subValue={<DeltaPct value={totals.dayChangePct} />}
      />
    </section>
  );
}

function AllocationSection({ holdings }: { holdings: Holding[] }) {
  const t = useT();
  const byAsset: AllocationSegment[] = holdings
    .filter((h) => h.marketValueEur != null && h.marketValueEur > 0)
    .map((h) => ({ label: h.asset.symbol, value: h.marketValueEur! }));

  // Group by the catalog category when present (V3-P2): a custom "stock" merges
  // into the market Stocks group, so there is no separate "Custom" slice — market
  // assets carry no category and fall back to their asset type.
  const byTypeMap = new Map<string, number>();
  for (const h of holdings) {
    if (h.marketValueEur == null || h.marketValueEur <= 0) continue;
    const key = h.asset.category ?? h.asset.type;
    byTypeMap.set(key, (byTypeMap.get(key) ?? 0) + h.marketValueEur);
  }
  const typeLabels = assetTypeLabels(t);
  const byType: AllocationSegment[] = [...byTypeMap].map(([type, value]) => ({
    label: typeLabels[type] ?? type,
    value,
  }));

  if (byAsset.length === 0) return null;

  return (
    <section aria-label={t('social.shared.allocationAria')} className="grid gap-6 sm:grid-cols-2">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <h3 className="mb-4 text-sm font-semibold text-neutral-200">
          {t('portfolio.overview.allocation.byAssetTitle')}
        </h3>
        <AllocationDonut data={byAsset} title={t('portfolio.overview.allocation.byAssetChartTitle')} />
      </div>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <h3 className="mb-4 text-sm font-semibold text-neutral-200">
          {t('portfolio.overview.allocation.byTypeTitle')}
        </h3>
        <AllocationDonut data={byType} title={t('portfolio.overview.allocation.byTypeChartTitle')} />
      </div>
    </section>
  );
}

/**
 * Read-only holdings table for a friend-shared portfolio (PROJECTPLAN.md
 * §6.9 point 4) — no expand-to-transactions, no record/edit/delete buttons.
 */
function HoldingsTable({ holdings }: { holdings: Holding[] }) {
  const t = useT();
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="px-3 py-2">
              {t('portfolio.overview.field.asset')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('portfolio.overview.field.qty')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('portfolio.overview.field.price')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('portfolio.overview.field.marketValue')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('portfolio.overview.field.unrealizedPnl')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('portfolio.overview.field.day')}
            </th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.asset.id} className="border-b border-neutral-800 last:border-b-0">
              <td className="min-w-0 px-3 py-2">
                <Link
                  to={`/assets/${h.asset.id}`}
                  className="font-mono text-sm font-medium text-neutral-100 hover:text-sky-400"
                >
                  {h.asset.symbol}
                </Link>
                <p className="max-w-[10rem] truncate text-xs text-neutral-500" title={h.asset.name}>
                  {h.asset.name}
                </p>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(h.quantity)}</td>
              <td className="px-3 py-2 text-right">
                <MoneyText amount={h.price} currency={h.asset.currency} unitPrice />
              </td>
              <td className="px-3 py-2 text-right">
                <MoneyText amount={h.marketValueEur} />
              </td>
              <td className="px-3 py-2 text-right">
                <MoneyText amount={h.unrealizedPnlEur} signed />
                <div>
                  <DeltaPct value={h.unrealizedPnlPct} />
                </div>
              </td>
              <td className="px-3 py-2 text-right">
                <MoneyText amount={h.dayChangeEur} signed />
                <div>
                  <DeltaPct value={h.dayChangePct} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Read-only overview of one friend-shared portfolio (PROJECTPLAN.md §6.9 point
 * 4): totals, performance chart, holdings — mirroring the owner's own overview
 * blocks. There is no transaction ledger and zero edit/add/delete affordances.
 */
export function SharedPortfolioPage() {
  const t = useT();
  const { portfolioId } = useParams<{ portfolioId: string }>();

  const query = useQuery({
    queryKey: ['social', 'shared', portfolioId],
    queryFn: ({ signal }) => getSharedPortfolio(portfolioId!, signal),
    enabled: portfolioId != null,
  });

  const chartPoints = useMemo(
    () =>
      (query.data?.history.points ?? []).map((p) => ({
        time: p.date as Time,
        value: p.valueEur,
      })),
    [query.data],
  );

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-48" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Skeleton height="h-20" />
          <Skeleton height="h-20" />
          <Skeleton height="h-20" />
          <Skeleton height="h-20" />
        </div>
        <Skeleton height="h-80" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Alert tone="error">{t('social.shared.portfolioLoadError')}</Alert>
    );
  }

  const { name, owner, totals, holdings } = query.data;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link
          to="/social/friends"
          className="text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {t('social.shared.backToFriends')}
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">{name}</h1>
          <ItemFollowButton
            kind="portfolio"
            subjectId={query.data.portfolioId}
            ownerId={owner.id}
          />
        </div>
        <p className="mt-1 text-sm text-neutral-400">
          {t('social.shared.sharedBy', { username: owner.username })} · {t('social.shared.readOnly')}
        </p>
      </div>

      {holdings.length === 0 ? (
        <EmptyState
          title={t('social.shared.portfolioEmptyTitle')}
          description={t('social.shared.portfolioEmptyDescription', { username: owner.username })}
        />
      ) : (
        <>
          <TotalsHeader totals={totals} />

          <section
            aria-label={t('portfolio.overview.chart.heading')}
            className="flex flex-col gap-3"
          >
            <h2 className="text-lg font-semibold text-neutral-200">
              {t('portfolio.overview.chart.heading')}
            </h2>
            <PriceChart
              series={chartPoints}
              mode="area"
              showRangeToggle={false}
              ariaLabel={t('social.shared.portfolioChartAria')}
            />
          </section>

          <AllocationSection holdings={holdings} />

          <section
            aria-label={t('portfolio.overview.holdingsAriaLabel')}
            className="flex flex-col gap-3"
          >
            <h2 className="text-lg font-semibold text-neutral-200">
              {t('portfolio.overview.holdingsHeading')}
            </h2>
            <HoldingsTable holdings={holdings} />
          </section>
        </>
      )}
    </div>
  );
}

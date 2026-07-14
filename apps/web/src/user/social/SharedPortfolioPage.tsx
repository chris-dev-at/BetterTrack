import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type { Holding, PortfolioTotals } from '@bettertrack/contracts';

import { getSharedPortfolio } from '../../lib/socialApi';
import { cx } from '../../lib/cx';
import { formatQuantity, formatSignedPercent } from '../../lib/format';
import { EmptyState, MoneyText, Skeleton, StatCard } from '../../ui';
import { AllocationDonut, PriceChart } from '../../ui/charts';
import { ItemFollowButton } from './ItemFollowButton';
import type { AllocationSegment } from '../../ui/charts';
import { Alert } from '../components/ui';

const TYPE_LABELS: Record<string, string> = {
  stock: 'Stocks',
  etf: 'ETFs',
  index: 'Indices',
  fx: 'FX',
  commodity: 'Commodities',
  crypto: 'Crypto',
  cash_like: 'Cash-like',
  other: 'Other',
};

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
  return (
    <section aria-label="Portfolio totals" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Market value" value={<MoneyText amount={totals.marketValueEur} />} />
      <StatCard label="Invested" value={<MoneyText amount={totals.investedEur} />} />
      <StatCard
        label="Unrealized P/L"
        value={<MoneyText amount={totals.unrealizedPnlEur} signed />}
        subValue={<DeltaPct value={totals.unrealizedPnlPct} />}
      />
      <StatCard
        label="Day change"
        value={<MoneyText amount={totals.dayChangeEur} signed />}
        subValue={<DeltaPct value={totals.dayChangePct} />}
      />
    </section>
  );
}

function AllocationSection({ holdings }: { holdings: Holding[] }) {
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
  const byType: AllocationSegment[] = [...byTypeMap].map(([type, value]) => ({
    label: TYPE_LABELS[type] ?? type,
    value,
  }));

  if (byAsset.length === 0) return null;

  return (
    <section aria-label="Allocation" className="grid gap-6 sm:grid-cols-2">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <h3 className="mb-4 text-sm font-semibold text-neutral-200">By asset</h3>
        <AllocationDonut data={byAsset} title="Allocation by asset" />
      </div>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <h3 className="mb-4 text-sm font-semibold text-neutral-200">By type</h3>
        <AllocationDonut data={byType} title="Allocation by type" />
      </div>
    </section>
  );
}

/**
 * Read-only holdings table for a friend-shared portfolio (PROJECTPLAN.md
 * §6.9 point 4) — no expand-to-transactions, no record/edit/delete buttons.
 */
function HoldingsTable({ holdings }: { holdings: Holding[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="px-3 py-2">
              Asset
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Qty
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Price
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Market value
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Unrealized P/L
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Day
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
      <Alert tone="error">Could not load this shared portfolio. Please refresh the page.</Alert>
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
          ← Friends
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">{name}</h1>
          <ItemFollowButton
            kind="portfolio"
            subjectId={query.data.portfolioId}
            ownerId={owner.id}
          />
        </div>
        <p className="mt-1 text-sm text-neutral-400">Shared by {owner.username} · read-only</p>
      </div>

      {holdings.length === 0 ? (
        <EmptyState
          title="Nothing to show yet"
          description={`${owner.username} hasn't recorded any holdings in this portfolio.`}
        />
      ) : (
        <>
          <TotalsHeader totals={totals} />

          <section aria-label="Value over time" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-neutral-200">Value over time</h2>
            <PriceChart
              series={chartPoints}
              mode="area"
              showRangeToggle={false}
              ariaLabel="Shared portfolio value over time"
            />
          </section>

          <AllocationSection holdings={holdings} />

          <section aria-label="Holdings" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-neutral-200">Holdings</h2>
            <HoldingsTable holdings={holdings} />
          </section>
        </>
      )}
    </div>
  );
}

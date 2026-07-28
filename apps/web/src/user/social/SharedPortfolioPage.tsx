import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type { Holding, PortfolioTotals } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { assetTypeLabels } from '../portfolio/assetTypeLabels';
import { getSharedPortfolio } from '../../lib/socialApi';
import { cx } from '../../lib/cx';
import { formatQuantity, formatSignedPercent } from '../../lib/format';
import { EmptyState, MoneyText, Skeleton } from '../../ui';
import { PageHead, Stat, StatStrip } from '../../ui/origin';
import { AllocationDonut, PriceChart } from '../../ui/charts';
import { CommentThread } from './CommentThread';
import { ItemFollowButton } from './ItemFollowButton';
import type { AllocationSegment } from '../../ui/charts';
import { Alert } from '../components/ui';

function DeltaPct({ value }: { value: number | null }) {
  const cls = value == null ? 'bt-muted' : value > 0 ? 'bt-pos' : value < 0 ? 'bt-neg' : 'bt-muted';
  return <span className={cx('bt-num', cls)}>{formatSignedPercent(value)}</span>;
}

/** Ruled stat strip sharing one baseline — the read-only twin of the owner's own. */
function TotalsHeader({ totals }: { totals: PortfolioTotals }) {
  const t = useT();
  return (
    <section aria-label={t('portfolio.overview.totalsAriaLabel')}>
      <StatStrip>
        <Stat
          label={t('portfolio.overview.field.marketValue')}
          value={<MoneyText amount={totals.marketValueEur} />}
        />
        <Stat
          label={t('portfolio.overview.field.invested')}
          value={<MoneyText amount={totals.investedEur} />}
        />
        <Stat
          delta={<DeltaPct value={totals.unrealizedPnlPct} />}
          label={t('portfolio.overview.field.unrealizedPnl')}
          value={<MoneyText amount={totals.unrealizedPnlEur} signed />}
        />
        <Stat
          delta={<DeltaPct value={totals.dayChangePct} />}
          label={t('portfolio.overview.field.dayChange')}
          value={<MoneyText amount={totals.dayChangeEur} signed />}
        />
      </StatStrip>
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
    <section aria-label={t('portfolio.overview.allocationAriaLabel')} className="bt-section">
      <div
        style={{
          display: 'grid',
          gap: 'clamp(20px, 4vw, 44px)',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        }}
      >
        <div>
          <h3 className="bt-h3" style={{ marginBottom: 14 }}>
            {t('portfolio.overview.allocation.byAssetTitle')}
          </h3>
          <AllocationDonut
            data={byAsset}
            title={t('portfolio.overview.allocation.byAssetChartTitle')}
          />
        </div>
        <div>
          <h3 className="bt-h3" style={{ marginBottom: 14 }}>
            {t('portfolio.overview.allocation.byTypeTitle')}
          </h3>
          <AllocationDonut
            data={byType}
            title={t('portfolio.overview.allocation.byTypeChartTitle')}
          />
        </div>
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
    <div className="bt-table-wrap">
      <table className="bt-table">
        <thead>
          <tr>
            <th scope="col">{t('portfolio.overview.field.asset')}</th>
            <th className="is-num" scope="col">
              {t('portfolio.overview.field.qty')}
            </th>
            <th className="is-num" scope="col">
              {t('portfolio.overview.field.price')}
            </th>
            <th className="is-num" scope="col">
              {t('portfolio.overview.field.marketValue')}
            </th>
            <th className="is-num" scope="col">
              {t('portfolio.overview.field.unrealizedPnl')}
            </th>
            <th className="is-num" scope="col">
              {t('portfolio.overview.field.day')}
            </th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.asset.id}>
              <td className="min-w-0">
                <Link
                  className="bt-row-title"
                  style={{ textDecoration: 'none' }}
                  to={`/assets/${h.asset.id}`}
                >
                  {h.asset.symbol}
                </Link>
                <p className="bt-row-sub max-w-[10rem] truncate" title={h.asset.name}>
                  {h.asset.name}
                </p>
              </td>
              <td className="is-num">{formatQuantity(h.quantity)}</td>
              <td className="is-num">
                <MoneyText amount={h.price} currency={h.asset.currency} unitPrice />
              </td>
              <td className="is-num">
                <MoneyText amount={h.marketValueEur} />
              </td>
              <td className="is-num">
                <MoneyText amount={h.unrealizedPnlEur} signed />
                <div className="bt-meta">
                  <DeltaPct value={h.unrealizedPnlPct} />
                </div>
              </td>
              <td className="is-num">
                <MoneyText amount={h.dayChangeEur} signed />
                <div className="bt-meta">
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
        {/* One band, not four boxes — the totals now render as a ruled stat strip. */}
        <Skeleton height="h-20" />
        <Skeleton height="h-80" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <Alert tone="error">{t('social.shared.portfolioLoadError')}</Alert>;
  }

  const { name, owner, totals, holdings } = query.data;

  return (
    <div className="flex flex-col">
      <Link
        to="/social/friends"
        className="bt-link self-start"
        style={{ fontSize: 12.5, marginBottom: 10 }}
      >
        {t('social.shared.backToFriends')}
      </Link>
      <PageHead
        actions={
          <ItemFollowButton
            kind="portfolio"
            subjectId={query.data.portfolioId}
            ownerId={owner.id}
          />
        }
        sub={t('social.shared.sharedByReadOnly', { username: owner.username })}
        title={name}
      />

      {holdings.length === 0 ? (
        <EmptyState
          title={t('social.shared.portfolioEmptyTitle')}
          description={t('social.shared.portfolioEmptyDescription', { username: owner.username })}
        />
      ) : (
        <>
          <TotalsHeader totals={totals} />

          <section aria-label={t('portfolio.overview.chart.heading')} className="bt-section">
            <div className="bt-section__head">
              <h2 className="bt-h2">{t('portfolio.overview.chart.heading')}</h2>
            </div>
            <div className="bt-chart">
              <PriceChart
                series={chartPoints}
                mode="area"
                showRangeToggle={false}
                ariaLabel={t('social.shared.portfolioChartAria')}
              />
            </div>
          </section>

          <AllocationSection holdings={holdings} />

          <section aria-label={t('portfolio.overview.holdingsAriaLabel')} className="bt-section">
            <div className="bt-section__head">
              <h2 className="bt-h2">{t('portfolio.overview.holdingsHeading')}</h2>
            </div>
            <HoldingsTable holdings={holdings} />
          </section>
        </>
      )}

      <div className="bt-section">
        <CommentThread kind="portfolio" subjectId={query.data.portfolioId} />
      </div>
    </div>
  );
}

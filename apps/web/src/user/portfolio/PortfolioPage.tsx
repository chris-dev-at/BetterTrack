import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type {
  DividendProjectionBasis,
  Holding,
  PortfolioHistoryRange,
  PortfolioTotals,
  Transaction,
} from '@bettertrack/contracts';

import { dismissRecategorization, getRecategorizationStatus } from '../../lib/portfolioApi';
import {
  PORTFOLIO_DIVIDEND_CALENDAR_QUERY_KEY,
  PORTFOLIO_DIVIDEND_PROJECTION_QUERY_KEY,
  getPortfolioDividendCalendar,
  getPortfolioDividendProjection,
} from '../../lib/marketIntelApi';
import { type TranslateFn, useT } from '../../i18n';
import { ApiError, classifyApiError } from '../../lib/apiClient';
import { cx } from '../../lib/cx';
import { useDeployCapability } from '../../lib/featureFlags';
import { assetTypeLabels } from './assetTypeLabels';
import { resolveActivePortfolio } from './PortfolioSwitcher';
import { useCreateIntent } from '../components/useCreateIntent';
import { ACTIVE_PORTFOLIO_PARAM, CREATE_INTENT } from '../routeParams';
import { upcomingDividendDate, utcDay } from '../../lib/dividendDates';
import {
  EM_DASH,
  formatDate,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedPercent,
} from '../../lib/format';
import { EmptyState, MoneyText } from '../../ui';
import { Badge, Button, PageHead, Seg, SkeletonBlock, Stat, StatStrip } from '../../ui/origin';
import { AllocationDonut, PriceChart, useChartDisplayMode } from '../../ui/charts';
import { MAIN_SERIES, POSITIVE } from '../../ui/charts/palette';
import type { AllocationSegment, PriceRange } from '../../ui/charts';
import { Alert } from '../components/ui';
import { AsyncReadState } from '../components/AsyncReadState';
import { TransactionDialog, type TransactionDialogAsset } from '../components/TransactionDialog';
import { SourceBadge, sourceTagLabel } from './SourceBadge';
import { CashDialog } from './CashDialog';
import { isVaultedPortfolio, portfolioDisplayName } from './lockedPortfolio';
import {
  usePortfolioStore,
  usePortfolioStoreCapabilities,
  usePortfolioStoreScope,
} from './PortfolioStoreProvider';
import { NormalModeOnly } from '../vault/ui/ParanoidSurfaceGate';
import { useUnlockedPortfolioNames } from '../vault/useUnlockedPortfolioNames';
import { usePhoneShell } from '../hooks/useCompactShell';
import { ValuePointEditor, type ValuePointEditorAsset } from './ValuePointEditor';
import { CustomInvestmentDialog } from './CustomInvestmentDialog';
import {
  MemberSheet,
  MirrorAttributionChip,
  MirrorAvatarStack,
  MirrorForkProvenanceLine,
} from './MirrorchainPanel';

// ─── Range mapping ──────────────────────────────────────────────────────────

/**
 * The value-over-time chart offers this set (PROJECTPLAN.md §6.9 + §13.4
 * V4-P0): day-, week-, month- and multi-year windows over the same daily
 * series. A portfolio younger than the selected range degrades to whatever
 * exists — see {@link PortfolioHistoryRange}. 3M is intentionally omitted
 * (it does not map to a contract range and the picker prefers a smaller set).
 */
const PORTFOLIO_RANGES: readonly PriceRange[] = ['1D', '1W', '1M', '6M', '1Y', '5Y', 'Max'];

/** The chart's `PriceRange` tokens use 'Max'; the contract uses 'MAX'. */
function toHistoryRange(r: PriceRange): PortfolioHistoryRange {
  return r === 'Max' ? 'MAX' : (r as PortfolioHistoryRange);
}

/** §6.9 caches the series 1 h; mirror that as the client staleTime. */
const HISTORY_STALE_MS = 3_600_000;

/**
 * The chart key for a history point. #556: 1D/1W points carry an intraday
 * `time` — key on the exact instant so the dense curve plots, versus the
 * business-day string the daily ranges use. Shared by the value and
 * performance forms so both are keyed identically and stay scrub-alignable.
 */
function historyTime(point: { date: string; time?: string }): Time {
  return point.time !== undefined
    ? (Math.floor(Date.parse(point.time) / 1000) as Time)
    : (point.date as Time);
}

// ─── Totals hero ────────────────────────────────────────────────────────────

function DeltaPct({ value }: { value: number | null }) {
  const cls = value == null ? 'bt-muted' : value > 0 ? 'bt-pos' : value < 0 ? 'bt-neg' : 'bt-muted';
  return <span className={cx('bt-num', cls)}>{formatSignedPercent(value)}</span>;
}

/**
 * Compact liquidity ring (V3-P0 redesign, #322): invested share (analytical
 * blue) vs. its liquid complement (jade), drawn as two arcs of a single ring.
 * Decorative shape; the accessible description carries both percentages.
 */
function LiquidityRing({ investedPct, cashPct }: { investedPct: number; cashPct: number }) {
  const t = useT();
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const investedLen = (investedPct / 100) * circumference;

  return (
    <div
      className="flex items-center gap-3"
      aria-label={t('portfolio.overview.liquidityRing.ariaLabel')}
    >
      <svg
        viewBox="0 0 64 64"
        className="h-16 w-16 shrink-0 -rotate-90"
        role="img"
        aria-label={t('portfolio.overview.liquidityRing.summary', {
          invested: formatPercent(investedPct),
          liquid: formatPercent(cashPct),
        })}
      >
        {/* Track under the two arcs, so any rounding gap reads as neutral. */}
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          stroke="var(--bt-surface-strong)"
          strokeWidth="8"
        />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          strokeWidth="8"
          stroke={MAIN_SERIES}
          strokeDasharray={`${investedLen} ${circumference}`}
        />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          strokeWidth="8"
          stroke={POSITIVE}
          strokeDasharray={`${circumference - investedLen} ${circumference}`}
          strokeDashoffset={-investedLen}
        />
      </svg>
      <div className="bt-meta" aria-hidden="true">
        <div className="flex items-center gap-1.5">
          <span className="bt-dot" style={{ background: MAIN_SERIES }} />
          <span>
            <span className="bt-soft font-medium">{formatPercent(investedPct)}</span>{' '}
            {t('portfolio.overview.liquidityRing.investedLegend')}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="bt-dot" style={{ background: POSITIVE }} />
          <span>
            <span className="bt-soft font-medium">{formatPercent(cashPct)}</span>{' '}
            {t('portfolio.overview.liquidityRing.liquidLegend')}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Totals hero (#311, Origin recomposition): the net-worth headline leads the
 * canvas — no box — with the invested/cash composition, the liquidity ring and
 * a ruled stat strip sharing one baseline underneath.
 */
function TotalsHeader({
  totals,
  onDeposit,
  onWithdraw,
}: {
  totals: PortfolioTotals;
  onDeposit: () => void;
  onWithdraw: () => void;
}) {
  const t = useT();
  // Cash moves are writes; see PageHeader for why they leave rather than grey out.
  const { writes } = usePortfolioStoreCapabilities();
  const investedPct =
    totals.totalValueEur > 0
      ? Math.min(100, Math.max(0, (totals.marketValueEur / totals.totalValueEur) * 100))
      : null;
  const cashPct = investedPct == null ? null : 100 - investedPct;

  return (
    <section aria-label={t('portfolio.overview.totalsAriaLabel')} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <p className="bt-label">{t('portfolio.overview.netWorth.label')}</p>
          <p className="bt-hero-value" style={{ marginTop: 4 }}>
            <MoneyText amount={totals.totalValueEur} />
          </p>
          <p className="bt-meta" style={{ marginTop: 5 }}>
            <MoneyText amount={totals.marketValueEur} />{' '}
            {t('portfolio.overview.netWorth.investedWord')} &middot;{' '}
            <MoneyText amount={totals.cashEur} /> {t('portfolio.overview.netWorth.cashWord')}
          </p>
        </div>
        {investedPct != null && cashPct != null ? (
          <LiquidityRing investedPct={investedPct} cashPct={cashPct} />
        ) : null}
      </div>
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
        <Stat
          delta={
            writes ? (
              <span className="flex gap-2">
                <button className="bt-link" onClick={onDeposit} type="button">
                  {t('portfolio.overview.depositButton')}
                </button>
                <button className="bt-link" onClick={onWithdraw} type="button">
                  {t('portfolio.overview.withdrawButton')}
                </button>
              </span>
            ) : undefined
          }
          label={t('portfolio.overview.field.cash')}
          value={<MoneyText amount={totals.cashEur} />}
        />
      </StatStrip>
    </section>
  );
}

// ─── Allocation ─────────────────────────────────────────────────────────────

function AllocationSection({ holdings, cashEur }: { holdings: Holding[]; cashEur: number }) {
  const t = useT();
  const typeLabels = assetTypeLabels(t);
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
    label: typeLabels[type] ?? type,
    value,
  }));

  // Cash is part of the portfolio's worth (#311) — the composition view gets
  // a cash slice in both donuts so the shares describe the headline total.
  if (cashEur > 0) {
    byAsset.push({ label: t('portfolio.overview.field.cash'), value: cashEur });
    byType.push({ label: t('portfolio.overview.field.cash'), value: cashEur });
  }

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

// ─── Top winners / losers ───────────────────────────────────────────────────

type RankMetric = 'day' | 'total';

interface RankedHolding {
  holding: Holding;
  pct: number;
  deltaEur: number | null;
}

const WINNERS_LOSERS_LIMIT = 5;

function rankHoldings(holdings: Holding[], metric: RankMetric): RankedHolding[] {
  const ranked: RankedHolding[] = [];
  for (const holding of holdings) {
    const pct = metric === 'day' ? holding.dayChangePct : holding.unrealizedPnlPct;
    if (pct == null) continue;
    const deltaEur = metric === 'day' ? holding.dayChangeEur : holding.unrealizedPnlEur;
    ranked.push({ holding, pct, deltaEur });
  }
  return ranked;
}

function RankedHoldingRow({ holding, pct, deltaEur }: RankedHolding) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <Link
          className="bt-row-title bt-link"
          style={{ color: 'inherit' }}
          to={`/assets/${holding.asset.id}`}
        >
          {holding.asset.symbol}
        </Link>
        <p className="bt-row-sub max-w-[12rem] truncate" title={holding.asset.name}>
          {holding.asset.name}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <DeltaPct value={pct} />
        {deltaEur != null ? (
          <span className="bt-meta">
            <MoneyText amount={deltaEur} signed />
          </span>
        ) : null}
      </div>
    </li>
  );
}

function RankedList({ title, items }: { title: string; items: RankedHolding[] }) {
  const t = useT();
  return (
    <div>
      <h3 className="bt-h3" style={{ marginBottom: 6 }}>
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="bt-meta" style={{ padding: '10px 0' }}>
          {t('portfolio.overview.winnersLosers.nothingToShow')}
        </p>
      ) : (
        <ul className="bt-band flex flex-col">
          {items.map((item) => (
            <RankedHoldingRow key={item.holding.asset.id} {...item} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** §6.8 top winners / top losers — ranked by day % or total P/L %, toggleable. */
function WinnersLosersSection({ holdings }: { holdings: Holding[] }) {
  const t = useT();
  const [metric, setMetric] = useState<RankMetric>('day');
  const ranked = rankHoldings(holdings, metric);

  if (ranked.length === 0) return null;

  const winners = ranked
    .filter((r) => r.pct > 0)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, WINNERS_LOSERS_LIMIT);
  const losers = ranked
    .filter((r) => r.pct < 0)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, WINNERS_LOSERS_LIMIT);

  return (
    <section aria-label={t('portfolio.overview.winnersLosers.ariaLabel')} className="bt-section">
      <div className="bt-section__head">
        <h2 className="bt-h2">{t('portfolio.overview.winnersLosers.heading')}</h2>
        <Seg
          ariaLabel={t('portfolio.overview.winnersLosers.heading')}
          onChange={setMetric}
          options={[
            { value: 'day', label: t('portfolio.overview.winnersLosers.dayMetric') },
            { value: 'total', label: t('portfolio.overview.winnersLosers.totalMetric') },
          ]}
          value={metric}
        />
      </div>
      <div
        style={{
          display: 'grid',
          gap: 'clamp(20px, 4vw, 44px)',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        }}
      >
        <RankedList title={t('portfolio.overview.winnersLosers.topWinners')} items={winners} />
        <RankedList title={t('portfolio.overview.winnersLosers.topLosers')} items={losers} />
      </div>
    </section>
  );
}

// ─── Recent transactions ────────────────────────────────────────────────────

const RECENT_TRANSACTIONS_LIMIT = 8;
/** A holding fetches its detail ledger only after the row is expanded. */
const HOLDING_TRANSACTIONS_LIMIT = 200;

/** §6.8 recent transactions — flat, newest-first ledger across all holdings. */
function RecentTransactionsSection({
  transactions,
  sourceTags,
  sourceTagsAreSettled,
  sourceFilter,
  onSourceFilterChange,
}: {
  transactions: Transaction[];
  sourceTags: string[];
  sourceTagsAreSettled: boolean;
  sourceFilter: string;
  onSourceFilterChange: (source: string) => void;
}) {
  const t = useT();
  const phone = usePhoneShell();
  // Source-tag filter (V5-P0c + V5-P6b): mirrors the cash-history chip on
  // CashSourcesPage. Only earns its place when the ledger actually mixes
  // sources (anti-bloat — a pure-manual ledger never sees it).
  // A successful deletion can remove the last row for the selected source.
  // Only a settled successful response for this query may clear it:
  // keepPreviousData can temporarily render another portfolio's facet during a
  // route switch, and an invalidated cache can be visible while its refetch is
  // still in flight.
  useEffect(() => {
    if (sourceTagsAreSettled && sourceFilter !== 'all' && !sourceTags.includes(sourceFilter)) {
      onSourceFilterChange('all');
    }
  }, [onSourceFilterChange, sourceFilter, sourceTags, sourceTagsAreSettled]);

  const showFilter = sourceTags.length > 1;

  if (transactions.length === 0 && !showFilter) return null;

  return (
    <section
      aria-label={t('portfolio.overview.recentTransactions.ariaLabel')}
      className="bt-section"
    >
      <div className="bt-section__head">
        <h2 className="bt-h2">{t('portfolio.overview.recentTransactions.heading')}</h2>
        {showFilter ? (
          <label className="bt-meta flex items-center gap-1.5">
            {t('portfolio.sourceTag.filterLabel')}
            <select
              className="bt-select"
              onChange={(e) => onSourceFilterChange(e.target.value)}
              style={{ minHeight: 28, padding: '2px 26px 2px 8px', width: 'auto', fontSize: 12 }}
              value={sourceFilter}
            >
              <option value="all">{t('portfolio.sourceTag.filterAll')}</option>
              {sourceTags.map((tag) => (
                <option key={tag} value={tag}>
                  {sourceTagLabel(t, tag) ?? t('portfolio.sourceTag.manual')}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {transactions.length === 0 ? (
        <p className="bt-meta" style={{ padding: '10px 0' }}>
          {t('portfolio.overview.recentTransactions.empty')}
        </p>
      ) : phone ? (
        <ul className="bt-phone-card-list">
          {transactions.map((transaction) => (
            <li className="bt-phone-card" key={transaction.id}>
              <div className="bt-phone-card__head">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Link
                    className="bt-row-title"
                    style={{ textDecoration: 'none' }}
                    to={`/assets/${transaction.assetId}`}
                  >
                    {transaction.asset.symbol}
                  </Link>
                  <SourceBadge source={transaction.source} />
                  {transaction.mirror ? (
                    <MirrorAttributionChip attribution={transaction.mirror.addedBy} />
                  ) : null}
                </div>
                <Badge tone={transaction.side === 'buy' ? 'pos' : 'gold'}>
                  {transaction.side === 'buy'
                    ? t('portfolio.overview.side.buy')
                    : t('portfolio.overview.side.sell')}
                </Badge>
              </div>
              <dl className="bt-phone-card__facts">
                <div>
                  <dt>{t('portfolio.overview.field.qty')}</dt>
                  <dd className="bt-num">{formatQuantity(transaction.quantity)}</dd>
                </div>
                <div>
                  <dt>{t('portfolio.overview.field.price')}</dt>
                  <dd className="bt-num">
                    <MoneyText
                      amount={transaction.price}
                      currency={transaction.asset.currency}
                      unitPrice
                    />
                  </dd>
                </div>
                <div>
                  <dt>{t('portfolio.overview.field.date')}</dt>
                  <dd>{formatDate(transaction.executedAt)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <div className="bt-table-wrap">
          <table className="bt-table">
            <thead>
              <tr>
                <th scope="col">{t('portfolio.overview.field.asset')}</th>
                <th scope="col">{t('portfolio.overview.field.side')}</th>
                <th className="is-num" scope="col">
                  {t('portfolio.overview.field.qty')}
                </th>
                <th className="is-num" scope="col">
                  {t('portfolio.overview.field.price')}
                </th>
                <th scope="col">{t('portfolio.overview.field.date')}</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((txn) => (
                <tr key={txn.id}>
                  <td className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link
                        className="bt-row-title"
                        style={{ textDecoration: 'none' }}
                        to={`/assets/${txn.assetId}`}
                      >
                        {txn.asset.symbol}
                      </Link>
                      <SourceBadge source={txn.source} />
                      {/* Who added it, on a mirrored copy (design §2/§11). This is
                        the only surface a replicated trade appears on today —
                        `/portfolio/activity` is still a placeholder and the
                        per-asset rows are collapsed — so without it a member's
                        buy reads as the owner's own. */}
                      {txn.mirror ? (
                        <MirrorAttributionChip attribution={txn.mirror.addedBy} />
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <Badge tone={txn.side === 'buy' ? 'pos' : 'gold'}>
                      {txn.side === 'buy'
                        ? t('portfolio.overview.side.buy')
                        : t('portfolio.overview.side.sell')}
                    </Badge>
                  </td>
                  <td className="is-num">{formatQuantity(txn.quantity)}</td>
                  <td className="is-num">
                    <MoneyText amount={txn.price} currency={txn.asset.currency} unitPrice />
                  </td>
                  <td className="bt-muted">{formatDate(txn.executedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── Holdings table ─────────────────────────────────────────────────────────

interface HoldingsTableProps {
  holdings: Holding[];
  transactionDetailsByAsset: Map<string, HoldingTransactionDetails>;
  expanded: ReadonlySet<string>;
  onToggle: (assetId: string) => void;
  onRecord: (asset: TransactionDialogAsset) => void;
  onEditTxn: (txn: Transaction) => void;
  onDeleteTxn: (txn: Transaction) => void;
  onEditValuePoints: (asset: ValuePointEditorAsset) => void;
  deletingId: string | null;
}

function HoldingsTable({
  holdings,
  transactionDetailsByAsset,
  expanded,
  onToggle,
  onRecord,
  onEditTxn,
  onDeleteTxn,
  onEditValuePoints,
  deletingId,
}: HoldingsTableProps) {
  const t = useT();
  const phone = usePhoneShell();

  if (phone) {
    return (
      <ul aria-label={t('portfolio.overview.holdingsAriaLabel')} className="bt-phone-card-list">
        {holdings.map((holding) => (
          <HoldingCard
            key={holding.asset.id}
            holding={holding}
            transactionDetails={
              transactionDetailsByAsset.get(holding.asset.id) ?? EMPTY_HOLDING_TRANSACTION_DETAILS
            }
            isExpanded={expanded.has(holding.asset.id)}
            onToggle={() => onToggle(holding.asset.id)}
            onRecord={onRecord}
            onEditTxn={onEditTxn}
            onDeleteTxn={onDeleteTxn}
            onEditValuePoints={onEditValuePoints}
            deletingId={deletingId}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="bt-table-wrap">
      <table className="bt-table">
        <thead>
          <tr>
            <th aria-hidden="true" className="is-shrink" scope="col" />
            <th scope="col">{t('portfolio.overview.field.asset')}</th>
            <th className="is-num" scope="col">
              {t('portfolio.overview.field.qty')}
            </th>
            <th className="is-num" scope="col">
              {t('portfolio.overview.field.avgCost')}
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
            <HoldingRow
              key={h.asset.id}
              holding={h}
              transactionDetails={
                transactionDetailsByAsset.get(h.asset.id) ?? EMPTY_HOLDING_TRANSACTION_DETAILS
              }
              isExpanded={expanded.has(h.asset.id)}
              onToggle={() => onToggle(h.asset.id)}
              onRecord={onRecord}
              onEditTxn={onEditTxn}
              onDeleteTxn={onDeleteTxn}
              onEditValuePoints={onEditValuePoints}
              deletingId={deletingId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface HoldingTransactionDetails {
  items: Transaction[];
  isLoading: boolean;
  error: unknown;
  retry: () => void;
}

const EMPTY_HOLDING_TRANSACTION_DETAILS: HoldingTransactionDetails = {
  items: [],
  isLoading: false,
  error: null,
  retry: () => undefined,
};

interface HoldingRowProps {
  holding: Holding;
  transactionDetails: HoldingTransactionDetails;
  isExpanded: boolean;
  onToggle: () => void;
  onRecord: (asset: TransactionDialogAsset) => void;
  onEditTxn: (txn: Transaction) => void;
  onDeleteTxn: (txn: Transaction) => void;
  onEditValuePoints: (asset: ValuePointEditorAsset) => void;
  deletingId: string | null;
}

/** Keeps an on-demand holding read from being mistaken for an empty ledger. */
function HoldingTransactions({
  details,
  children,
}: {
  details: HoldingTransactionDetails;
  children: (transactions: Transaction[]) => ReactNode;
}) {
  const t = useT();

  if (details.isLoading) {
    return (
      <div className="mt-3">
        <SkeletonBlock height={72} />
      </div>
    );
  }
  if (details.error != null) {
    return (
      <div className="mt-3">
        <AsyncReadState
          compact
          error={details.error}
          errorLabel={t('portfolio.overview.detailsLoadError')}
          loading={false}
          onRetry={details.retry}
        />
      </div>
    );
  }
  if (details.items.length === 0) {
    return <p className="bt-meta mt-3">{t('portfolio.overview.holdings.noTransactions')}</p>;
  }
  return <>{children(details.items)}</>;
}

function HoldingCard({
  holding,
  transactionDetails,
  isExpanded,
  onToggle,
  onRecord,
  onEditTxn,
  onDeleteTxn,
  onEditValuePoints,
  deletingId,
}: HoldingRowProps) {
  const t = useT();
  const { writes } = usePortfolioStoreCapabilities();
  const { asset } = holding;
  const dialogAsset: TransactionDialogAsset = {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    currency: asset.currency,
  };

  return (
    <li className="bt-phone-card">
      <div className="bt-phone-card__head">
        <div className="flex min-w-0 items-start gap-2">
          <button
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? t('portfolio.overview.holdings.collapseRow', { symbol: asset.symbol })
                : t('portfolio.overview.holdings.expandRow', { symbol: asset.symbol })
            }
            className="bt-btn bt-btn--quiet bt-btn--sm bt-btn--icon shrink-0"
            data-testid={`holding-transactions-toggle-${asset.id}`}
            onClick={onToggle}
            type="button"
          >
            <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
          </button>
          <div className="min-w-0">
            <Link
              className="bt-row-title"
              style={{ textDecoration: 'none' }}
              to={`/assets/${asset.id}`}
            >
              {asset.symbol}
            </Link>
            <p className="bt-row-sub break-words">{asset.name}</p>
          </div>
        </div>
        <span className="shrink-0 bt-num">
          <MoneyText amount={holding.marketValueEur} />
        </span>
      </div>

      <dl className="bt-phone-card__facts">
        <div>
          <dt>{t('portfolio.overview.field.qty')}</dt>
          <dd className="bt-num">{formatQuantity(holding.quantity)}</dd>
        </div>
        <div>
          <dt>{t('portfolio.overview.field.avgCost')}</dt>
          <dd className="bt-num">
            <MoneyText amount={holding.avgCost} currency={asset.currency} unitPrice />
          </dd>
        </div>
        <div>
          <dt>{t('portfolio.overview.field.price')}</dt>
          <dd className="bt-num">
            <MoneyText amount={holding.price} currency={asset.currency} unitPrice />
          </dd>
        </div>
        <div>
          <dt>{t('portfolio.overview.field.unrealizedPnl')}</dt>
          <dd className="bt-num">
            <MoneyText amount={holding.unrealizedPnlEur} signed />
            {holding.unrealizedPnlPct != null ? (
              <span className="ml-1">
                <DeltaPct value={holding.unrealizedPnlPct} />
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t('portfolio.overview.field.day')}</dt>
          <dd className="bt-num">
            <MoneyText amount={holding.dayChangeEur} signed />
            {holding.dayChangePct != null ? (
              <span className="ml-1">
                <DeltaPct value={holding.dayChangePct} />
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      {isExpanded ? (
        <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--bt-border)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="bt-label">{t('portfolio.overview.holdings.transactionsHeading')}</h4>
            {writes ? (
              <div className="flex flex-wrap gap-2">
                {asset.isCustom ? (
                  <Button
                    onClick={() =>
                      onEditValuePoints({
                        id: asset.id,
                        symbol: asset.symbol,
                        name: asset.name,
                        currency: asset.currency,
                        category: asset.category ?? 'other',
                        smoothing: asset.smoothing ?? false,
                      })
                    }
                    size="sm"
                  >
                    {t('portfolio.overview.holdings.editValuePoints')}
                  </Button>
                ) : null}
                <Button onClick={() => onRecord(dialogAsset)} size="sm">
                  {t('portfolio.overview.recordButton')}
                </Button>
              </div>
            ) : null}
          </div>
          {holding.realizedPnl !== 0 ? (
            <p className="bt-meta mt-3">
              {t('portfolio.overview.holdings.realizedPnlLabel')}{' '}
              <MoneyText amount={holding.realizedPnl} currency={asset.currency} signed />
            </p>
          ) : null}
          <HoldingTransactions details={transactionDetails}>
            {(transactions) => (
              <ul className="mt-3 flex flex-col gap-2">
                {transactions.map((transaction) => (
                  <TransactionCard
                    key={transaction.id}
                    currency={asset.currency}
                    deleting={deletingId === transaction.id}
                    onDelete={() => onDeleteTxn(transaction)}
                    onEdit={() => onEditTxn(transaction)}
                    txn={transaction}
                  />
                ))}
              </ul>
            )}
          </HoldingTransactions>
        </div>
      ) : null}
    </li>
  );
}

function HoldingRow({
  holding: h,
  transactionDetails,
  isExpanded,
  onToggle,
  onRecord,
  onEditTxn,
  onDeleteTxn,
  onEditValuePoints,
  deletingId,
}: HoldingRowProps) {
  const t = useT();
  const { writes } = usePortfolioStoreCapabilities();
  const { asset } = h;
  const dialogAsset: TransactionDialogAsset = {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    currency: asset.currency,
  };

  return (
    <>
      <tr>
        <td className="is-shrink">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? t('portfolio.overview.holdings.collapseRow', { symbol: asset.symbol })
                : t('portfolio.overview.holdings.expandRow', { symbol: asset.symbol })
            }
            className="bt-btn bt-btn--quiet bt-btn--sm bt-btn--icon"
            data-testid={`holding-transactions-toggle-${asset.id}`}
          >
            <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
          </button>
        </td>
        <td className="min-w-0">
          <Link
            className="bt-row-title"
            style={{ textDecoration: 'none' }}
            to={`/assets/${asset.id}`}
          >
            {asset.symbol}
          </Link>
          <p className="bt-row-sub max-w-[14rem] truncate" title={asset.name}>
            {asset.name}
          </p>
        </td>
        <td className="is-num">{formatQuantity(h.quantity)}</td>
        <td className="is-num">
          <MoneyText amount={h.avgCost} currency={asset.currency} unitPrice />
        </td>
        <td className="is-num">
          <MoneyText amount={h.price} currency={asset.currency} unitPrice />
        </td>
        <td className="is-num">
          <MoneyText amount={h.marketValueEur} />
        </td>
        <td className="is-num">
          <div className="flex flex-col items-end">
            <MoneyText amount={h.unrealizedPnlEur} signed />
            {h.unrealizedPnlPct != null ? (
              <span className="bt-meta">
                <DeltaPct value={h.unrealizedPnlPct} />
              </span>
            ) : null}
          </div>
        </td>
        <td className="is-num">
          <div className="flex flex-col items-end">
            <MoneyText amount={h.dayChangeEur} signed />
            {h.dayChangePct != null ? (
              <span className="bt-meta">
                <DeltaPct value={h.dayChangePct} />
              </span>
            ) : null}
          </div>
        </td>
      </tr>

      {isExpanded ? (
        <tr style={{ background: 'var(--bt-bg-raised)' }}>
          <td colSpan={8} style={{ padding: '14px 16px' }}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="bt-label">{t('portfolio.overview.holdings.transactionsHeading')}</h4>
                {writes ? (
                  <div className="flex gap-2">
                    {asset.isCustom ? (
                      <Button
                        onClick={() =>
                          onEditValuePoints({
                            id: asset.id,
                            symbol: asset.symbol,
                            name: asset.name,
                            currency: asset.currency,
                            // Custom holdings always carry a category (V3-P2);
                            // fall back defensively so the editor seeds cleanly.
                            category: asset.category ?? 'other',
                            smoothing: asset.smoothing ?? false,
                          })
                        }
                        size="sm"
                      >
                        {t('portfolio.overview.holdings.editValuePoints')}
                      </Button>
                    ) : null}
                    <Button onClick={() => onRecord(dialogAsset)} size="sm">
                      {t('portfolio.overview.recordButton')}
                    </Button>
                  </div>
                ) : null}
              </div>

              {h.realizedPnl !== 0 ? (
                <p className="bt-meta">
                  {t('portfolio.overview.holdings.realizedPnlLabel')}{' '}
                  <MoneyText amount={h.realizedPnl} currency={asset.currency} signed />
                </p>
              ) : null}

              <HoldingTransactions details={transactionDetails}>
                {(transactions) => (
                  <table className="bt-table" style={{ fontSize: 12.5 }}>
                    <thead>
                      <tr>
                        <th scope="col">{t('portfolio.overview.field.date')}</th>
                        <th scope="col">{t('portfolio.overview.field.side')}</th>
                        <th className="is-num" scope="col">
                          {t('portfolio.overview.field.qty')}
                        </th>
                        <th className="is-num" scope="col">
                          {t('portfolio.overview.field.price')}
                        </th>
                        <th className="is-num" scope="col">
                          {t('portfolio.overview.field.fee')}
                        </th>
                        <th scope="col">{t('portfolio.overview.field.note')}</th>
                        <th
                          aria-label={t('portfolio.overview.holdings.actionsAriaLabel')}
                          className="is-num"
                          scope="col"
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((txn) => (
                        <TransactionRow
                          key={txn.id}
                          txn={txn}
                          currency={asset.currency}
                          onEdit={() => onEditTxn(txn)}
                          onDelete={() => onDeleteTxn(txn)}
                          deleting={deletingId === txn.id}
                        />
                      ))}
                    </tbody>
                  </table>
                )}
              </HoldingTransactions>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function TransactionRow({
  txn,
  currency,
  onEdit,
  onDelete,
  deleting,
}: {
  txn: Transaction;
  currency: string;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const t = useT();
  // Editing and deleting a transaction are writes. They are unreachable today
  // only because the store that refuses writes also refuses the row READ that
  // renders this table — luck, not a guard, and #1532's document-source seam
  // is about to make those rows render.
  const { writes } = usePortfolioStoreCapabilities();
  const [confirming, setConfirming] = useState(false);

  return (
    <tr>
      <td className="bt-soft">{formatDate(txn.executedAt)}</td>
      <td>
        <span className="inline-flex items-center gap-1.5">
          <Badge tone={txn.side === 'buy' ? 'pos' : 'gold'}>
            {txn.side === 'buy'
              ? t('portfolio.overview.side.buy')
              : t('portfolio.overview.side.sell')}
          </Badge>
          <SourceBadge source={txn.source} />
          {txn.mirror ? <MirrorAttributionChip attribution={txn.mirror.addedBy} /> : null}
        </span>
      </td>
      <td className="is-num bt-soft">{formatQuantity(txn.quantity)}</td>
      <td className="is-num bt-soft">
        <MoneyText amount={txn.price} currency={currency} unitPrice />
      </td>
      <td className="is-num bt-soft">
        {txn.fee > 0 ? <MoneyText amount={txn.fee} currency={currency} /> : EM_DASH}
      </td>
      <td className="bt-muted max-w-[10rem] truncate" title={txn.note ?? undefined}>
        {txn.note ?? EM_DASH}
      </td>
      <td className="is-num">
        {!writes ? null : confirming ? (
          <span className="inline-flex items-center gap-1">
            <span className="bt-muted">{t('portfolio.overview.transaction.deleteConfirm')}</span>
            <button
              className="bt-btn bt-btn--danger bt-btn--sm"
              disabled={deleting}
              onClick={onDelete}
              type="button"
            >
              {deleting ? '…' : t('common.yes')}
            </button>
            <button
              className="bt-btn bt-btn--quiet bt-btn--sm"
              disabled={deleting}
              onClick={() => setConfirming(false)}
              type="button"
            >
              {t('common.no')}
            </button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <button
              aria-label={t('portfolio.overview.transaction.editAriaLabel', {
                date: formatDate(txn.executedAt),
              })}
              className="bt-btn bt-btn--quiet bt-btn--sm"
              onClick={onEdit}
              type="button"
            >
              {t('common.edit')}
            </button>
            <button
              aria-label={t('portfolio.overview.transaction.deleteAriaLabel', {
                date: formatDate(txn.executedAt),
              })}
              className="bt-btn bt-btn--quiet bt-btn--sm"
              onClick={() => setConfirming(true)}
              type="button"
            >
              ✕
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

function TransactionCard({
  txn,
  currency,
  onEdit,
  onDelete,
  deleting,
}: {
  txn: Transaction;
  currency: string;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const t = useT();
  // Same guard as TransactionRow: a store that cannot write offers no edit or
  // delete, whatever renders the rows.
  const { writes } = usePortfolioStoreCapabilities();
  const [confirming, setConfirming] = useState(false);

  return (
    <li
      className="rounded-md border p-3"
      style={{ borderColor: 'var(--bt-border)', background: 'var(--bt-bg-raised)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Badge tone={txn.side === 'buy' ? 'pos' : 'gold'}>
            {txn.side === 'buy'
              ? t('portfolio.overview.side.buy')
              : t('portfolio.overview.side.sell')}
          </Badge>
          <SourceBadge source={txn.source} />
          {txn.mirror ? <MirrorAttributionChip attribution={txn.mirror.addedBy} /> : null}
        </span>
        <span className="bt-meta">{formatDate(txn.executedAt)}</span>
      </div>
      <dl className="bt-phone-card__facts">
        <div>
          <dt>{t('portfolio.overview.field.qty')}</dt>
          <dd className="bt-num">{formatQuantity(txn.quantity)}</dd>
        </div>
        <div>
          <dt>{t('portfolio.overview.field.price')}</dt>
          <dd className="bt-num">
            <MoneyText amount={txn.price} currency={currency} unitPrice />
          </dd>
        </div>
        <div>
          <dt>{t('portfolio.overview.field.fee')}</dt>
          <dd className="bt-num">
            {txn.fee > 0 ? <MoneyText amount={txn.fee} currency={currency} /> : EM_DASH}
          </dd>
        </div>
        <div>
          <dt>{t('portfolio.overview.field.note')}</dt>
          <dd>{txn.note ?? EM_DASH}</dd>
        </div>
      </dl>
      <div className="bt-phone-card__actions">
        {!writes ? null : confirming ? (
          <>
            <span className="bt-muted self-center">
              {t('portfolio.overview.transaction.deleteConfirm')}
            </span>
            <button
              className="bt-btn bt-btn--danger bt-btn--sm"
              disabled={deleting}
              onClick={onDelete}
              type="button"
            >
              {deleting ? '…' : t('common.yes')}
            </button>
            <button
              className="bt-btn bt-btn--quiet bt-btn--sm"
              disabled={deleting}
              onClick={() => setConfirming(false)}
              type="button"
            >
              {t('common.no')}
            </button>
          </>
        ) : (
          <>
            <button
              aria-label={t('portfolio.overview.transaction.editAriaLabel', {
                date: formatDate(txn.executedAt),
              })}
              className="bt-btn bt-btn--quiet bt-btn--sm"
              onClick={onEdit}
              type="button"
            >
              {t('common.edit')}
            </button>
            <button
              aria-label={t('portfolio.overview.transaction.deleteAriaLabel', {
                date: formatDate(txn.executedAt),
              })}
              className="bt-btn bt-btn--quiet bt-btn--sm"
              onClick={() => setConfirming(true)}
              type="button"
            >
              ✕
            </button>
          </>
        )}
      </div>
    </li>
  );
}

// ─── Dialog state ─────────────────────────────────────────────────────────────

type TxnDialogState =
  | { kind: 'create'; asset?: TransactionDialogAsset }
  | { kind: 'edit'; transaction: Transaction };

// ─── Re-categorize banner (V3-P2) ─────────────────────────────────────────────

/**
 * One-time re-categorization notice (V3-P2). Migrated custom assets that lost
 * their old category were parked in "Other"; while any still carry the flag the
 * server reports `pending > 0` and we nudge the user to pick a real category.
 * Dismiss clears the flag server-side; re-categorizing an asset does too, so the
 * banner also fades on its own once the status query refetches.
 */
function RecategorizeBanner() {
  const t = useT();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ['custom-assets', 'recategorization'],
    queryFn: ({ signal }) => getRecategorizationStatus(signal),
    staleTime: 60_000,
  });
  const dismissMutation = useMutation({
    mutationFn: () => dismissRecategorization(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['custom-assets', 'recategorization'] }),
  });

  // This is a normally invisible background probe. Keep arrival status
  // available to assistive tech without adding visual noise, and keep
  // confirmed/unknown terminal outcomes silent; only a real outage is
  // actionable enough to interrupt the portfolio surface.
  if (statusQuery.error && classifyApiError(statusQuery.error) !== 'outage') return null;
  if (statusQuery.isLoading || statusQuery.error) {
    return (
      <AsyncReadState
        loading={statusQuery.isLoading}
        error={statusQuery.error}
        errorLabel={t('portfolio.recategorize.loadError')}
        loadingLabel={t('portfolio.recategorize.loading')}
        loadingPresentation="sr-only"
        onRetry={() => void statusQuery.refetch()}
      />
    );
  }

  if (!statusQuery.data || statusQuery.data.pending <= 0) return null;

  return (
    <Alert tone="info">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{t('portfolio.recategorize.message')}</span>
        <Button
          disabled={dismissMutation.isPending}
          onClick={() => dismissMutation.mutate()}
          size="sm"
        >
          {t('portfolio.recategorize.dismiss')}
        </Button>
      </div>
    </Alert>
  );
}

// ─── Dividend intelligence (§13.5 V5-P5, arc a) ─────────────────────────────────

/**
 * Projected dividend income (monthly/yearly EUR) + the upcoming ex/pay calendar
 * across held + watchlist assets.
 *
 * Two different absences (#1681). The deployment's `MARKET_INTEL_ENABLED`
 * capability decides whether this block exists at all: off ⇒ NOTHING renders,
 * so the portfolio page is byte-identical when unconfigured (§6.3 "blocks
 * simply disappear"). With it on, the two reads stand on their own feet: the
 * projection answers all-or-nothing (#1616 — one unresolvable holding makes the
 * whole total `available: false`), and that must not take a calendar that
 * computed perfectly down with it. So an unresolved projection renders the
 * calendar plus a short reason, and an empty calendar still renders the
 * projection. Only when neither has anything to say does the block stay hidden
 * (anti-bloat). Compact: one income line with a monthly/yearly toggle and a
 * calendar truncated to three rows with an expand toggle.
 */
/**
 * The one line naming what a projected dividend total is made of. Null when the
 * projection carries no basis (nothing contributed), because then there is
 * nothing to caveat.
 */
function dividendBasisNote(basis: DividendProjectionBasis | null, t: TranslateFn): string | null {
  switch (basis) {
    case 'trailing-12m':
      return t('portfolio.dividends.basis.trailing12m');
    case 'forward-annualized':
      return t('portfolio.dividends.basis.forwardAnnualized');
    case 'mixed':
      return t('portfolio.dividends.basis.mixed');
    default:
      return null;
  }
}

function DividendIntelSection() {
  const t = useT();
  const [view, setView] = useState<'monthly' | 'yearly'>('monthly');
  const [showAll, setShowAll] = useState(false);
  const marketIntel = useDeployCapability('marketIntel');

  const projection = useQuery({
    queryKey: PORTFOLIO_DIVIDEND_PROJECTION_QUERY_KEY,
    queryFn: ({ signal }) => getPortfolioDividendProjection(signal),
    enabled: marketIntel,
    staleTime: 3_600_000,
  });
  const calendar = useQuery({
    queryKey: PORTFOLIO_DIVIDEND_CALENDAR_QUERY_KEY,
    queryFn: ({ signal }) => getPortfolioDividendCalendar(signal),
    enabled: marketIntel,
    staleTime: 3_600_000,
  });

  // Invisible when unconfigured: no heading, no empty state, no explanation.
  if (!marketIntel) return null;

  const proj = projection.data;
  const entries = calendar.data?.available ? calendar.data.entries : [];
  const hasProjection = proj?.available === true && proj.holdings.length > 0;
  // A definite "could not compute" — distinct from a read still in flight or
  // failed, which says nothing about this portfolio and draws nothing.
  const projectionUnresolved = proj?.available === false;
  // …and distinct again from "the book is past the per-request fan-out budget"
  // (§5.3): the projection refuses BEFORE spending provider budget, so it is
  // unavailable for a reason that has nothing to do with an unresolvable
  // holding and must not borrow that copy.
  const projectionTruncated = proj?.truncated === true;
  // The calendar, unlike the projection, still publishes what it covered — so it
  // says on one line that it covered only part of the book.
  const calendarTruncated = calendar.data?.available === true && calendar.data.truncated === true;
  // Nothing at all to surface → stay hidden (anti-bloat). An unresolved
  // projection is only worth explaining beside a calendar that did resolve.
  if (!hasProjection && entries.length === 0) return null;

  const visibleEntries = showAll ? entries : entries.slice(0, 3);
  // One "today" for the whole list so every row is labelled against the same
  // day boundary the API used when it built and ordered the calendar.
  const calendarToday = utcDay();
  const total = !proj ? 0 : view === 'monthly' ? proj.monthlyTotalBase : proj.yearlyTotalBase;
  const basisNote = hasProjection ? dividendBasisNote(proj.basis, t) : null;

  return (
    <section aria-label={t('portfolio.dividends.ariaLabel')} className="bt-section">
      <div className="bt-section__head">
        <h2 className="bt-h2">{t('portfolio.dividends.title')}</h2>
        {/* The period toggle switches a projected total; without one it would
            control nothing, so a calendar-only block does not carry it. */}
        {hasProjection ? (
          <Seg
            ariaLabel={t('portfolio.dividends.viewGroupLabel')}
            onChange={setView}
            options={[
              { value: 'monthly', label: t('portfolio.dividends.view.monthly') },
              { value: 'yearly', label: t('portfolio.dividends.view.yearly') },
            ]}
            value={view}
          />
        ) : null}
      </div>

      {hasProjection ? (
        <>
          <p className="flex items-baseline gap-2">
            <span className="bt-num" style={{ fontSize: 24, fontWeight: 630 }}>
              {/* The projection declares its own denomination (the caller's base,
                  §5.4) — rendering a hard 'EUR' beside a base-denominated net
                  worth labelled a currency the arithmetic never used. */}
              {formatMoney(total, proj?.currency)}
            </span>
            <span className="bt-meta">
              {view === 'monthly'
                ? t('portfolio.dividends.perMonth')
                : t('portfolio.dividends.perYear')}
            </span>
          </p>
          {/* …and what that number is MADE of. A `trailing-12m` estimate is the
              last twelve months' realized payouts, so a special dividend is in
              it and the figure reads well above true forward income for a year;
              a book can also legitimately mix the two bases. The contract has
              carried the basis since #1741 and no surface rendered it (#1790). */}
          {basisNote ? <p className="bt-meta">{basisNote}</p> : null}
        </>
      ) : projectionTruncated ? (
        <p className="bt-meta">{t('portfolio.dividends.projectionTruncated')}</p>
      ) : projectionUnresolved ? (
        <p className="bt-meta">{t('portfolio.dividends.projectionUnresolved')}</p>
      ) : null}

      {entries.length > 0 ? (
        <div className="flex flex-col gap-1.5" style={{ marginTop: 12 }}>
          <h3 className="bt-label">{t('portfolio.dividends.calendarTitle')}</h3>
          {calendarTruncated ? (
            <p className="bt-meta">{t('portfolio.dividends.calendarTruncated')}</p>
          ) : null}
          <ul className="bt-band flex flex-col">
            {visibleEntries.map((entry) => {
              // The date this event is still upcoming on — the earliest of its
              // ex/pay dates that has not passed, which is also the date the API
              // ordered the list on. An event already gone ex but not yet paid
              // shows its PAY date: printing the ex-date behind us under
              // "upcoming" was #1758, and "ex —" for a pay-only row was #1681.
              const upcoming = upcomingDividendDate(entry, calendarToday);
              const isEx = upcoming?.isEx ?? false;
              const date = upcoming?.iso ?? null;
              return (
                <li
                  key={`${entry.assetId}:${entry.exDate ?? entry.payDate ?? ''}`}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <Link
                    className="bt-row-title"
                    style={{ textDecoration: 'none' }}
                    title={entry.name}
                    to={`/assets/${entry.assetId}`}
                  >
                    {entry.symbol}
                  </Link>
                  <span className="bt-meta flex items-center gap-2">
                    {entry.amount != null ? (
                      <span className="bt-soft bt-num">
                        {formatMoney(entry.amount, entry.currency ?? undefined)}
                      </span>
                    ) : null}
                    {date !== null ? (
                      <span>
                        {t(isEx ? 'portfolio.dividends.exOn' : 'portfolio.dividends.payOn', {
                          date: formatDate(date),
                        })}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {entries.length > 3 ? (
            <button
              className="bt-link self-start"
              onClick={() => setShowAll((v) => !v)}
              style={{
                fontSize: 12.5,
                background: 'none',
                border: 0,
                cursor: 'pointer',
                padding: 0,
              }}
              type="button"
            >
              {showAll
                ? t('portfolio.dividends.showLess')
                : t('portfolio.dividends.showMore', { count: entries.length - 3 })}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Portfolio overview (PROJECTPLAN.md §6.9; Origin recomposition per
 * docs/redesign/REAL_APP_REDESIGN_PROMPT.md): one continuous working canvas —
 * net-worth hero + ruled stat strip, the value-over-time chart integrated into
 * the page, allocation, holdings with expandable transaction rows, winners/
 * losers, dividend intelligence and the recent ledger, separated by rules
 * instead of nested cards. All writes flow through the existing dialogs.
 */
export function PortfolioPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const store = usePortfolioStore();
  // What the store under this subtree can serve, and which cache keyspace its
  // answers belong in (see PortfolioStoreProvider). Both are the account-level
  // defaults everywhere except inside an unlocked vault portfolio.
  const capabilities = usePortfolioStoreCapabilities();
  const storeScope = usePortfolioStoreScope();
  const [range, setRange] = useState<PriceRange>('1M');
  // #125: absolute value curve (€) vs. cash-flow-neutralized performance (%).
  // Remembered per device for this surface (board #68 item 4) — the default is
  // still the € curve, so nobody's overview changes until they ask it to.
  const [displayMode, setDisplayMode] = useChartDisplayMode('portfolio-overview');
  const perfMode = displayMode === 'perf';
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [recentSourceSelection, setRecentSourceSelection] = useState<{
    portfolioId: string;
    source: string;
  } | null>(null);
  const [txnDialog, setTxnDialog] = useState<TxnDialogState | null>(null);
  const [valuePointAsset, setValuePointAsset] = useState<ValuePointEditorAsset | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [cashDialogKind, setCashDialogKind] = useState<'deposit' | 'withdrawal' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [memberSheetOpen, setMemberSheetOpen] = useState(false);

  // The API is portfolio_id-scoped (§6.8): resolve the active portfolio, then
  // thread its id through every scoped read/write. The active one is named by
  // the `?portfolio=` routing param the switcher sets (§13.2 V2-P8), falling
  // back to the default — so switching in the topbar re-scopes this whole page.
  const [searchParams] = useSearchParams();

  // Global create actions land on the overview because this is the surface
  // that owns the transaction dialog — unless the store below cannot write, in
  // which case the palette/shell entry must not open a dialog that can only
  // refuse (failure map #7). The intent is still consumed, so the query flag
  // does not stay in the URL waiting to fire on the next portfolio.
  useCreateIntent(CREATE_INTENT.trade, () => {
    if (capabilities.writes) setTxnDialog({ kind: 'create' });
  });

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    staleTime: 60_000,
  });

  const activeParam = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const portfolio = useMemo(
    () => resolveActivePortfolio(portfoliosQuery.data?.portfolios ?? [], activeParam),
    [portfoliosQuery.data, activeParam],
  );
  const portfolioId = portfolio?.id ?? null;
  // Bind the selection to the portfolio without an effect-driven reset: a route
  // switch immediately falls back to all sources and cannot reuse another
  // portfolio's source slug while its reads settle.
  const recentSourceFilter =
    recentSourceSelection?.portfolioId === portfolioId ? recentSourceSelection.source : 'all';

  // The decrypted names of whatever this device holds open, so a vaulted
  // portfolio is named by what it IS rather than by the vault it sits in
  // (failure map #6). Empty for every normal account — the roster carries no
  // vaulted row, so the hook resolves nothing and imports nothing.
  const unlockedNames = useUnlockedPortfolioNames(
    useMemo(() => portfoliosQuery.data?.portfolios ?? [], [portfoliosQuery.data]),
  );
  const displayName =
    portfolio == null
      ? null
      : portfolioDisplayName(
          portfolio,
          t('vault.lockedStub.fallbackAlias'),
          unlockedNames.get(portfolio.id),
        );

  const portfolioQuery = useQuery({
    queryKey: ['portfolio', portfolioId, ...storeScope],
    queryFn: ({ signal }) => store.getPortfolio(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 60_000,
  });

  const historyQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'history', toHistoryRange(range), ...storeScope],
    queryFn: ({ signal }) =>
      store.getPortfolioHistory(portfolioId!, toHistoryRange(range), false, signal),
    enabled: portfolioId !== null,
    staleTime: HISTORY_STALE_MS,
  });

  // The overview renders exactly this page. Executed-time ordering and the
  // selected source are enforced at the data boundary; the source facet remains
  // portfolio-wide so older tags do not disappear from the selector.
  const transactionsQuery = useQuery({
    queryKey: [
      'portfolio',
      portfolioId,
      'transactions',
      'recent',
      'executedAt',
      recentSourceFilter,
      ...storeScope,
    ],
    queryFn: ({ signal }) =>
      store.listTransactions(
        portfolioId!,
        {
          limit: RECENT_TRANSACTIONS_LIMIT,
          order: 'executedAt',
          source: recentSourceFilter === 'all' ? undefined : recentSourceFilter,
          includeSourceTags: true,
        },
        signal,
      ),
    enabled: portfolioId !== null,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  // Only holdings in the active portfolio's rendered result may start a detail
  // read. The expanded set intentionally survives route switches, but a stale id
  // from portfolio A is filtered out before queries are built for portfolio B.
  const renderedHoldingIds = useMemo(
    () => new Set((portfolioQuery.data?.holdings ?? []).map((holding) => holding.asset.id)),
    [portfolioQuery.data?.holdings],
  );
  const expandedAssetIds = useMemo(
    () => [...expanded].filter((assetId) => renderedHoldingIds.has(assetId)).sort(),
    [expanded, renderedHoldingIds],
  );
  const holdingTransactionQueries = useQueries({
    queries: expandedAssetIds.map((assetId) => ({
      queryKey: ['portfolio', portfolioId, 'transactions', 'asset', assetId, ...storeScope],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        store.listTransactions(
          portfolioId!,
          { assetId, limit: HOLDING_TRANSACTIONS_LIMIT },
          signal,
        ),
      enabled: portfolioId !== null,
      staleTime: 60_000,
    })),
  });

  // Active cash sources (V3-P3): fed to the cash + transaction dialogs so their
  // source picker appears once a second source exists (defaulting to Main).
  const cashSourcesQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'cash-sources', false, ...storeScope],
    queryFn: ({ signal }) => store.listCashSources(portfolioId!, false, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });
  const cashSources = cashSourcesQuery.data?.sources ?? [];

  const deleteMutation = useMutation({
    mutationFn: ({ id, baseSeq }: { id: string; baseSeq?: number }) =>
      store.deleteTransaction(portfolioId!, id, { baseSeq }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
    },
    // The solvency gate's rejection is deliberate and permanent — surface its
    // guidance ("add cash or remove the dependent movements") instead of a
    // transient-sounding "try again" the user would retry forever.
    onError: (err) =>
      setActionError(
        err instanceof ApiError && err.code === 'CASH_LEDGER_WOULD_GO_NEGATIVE'
          ? err.message
          : err instanceof ApiError && err.code === 'MIRROR_CONFLICT'
            ? t('portfolio.transaction.mirrorConflict')
            : err instanceof ApiError && err.code === 'MIRROR_ROW_DELETED'
              ? t('portfolio.transaction.mirrorRowDeleted')
              : t('portfolio.overview.deleteTxnError'),
      ),
  });

  const transactionDetailsByAsset = new Map<string, HoldingTransactionDetails>(
    expandedAssetIds.map((assetId, index) => {
      const query = holdingTransactionQueries[index]!;
      return [
        assetId,
        {
          items: query.data?.items ?? [],
          isLoading: query.isLoading,
          error: query.error,
          retry: () => void query.refetch(),
        },
      ];
    }),
  );

  function refetchAll() {
    void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
    void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
  }

  function toggleExpanded(assetId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  // #125: in performance mode the curve is the deposit-neutralized TWR series —
  // a 1 000 € top-up causes no jump; the line only moves when holdings move.
  //
  // Both forms are mapped from the SAME history response — `performance[]` is
  // aligned 1:1 with `points[]` and keyed identically — which is what lets the
  // % curve carry a money scrub tooltip without a second request (board #68
  // item 4). Nothing is recomputed here: the server owns both series.
  const valuePoints = useMemo(
    () =>
      (historyQuery.data?.points ?? []).map((p) => ({ time: historyTime(p), value: p.valueEur })),
    [historyQuery.data],
  );
  const performancePoints = useMemo(
    () =>
      (historyQuery.data?.performance ?? []).map((p) => ({ time: historyTime(p), value: p.pct })),
    [historyQuery.data],
  );
  const chartPoints = perfMode ? performancePoints : valuePoints;

  // ── Loading / error ──
  if (portfoliosQuery.isLoading || (portfolioId !== null && portfolioQuery.isLoading)) {
    return (
      <div className="flex flex-col gap-6">
        <SkeletonBlock height={32} width={210} />
        <SkeletonBlock height={92} />
        <SkeletonBlock height={320} />
      </div>
    );
  }

  if (
    portfoliosQuery.isError ||
    portfolioId === null ||
    portfolioQuery.isError ||
    !portfolioQuery.data
  ) {
    // A VAULTED portfolio never gets told to refresh the page. The unlock
    // session is memory-only, so a reload is the one action that turns a
    // transient read failure into a locked stub and a second password prompt
    // (failure map #1/#3). Retry re-runs the read in place instead, which is
    // what the copy offers.
    const vaulted = isVaultedPortfolio(portfolio);
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          onRecord={() => setTxnDialog({ kind: 'create' })}
          onNewCustom={() => setCustomOpen(true)}
        />
        <Alert tone="error">
          {vaulted ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{t('portfolio.overview.vaultedLoadError')}</span>
              <Button onClick={() => void portfolioQuery.refetch()} size="sm">
                {t('common.retry')}
              </Button>
            </div>
          ) : (
            t('portfolio.overview.loadError')
          )}
        </Alert>
        {renderDialogs()}
      </div>
    );
  }

  const { holdings: rawHoldings, totals } = portfolioQuery.data;
  const holdings = [...rawHoldings].sort(
    (a, b) => (b.marketValueEur ?? -Infinity) - (a.marketValueEur ?? -Infinity),
  );
  const isEmpty = holdings.length === 0;

  function renderDialogs() {
    return (
      <>
        {txnDialog && portfolioId
          ? (() => {
              // The dialog's asset (create-with-asset or edit), for the sell "Max"
              // (held quantity) and to keep the Main-cash "Max" affordable (#378).
              const dialogAssetId =
                txnDialog.kind === 'edit'
                  ? txnDialog.transaction.assetId
                  : (txnDialog.asset?.id ?? undefined);
              const heldQuantity = dialogAssetId
                ? (portfolioQuery.data?.holdings ?? []).find((h) => h.asset.id === dialogAssetId)
                    ?.quantity
                : undefined;
              return (
                <TransactionDialog
                  portfolioId={portfolioId}
                  transaction={txnDialog.kind === 'edit' ? txnDialog.transaction : undefined}
                  asset={txnDialog.kind === 'create' ? txnDialog.asset : undefined}
                  defaultPayFromCash={portfolio?.defaultPayFromCash ?? false}
                  cashSources={cashSources}
                  // NEVER `portfolio.name`: a vaulted row's name column holds
                  // E4's content-free sentinel, which this dialog printed as its
                  // subtitle (failure map #6). One seam decides what a portfolio
                  // is called, everywhere.
                  portfolioName={displayName ?? undefined}
                  availableCashEur={cashSources.find((s) => s.isMain)?.balanceEur}
                  heldQuantity={heldQuantity}
                  onClose={() => setTxnDialog(null)}
                  onSubmitted={refetchAll}
                />
              );
            })()
          : null}
        {cashDialogKind && portfolioId ? (
          <CashDialog
            portfolioId={portfolioId}
            initialKind={cashDialogKind}
            sources={cashSources}
            onClose={() => setCashDialogKind(null)}
            onSubmitted={refetchAll}
          />
        ) : null}
        {valuePointAsset ? (
          <ValuePointEditor
            asset={valuePointAsset}
            onClose={() => setValuePointAsset(null)}
            onSaved={refetchAll}
          />
        ) : null}
        {customOpen ? (
          <CustomInvestmentDialog onClose={() => setCustomOpen(false)} onCreated={refetchAll} />
        ) : null}
        <NormalModeOnly>
          {memberSheetOpen && portfolio?.mirror ? (
            <MemberSheet
              chainId={portfolio.mirror.chainId}
              onClose={() => setMemberSheetOpen(false)}
            />
          ) : null}
        </NormalModeOnly>
      </>
    );
  }

  return (
    <div className="bt-money-surface flex flex-col">
      <PageHeader
        onRecord={() => setTxnDialog({ kind: 'create' })}
        onNewCustom={() => setCustomOpen(true)}
      />

      {/* Both supporting reads are classified separately: whichever of them is a
          recoverable outage keeps its Retry, and that Retry re-runs only it.
          A store that refuses these rows BY DESIGN states nothing here at all:
          the refusal is not an outage and not news, and announcing it painted a
          permanent "This information isn't available." over the net-worth
          headline of a portfolio that was rendering perfectly (failure map #7).
          The places that would otherwise show an empty list — the recent ledger,
          the expanded holding rows — keep saying so where the rows would be. */}
      {capabilities.rowReads ? (
        <AsyncReadState
          loading={transactionsQuery.isLoading || cashSourcesQuery.isLoading}
          reads={[
            { error: transactionsQuery.error, refetch: () => transactionsQuery.refetch() },
            { error: cashSourcesQuery.error, refetch: () => cashSourcesQuery.refetch() },
          ]}
          errorLabel={t('portfolio.overview.detailsLoadError')}
        />
      ) : null}

      <NormalModeOnly>
        {/* This migration flag exists only on server-side custom-asset rows.
            Vault assets have no recategorization state, so paranoid mode must
            not mount (or adapt) this server probe. */}
        <RecategorizeBanner />
      </NormalModeOnly>

      {/* Above the empty/non-empty split on purpose: an invited member's copy is
          empty until the first ops replicate, and hiding the chain surface there
          left them with no way to see who is in it or whether it had synced. */}
      <NormalModeOnly>
        {portfolio?.mirror ? (
          <div style={{ marginBottom: 14 }}>
            <MirrorAvatarStack badge={portfolio.mirror} onClick={() => setMemberSheetOpen(true)} />
          </div>
        ) : null}
        {portfolio?.mirrorFork ? (
          <div style={{ marginBottom: 14 }}>
            <MirrorForkProvenanceLine fork={portfolio.mirrorFork} />
          </div>
        ) : null}
      </NormalModeOnly>

      {isEmpty ? (
        <EmptyState
          icon="💼"
          title={t('portfolio.overview.emptyState.title')}
          description={t('portfolio.overview.emptyState.description')}
          cta={
            <div className="flex flex-wrap justify-center gap-2">
              {/* The two writes leave when the store has none; the Assets link
                  stays because browsing the catalog works either way. */}
              {capabilities.writes ? (
                <>
                  <Button onClick={() => setTxnDialog({ kind: 'create' })} variant="primary">
                    {t('portfolio.overview.emptyState.recordButton')}
                  </Button>
                  <Button onClick={() => setCustomOpen(true)}>
                    {t('portfolio.overview.emptyState.newCustomButton')}
                  </Button>
                </>
              ) : null}
              <Link className="bt-btn bt-btn--quiet" to="/assets/search">
                {t('portfolio.overview.emptyState.searchLink')}
              </Link>
            </div>
          }
        />
      ) : (
        <>
          <TotalsHeader
            totals={totals}
            onDeposit={() => setCashDialogKind('deposit')}
            onWithdraw={() => setCashDialogKind('withdrawal')}
          />

          <section aria-label={t('portfolio.overview.chart.heading')} className="bt-section">
            <div className="bt-section__head">
              <h2 className="bt-h2">{t('portfolio.overview.chart.heading')}</h2>
              <div className="flex flex-wrap items-center gap-2">
                <Seg
                  ariaLabel={t('portfolio.overview.chart.displayModeAriaLabel')}
                  onChange={(mode) => setDisplayMode(mode === 'perf' ? 'perf' : 'value')}
                  options={[
                    { value: 'value', label: t('portfolio.overview.chart.valueMode') },
                    { value: 'perf', label: t('portfolio.overview.chart.performanceMode') },
                  ]}
                  value={perfMode ? 'perf' : 'value'}
                />
                {/* Overlay-assets + deeper analysis live in Analysis (§13.3
                    V3-P9); the overview keeps only the simple curve. Carry the
                    active portfolio so the deep-dive opens the same one (#322). */}
                <Link
                  className="bt-link"
                  style={{ fontSize: 12.5 }}
                  to={{
                    pathname: '/portfolio/analysis',
                    search: activeParam
                      ? `?${ACTIVE_PORTFOLIO_PARAM}=${encodeURIComponent(activeParam)}`
                      : '',
                  }}
                >
                  {t('portfolio.overview.chart.analyticsLink')}
                </Link>
              </div>
            </div>
            {perfMode ? (
              <p className="bt-meta" style={{ marginBottom: 8 }}>
                {t('portfolio.overview.chart.perfHint')}
              </p>
            ) : null}
            <AsyncReadState
              loading={false}
              error={historyQuery.error}
              errorLabel={t('portfolio.overview.chart.loadError')}
              onRetry={() => void historyQuery.refetch()}
            />
            {historyQuery.error && !historyQuery.data ? (
              <Seg
                ariaLabel={t('common.charts.selectRange')}
                onChange={setRange}
                options={PORTFOLIO_RANGES.map((value) => ({ value, label: value }))}
                value={range}
              />
            ) : null}
            <div className="bt-chart">
              {!historyQuery.error || historyQuery.data ? (
                <PriceChart
                  series={chartPoints}
                  mode={perfMode ? 'baseline' : 'area'}
                  percentValues={perfMode}
                  // Board #68 item 4: the % curve keeps the money answer one
                  // hover away. Same response, same time keys — no second read.
                  balanceSeries={perfMode ? valuePoints : undefined}
                  balanceCurrency={
                    historyQuery.data?.baseCurrency ?? portfolioQuery.data?.baseCurrency
                  }
                  valueCurrency={
                    historyQuery.data?.baseCurrency ?? portfolioQuery.data?.baseCurrency
                  }
                  range={range}
                  ranges={PORTFOLIO_RANGES}
                  onRangeChange={setRange}
                  loading={historyQuery.isLoading || historyQuery.isFetching}
                  height={340}
                  ariaLabel={
                    perfMode
                      ? t('portfolio.overview.chart.ariaLabelPerformance')
                      : t('portfolio.overview.chart.ariaLabelValue')
                  }
                />
              ) : null}
            </div>
          </section>

          <AllocationSection holdings={holdings} cashEur={totals.cashEur} />

          <section aria-label={t('portfolio.overview.holdingsAriaLabel')} className="bt-section">
            <div className="bt-section__head">
              <h2 className="bt-h2">{t('portfolio.overview.holdingsHeading')}</h2>
            </div>
            {actionError ? <Alert tone="error">{actionError}</Alert> : null}
            <HoldingsTable
              holdings={holdings}
              transactionDetailsByAsset={transactionDetailsByAsset}
              expanded={expanded}
              onToggle={toggleExpanded}
              onRecord={(asset) => setTxnDialog({ kind: 'create', asset })}
              onEditTxn={(transaction) => setTxnDialog({ kind: 'edit', transaction })}
              onDeleteTxn={(txn) =>
                deleteMutation.mutate({ id: txn.id, baseSeq: txn.mirror?.version })
              }
              onEditValuePoints={setValuePointAsset}
              deletingId={deleteMutation.isPending ? (deleteMutation.variables?.id ?? null) : null}
            />
          </section>

          <WinnersLosersSection holdings={holdings} />

          <NormalModeOnly>
            <DividendIntelSection />
          </NormalModeOnly>

          <RecentTransactionsSection
            transactions={transactionsQuery.data?.items ?? []}
            sourceTags={transactionsQuery.data?.sourceTags ?? []}
            sourceTagsAreSettled={
              transactionsQuery.isSuccess &&
              transactionsQuery.fetchStatus === 'idle' &&
              !transactionsQuery.isPlaceholderData
            }
            sourceFilter={recentSourceFilter}
            onSourceFilterChange={(source) => setRecentSourceSelection({ portfolioId, source })}
          />
        </>
      )}

      {renderDialogs()}
    </div>
  );
}

/**
 * MIRRORCHAIN (V5-P7 M5, design §11): the "Make this a group portfolio" convert
 * entry point used to stand permanently in these actions. It is a once-in-a-
 * portfolio's-life decision, so it moved to the Settings tab
 * (`PortfolioSettingsPage`) — the overview header keeps only the two things you
 * do every day. Chain *status* (avatar stack → member sheet) still lives here.
 */
function PageHeader({ onRecord, onNewCustom }: { onRecord: () => void; onNewCustom: () => void }) {
  const t = useT();
  // A store that cannot write is not offered write actions. Hidden rather than
  // disabled: a disabled "+ Transaction" invites a hover, a tooltip and a
  // theory, and the honest answer here is that this surface has no writes at
  // all — not that this one is temporarily out of reach (failure map #7).
  const { writes } = usePortfolioStoreCapabilities();
  return (
    <PageHead
      actions={
        writes ? (
          <>
            <Button onClick={onNewCustom}>{t('portfolio.overview.newCustomButton')}</Button>
            <Button onClick={onRecord} variant="primary">
              {t('portfolio.overview.recordButton')}
            </Button>
          </>
        ) : null
      }
      title={t('portfolio.overview.title')}
    />
  );
}

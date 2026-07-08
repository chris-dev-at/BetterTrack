import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type {
  Holding,
  PortfolioHistoryRange,
  PortfolioTotals,
  Transaction,
} from '@bettertrack/contracts';

import {
  deleteTransaction,
  dismissRecategorization,
  getPortfolio,
  getPortfolioHistory,
  getRecategorizationStatus,
  listPortfolios,
  listTransactions,
} from '../../lib/portfolioApi';
import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { cx } from '../../lib/cx';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from './PortfolioSwitcher';
import {
  EM_DASH,
  formatDate,
  formatPercent,
  formatQuantity,
  formatSignedPercent,
} from '../../lib/format';
import { EmptyState, MoneyText, Skeleton, StatCard } from '../../ui';
import { AllocationDonut, PriceChart } from '../../ui/charts';
import type { AllocationSegment, BenchmarkSeries, PriceRange } from '../../ui/charts';
import { Alert, Button } from '../components/ui';
import { TransactionDialog, type TransactionDialogAsset } from '../components/TransactionDialog';
import { CashDialog } from './CashDialog';
import { ValuePointEditor, type ValuePointEditorAsset } from './ValuePointEditor';
import { CustomInvestmentDialog } from './CustomInvestmentDialog';

// ─── Range mapping ──────────────────────────────────────────────────────────

/**
 * The value-over-time chart offers only these ranges (PROJECTPLAN.md §6.9): the
 * portfolio history endpoint is month-granular ({@link PortfolioHistoryRange})
 * with no day-level `1D`/`1W`/`3M` window, so it sticks to the subset of the
 * chart's range tokens it can actually serve.
 */
const PORTFOLIO_RANGES: readonly PriceRange[] = ['1M', '1Y', 'Max'];

/** The chart's `PriceRange` tokens use 'Max'; the contract uses 'MAX'. */
function toHistoryRange(r: PriceRange): PortfolioHistoryRange {
  return r === 'Max' ? 'MAX' : (r as PortfolioHistoryRange);
}

/** §6.9 caches the series 1 h; mirror that as the client staleTime. */
const HISTORY_STALE_MS = 3_600_000;

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

// ─── Totals header ────────────────────────────────────────────────────────────

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

/**
 * Compact liquidity ring (V3-P0 redesign, #322): a small invested-vs-liquid
 * donut that belongs in the overview instead of the old full-width split bar the
 * owner found "out of place". Same data — the invested share (sky) and its cash
 * complement (emerald) — drawn as two arcs of a single ring with the liquid
 * share called out in the centre. Purely decorative shape; the accessible
 * description carries both percentages.
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
          stroke="currentColor"
          strokeWidth="8"
          className="text-neutral-800"
        />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          strokeWidth="8"
          className="text-sky-500"
          stroke="currentColor"
          strokeDasharray={`${investedLen} ${circumference}`}
        />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          strokeWidth="8"
          className="text-emerald-500"
          stroke="currentColor"
          strokeDasharray={`${circumference - investedLen} ${circumference}`}
          strokeDashoffset={-investedLen}
        />
      </svg>
      <div className="text-xs text-neutral-400" aria-hidden="true">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-sky-500" />
          <span>
            <span className="font-medium text-neutral-200">{formatPercent(investedPct)}</span>{' '}
            {t('portfolio.overview.liquidityRing.investedLegend')}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span>
            <span className="font-medium text-neutral-200">{formatPercent(cashPct)}</span>{' '}
            {t('portfolio.overview.liquidityRing.liquidLegend')}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Net-worth headline (#311): the primary figure is the portfolio's total worth
 * — holdings + cash — with the invested/cash composition spelled out and a
 * compact liquidity ring answering "how liquid am I?" at a glance.
 */
function NetWorthHeadline({ totals }: { totals: PortfolioTotals }) {
  const t = useT();
  // Clamp the invested share to [0, 100] and derive the cash share as its
  // complement, so the two always sum to exactly 100 % of the headline total.
  const investedPct =
    totals.totalValueEur > 0
      ? Math.min(100, Math.max(0, (totals.marketValueEur / totals.totalValueEur) * 100))
      : null;
  const cashPct = investedPct == null ? null : 100 - investedPct;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {t('portfolio.overview.netWorth.label')}
        </p>
        <p className="mt-1 text-3xl font-semibold tracking-tight text-neutral-100">
          <MoneyText amount={totals.totalValueEur} />
        </p>
        <p className="mt-1 text-sm text-neutral-400">
          <MoneyText amount={totals.marketValueEur} />{' '}
          {t('portfolio.overview.netWorth.investedWord')} &middot;{' '}
          <MoneyText amount={totals.cashEur} /> {t('portfolio.overview.netWorth.cashWord')}
        </p>
      </div>
      {investedPct != null && cashPct != null ? (
        <LiquidityRing investedPct={investedPct} cashPct={cashPct} />
      ) : null}
    </div>
  );
}

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
  return (
    <section aria-label={t('portfolio.overview.totalsAriaLabel')} className="flex flex-col gap-3">
      <NetWorthHeadline totals={totals} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
        <StatCard
          label={t('portfolio.overview.field.cash')}
          value={<MoneyText amount={totals.cashEur} />}
          subValue={
            <span className="flex gap-2">
              <button
                type="button"
                onClick={onDeposit}
                className="text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                {t('portfolio.overview.depositButton')}
              </button>
              <button
                type="button"
                onClick={onWithdraw}
                className="text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                {t('portfolio.overview.withdrawButton')}
              </button>
            </span>
          }
        />
      </div>
    </section>
  );
}

// ─── Allocation donuts ──────────────────────────────────────────────────────

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
    <section
      aria-label={t('portfolio.overview.allocationAriaLabel')}
      className="grid gap-6 sm:grid-cols-2"
    >
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <h3 className="mb-4 text-sm font-semibold text-neutral-200">
          {t('portfolio.overview.allocation.byAssetTitle')}
        </h3>
        <AllocationDonut
          data={byAsset}
          title={t('portfolio.overview.allocation.byAssetChartTitle')}
        />
      </div>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <h3 className="mb-4 text-sm font-semibold text-neutral-200">
          {t('portfolio.overview.allocation.byTypeTitle')}
        </h3>
        <AllocationDonut
          data={byType}
          title={t('portfolio.overview.allocation.byTypeChartTitle')}
        />
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
    <li className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Link
          to={`/assets/${holding.asset.id}`}
          className="block truncate font-mono text-sm font-medium text-neutral-100 hover:text-sky-400"
        >
          {holding.asset.symbol}
        </Link>
        <p className="max-w-[10rem] truncate text-xs text-neutral-500" title={holding.asset.name}>
          {holding.asset.name}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <DeltaPct value={pct} />
        {deltaEur != null ? (
          <span className="text-xs text-neutral-500">
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
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <h3 className="mb-3 text-sm font-semibold text-neutral-200">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {t('portfolio.overview.winnersLosers.nothingToShow')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
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
    <section
      aria-label={t('portfolio.overview.winnersLosers.ariaLabel')}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-neutral-200">
          {t('portfolio.overview.winnersLosers.heading')}
        </h2>
        <div className="flex gap-1 rounded p-0.5 ring-1 ring-inset ring-neutral-800">
          <button
            type="button"
            aria-pressed={metric === 'day'}
            onClick={() => setMetric('day')}
            className={cx(
              'rounded px-2 py-1 text-xs font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              metric === 'day'
                ? 'bg-sky-600 text-white'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
            )}
          >
            {t('portfolio.overview.winnersLosers.dayMetric')}
          </button>
          <button
            type="button"
            aria-pressed={metric === 'total'}
            onClick={() => setMetric('total')}
            className={cx(
              'rounded px-2 py-1 text-xs font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              metric === 'total'
                ? 'bg-sky-600 text-white'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
            )}
          >
            {t('portfolio.overview.winnersLosers.totalMetric')}
          </button>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <RankedList title={t('portfolio.overview.winnersLosers.topWinners')} items={winners} />
        <RankedList title={t('portfolio.overview.winnersLosers.topLosers')} items={losers} />
      </div>
    </section>
  );
}

// ─── Recent transactions ────────────────────────────────────────────────────

const RECENT_TRANSACTIONS_LIMIT = 8;

/** §6.8 recent transactions — flat, newest-first ledger across all holdings. */
function RecentTransactionsSection({ transactions }: { transactions: Transaction[] }) {
  const t = useT();
  if (transactions.length === 0) return null;
  const recent = [...transactions]
    .sort((a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime())
    .slice(0, RECENT_TRANSACTIONS_LIMIT);

  return (
    <section
      aria-label={t('portfolio.overview.recentTransactions.ariaLabel')}
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold text-neutral-200">
        {t('portfolio.overview.recentTransactions.heading')}
      </h2>
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <th scope="col" className="px-3 py-2">
                {t('portfolio.overview.field.asset')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('portfolio.overview.field.side')}
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                {t('portfolio.overview.field.qty')}
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                {t('portfolio.overview.field.price')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('portfolio.overview.field.date')}
              </th>
            </tr>
          </thead>
          <tbody>
            {recent.map((txn) => (
              <tr key={txn.id} className="border-b border-neutral-800 last:border-b-0">
                <td className="min-w-0 px-3 py-2">
                  <Link
                    to={`/assets/${txn.assetId}`}
                    className="font-mono text-sm font-medium text-neutral-100 hover:text-sky-400"
                  >
                    {txn.asset.symbol}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cx(
                      'rounded px-1.5 py-0.5 text-xs font-medium',
                      txn.side === 'buy'
                        ? 'bg-emerald-900/50 text-emerald-300'
                        : 'bg-amber-900/50 text-amber-300',
                    )}
                  >
                    {txn.side === 'buy'
                      ? t('portfolio.overview.side.buy')
                      : t('portfolio.overview.side.sell')}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatQuantity(txn.quantity)}
                </td>
                <td className="px-3 py-2 text-right">
                  <MoneyText amount={txn.price} currency={txn.asset.currency} />
                </td>
                <td className="px-3 py-2 text-neutral-400">{formatDate(txn.executedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Holdings table ─────────────────────────────────────────────────────────

interface HoldingsTableProps {
  holdings: Holding[];
  txnsByAsset: Map<string, Transaction[]>;
  expanded: Set<string>;
  onToggle: (assetId: string) => void;
  onRecord: (asset: TransactionDialogAsset) => void;
  onEditTxn: (txn: Transaction) => void;
  onDeleteTxn: (id: string) => void;
  onEditValuePoints: (asset: ValuePointEditorAsset) => void;
  deletingId: string | null;
}

function HoldingsTable({
  holdings,
  txnsByAsset,
  expanded,
  onToggle,
  onRecord,
  onEditTxn,
  onDeleteTxn,
  onEditValuePoints,
  deletingId,
}: HoldingsTableProps) {
  const t = useT();
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="w-5 pl-2" aria-hidden="true" />
            <th scope="col" className="px-3 py-2">
              {t('portfolio.overview.field.asset')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('portfolio.overview.field.qty')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('portfolio.overview.field.avgCost')}
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
            <HoldingRow
              key={h.asset.id}
              holding={h}
              transactions={txnsByAsset.get(h.asset.id) ?? []}
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

interface HoldingRowProps {
  holding: Holding;
  transactions: Transaction[];
  isExpanded: boolean;
  onToggle: () => void;
  onRecord: (asset: TransactionDialogAsset) => void;
  onEditTxn: (txn: Transaction) => void;
  onDeleteTxn: (id: string) => void;
  onEditValuePoints: (asset: ValuePointEditorAsset) => void;
  deletingId: string | null;
}

function HoldingRow({
  holding: h,
  transactions,
  isExpanded,
  onToggle,
  onRecord,
  onEditTxn,
  onDeleteTxn,
  onEditValuePoints,
  deletingId,
}: HoldingRowProps) {
  const t = useT();
  const { asset } = h;
  const dialogAsset: TransactionDialogAsset = {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    currency: asset.currency,
  };

  return (
    <>
      <tr className="border-b border-neutral-800 last:border-b-0">
        <td className="w-5 pl-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? t('portfolio.overview.holdings.collapseRow', { symbol: asset.symbol })
                : t('portfolio.overview.holdings.expandRow', { symbol: asset.symbol })
            }
            className="rounded p-1 text-neutral-500 transition-colors hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
          </button>
        </td>
        <td className="min-w-0 px-3 py-3">
          <Link
            to={`/assets/${asset.id}`}
            className="block font-mono text-sm font-medium text-neutral-100 transition-colors hover:text-sky-400"
          >
            {asset.symbol}
          </Link>
          <p className="max-w-[12rem] truncate text-xs text-neutral-500" title={asset.name}>
            {asset.name}
          </p>
        </td>
        <td className="px-3 py-3 text-right tabular-nums">{formatQuantity(h.quantity)}</td>
        <td className="px-3 py-3 text-right">
          <MoneyText amount={h.avgCost} currency={asset.currency} />
        </td>
        <td className="px-3 py-3 text-right">
          <MoneyText amount={h.price} currency={asset.currency} />
        </td>
        <td className="px-3 py-3 text-right">
          <MoneyText amount={h.marketValueEur} />
        </td>
        <td className="px-3 py-3 text-right">
          <div className="flex flex-col items-end">
            <MoneyText amount={h.unrealizedPnlEur} signed />
            {h.unrealizedPnlPct != null ? (
              <span className="text-xs">
                <DeltaPct value={h.unrealizedPnlPct} />
              </span>
            ) : null}
          </div>
        </td>
        <td className="px-3 py-3 text-right">
          <div className="flex flex-col items-end">
            <MoneyText amount={h.dayChangeEur} signed />
            {h.dayChangePct != null ? (
              <span className="text-xs">
                <DeltaPct value={h.dayChangePct} />
              </span>
            ) : null}
          </div>
        </td>
      </tr>

      {isExpanded ? (
        <tr className="border-b border-neutral-800 bg-neutral-950/40 last:border-b-0">
          <td colSpan={8} className="px-4 py-4">
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  {t('portfolio.overview.holdings.transactionsHeading')}
                </h4>
                <div className="flex gap-2">
                  {asset.isCustom ? (
                    <Button
                      variant="secondary"
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
                    >
                      {t('portfolio.overview.holdings.editValuePoints')}
                    </Button>
                  ) : null}
                  <Button variant="secondary" onClick={() => onRecord(dialogAsset)}>
                    {t('portfolio.overview.recordButton')}
                  </Button>
                </div>
              </div>

              {h.realizedPnl !== 0 ? (
                <p className="text-xs text-neutral-500">
                  {t('portfolio.overview.holdings.realizedPnlLabel')}{' '}
                  <MoneyText amount={h.realizedPnl} currency={asset.currency} signed />
                </p>
              ) : null}

              {transactions.length === 0 ? (
                <p className="text-sm text-neutral-500">
                  {t('portfolio.overview.holdings.noTransactions')}
                </p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-neutral-500">
                      <th scope="col" className="py-1 pr-3 font-medium">
                        {t('portfolio.overview.field.date')}
                      </th>
                      <th scope="col" className="py-1 pr-3 font-medium">
                        {t('portfolio.overview.field.side')}
                      </th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">
                        {t('portfolio.overview.field.qty')}
                      </th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">
                        {t('portfolio.overview.field.price')}
                      </th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">
                        {t('portfolio.overview.field.fee')}
                      </th>
                      <th scope="col" className="py-1 pr-3 font-medium">
                        {t('portfolio.overview.field.note')}
                      </th>
                      <th
                        scope="col"
                        className="py-1 text-right font-medium"
                        aria-label={t('portfolio.overview.holdings.actionsAriaLabel')}
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
                        onDelete={() => onDeleteTxn(txn.id)}
                        deleting={deletingId === txn.id}
                      />
                    ))}
                  </tbody>
                </table>
              )}
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
  const [confirming, setConfirming] = useState(false);

  return (
    <tr className="border-t border-neutral-800/60">
      <td className="py-2 pr-3 text-neutral-300">{formatDate(txn.executedAt)}</td>
      <td className="py-2 pr-3">
        <span
          className={cx(
            'rounded px-1.5 py-0.5 text-xs font-medium',
            txn.side === 'buy'
              ? 'bg-emerald-900/50 text-emerald-300'
              : 'bg-amber-900/50 text-amber-300',
          )}
        >
          {txn.side === 'buy'
            ? t('portfolio.overview.side.buy')
            : t('portfolio.overview.side.sell')}
        </span>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-neutral-300">
        {formatQuantity(txn.quantity)}
      </td>
      <td className="py-2 pr-3 text-right text-neutral-300">
        <MoneyText amount={txn.price} currency={currency} />
      </td>
      <td className="py-2 pr-3 text-right text-neutral-300">
        {txn.fee > 0 ? <MoneyText amount={txn.fee} currency={currency} /> : EM_DASH}
      </td>
      <td
        className="max-w-[10rem] truncate py-2 pr-3 text-neutral-500"
        title={txn.note ?? undefined}
      >
        {txn.note ?? EM_DASH}
      </td>
      <td className="py-2 text-right">
        {confirming ? (
          <span className="inline-flex items-center gap-1">
            <span className="text-neutral-400">
              {t('portfolio.overview.transaction.deleteConfirm')}
            </span>
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className="rounded px-1.5 py-0.5 text-red-400 hover:bg-neutral-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {deleting ? '…' : t('common.yes')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={deleting}
              className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {t('common.no')}
            </button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={onEdit}
              aria-label={t('portfolio.overview.transaction.editAriaLabel', {
                date: formatDate(txn.executedAt),
              })}
              className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {t('common.edit')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={t('portfolio.overview.transaction.deleteAriaLabel', {
                date: formatDate(txn.executedAt),
              })}
              className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              ✕
            </button>
          </span>
        )}
      </td>
    </tr>
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

  if (!statusQuery.data || statusQuery.data.pending <= 0) return null;

  return (
    <Alert tone="info">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{t('portfolio.recategorize.message')}</span>
        <Button
          variant="secondary"
          onClick={() => dismissMutation.mutate()}
          disabled={dismissMutation.isPending}
        >
          {t('portfolio.recategorize.dismiss')}
        </Button>
      </div>
    </Alert>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Portfolio page (PROJECTPLAN.md §6.9, §7.2). Totals header, value-over-time
 * chart, allocation donuts, and a holdings table whose rows expand to their
 * transactions. Transactions and custom investments are created/edited through
 * the `TransactionDialog`, `ValuePointEditor` and `CustomInvestmentDialog`.
 */
export function PortfolioPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<PriceRange>('1M');
  const [overlay, setOverlay] = useState(false);
  // #125: absolute value curve (€) vs. cash-flow-neutralized performance (%).
  const [perfMode, setPerfMode] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [txnDialog, setTxnDialog] = useState<TxnDialogState | null>(null);
  const [valuePointAsset, setValuePointAsset] = useState<ValuePointEditorAsset | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [cashDialogKind, setCashDialogKind] = useState<'deposit' | 'withdrawal' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The API is portfolio_id-scoped (§6.8): resolve the active portfolio, then
  // thread its id through every scoped read/write. The active one is named by
  // the `?portfolio=` routing param the switcher sets (§13.2 V2-P8), falling
  // back to the default — so switching in the header re-scopes this whole page.
  const [searchParams] = useSearchParams();
  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });

  const activeParam = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const portfolio = useMemo(
    () => resolveActivePortfolio(portfoliosQuery.data?.portfolios ?? [], activeParam),
    [portfoliosQuery.data, activeParam],
  );
  const portfolioId = portfolio?.id ?? null;

  const portfolioQuery = useQuery({
    queryKey: ['portfolio', portfolioId],
    queryFn: ({ signal }) => getPortfolio(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 60_000,
  });

  const historyQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'history', toHistoryRange(range), overlay],
    queryFn: ({ signal }) =>
      getPortfolioHistory(portfolioId!, toHistoryRange(range), overlay, signal),
    enabled: portfolioId !== null,
    staleTime: HISTORY_STALE_MS,
  });

  // Recent ledger, grouped client-side so each holding's expansion shows its rows.
  const transactionsQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'transactions'],
    queryFn: ({ signal }) => listTransactions(portfolioId!, { limit: 200 }, signal),
    enabled: portfolioId !== null,
    staleTime: 60_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTransaction(portfolioId!, id),
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
          : t('portfolio.overview.deleteTxnError'),
      ),
  });

  const txnsByAsset = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const txn of transactionsQuery.data?.items ?? []) {
      const list = map.get(txn.assetId);
      if (list) list.push(txn);
      else map.set(txn.assetId, [txn]);
    }
    return map;
  }, [transactionsQuery.data]);

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
  const chartPoints = useMemo(
    () =>
      perfMode
        ? (historyQuery.data?.performance ?? []).map((p) => ({
            time: p.date as Time,
            value: p.pct,
          }))
        : (historyQuery.data?.points ?? []).map((p) => ({
            time: p.date as Time,
            value: p.valueEur,
          })),
    [historyQuery.data, perfMode],
  );

  // Per-asset overlay series (#122): raw native-currency closes; the chart
  // normalizes everything to percentage moves when overlays are shown. In
  // performance mode (#125) the main curve already *is* a % series, so each
  // overlay is instead re-based here to its own first close in the window —
  // one consistent % unit across every drawn series.
  const chartOverlays = useMemo<BenchmarkSeries[]>(() => {
    const assets = historyQuery.data?.assets ?? [];
    if (!perfMode) {
      return assets.map((a) => ({
        label: a.symbol,
        series: a.points.map((p) => ({ time: p.date as Time, value: p.close })),
      }));
    }
    return assets
      .filter((a) => (a.points[0]?.close ?? 0) > 0)
      .map((a) => {
        const first = a.points[0]!.close;
        return {
          label: a.symbol,
          series: a.points.map((p) => ({
            time: p.date as Time,
            value: (p.close / first - 1) * 100,
          })),
        };
      });
  }, [historyQuery.data, perfMode]);

  // ── Loading / error ──
  if (portfoliosQuery.isLoading || (portfolioId !== null && portfolioQuery.isLoading)) {
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

  if (
    portfoliosQuery.isError ||
    portfolioId === null ||
    portfolioQuery.isError ||
    !portfolioQuery.data
  ) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          onRecord={() => setTxnDialog({ kind: 'create' })}
          onNewCustom={() => setCustomOpen(true)}
        />
        <Alert tone="error">{t('portfolio.overview.loadError')}</Alert>
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
        {txnDialog && portfolioId ? (
          <TransactionDialog
            portfolioId={portfolioId}
            transaction={txnDialog.kind === 'edit' ? txnDialog.transaction : undefined}
            asset={txnDialog.kind === 'create' ? txnDialog.asset : undefined}
            defaultPayFromCash={portfolio?.defaultPayFromCash ?? false}
            onClose={() => setTxnDialog(null)}
            onSubmitted={refetchAll}
          />
        ) : null}
        {cashDialogKind && portfolioId ? (
          <CashDialog
            portfolioId={portfolioId}
            initialKind={cashDialogKind}
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
      </>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        onRecord={() => setTxnDialog({ kind: 'create' })}
        onNewCustom={() => setCustomOpen(true)}
      />

      <RecategorizeBanner />

      {isEmpty ? (
        <EmptyState
          icon="💼"
          title={t('portfolio.overview.emptyState.title')}
          description={t('portfolio.overview.emptyState.description')}
          cta={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setTxnDialog({ kind: 'create' })}>
                {t('portfolio.overview.emptyState.recordButton')}
              </Button>
              <Button variant="secondary" onClick={() => setCustomOpen(true)}>
                {t('portfolio.overview.emptyState.newCustomButton')}
              </Button>
              <Link
                to="/assets/search"
                className="rounded px-3 py-2 text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
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

          <section
            aria-label={t('portfolio.overview.chart.heading')}
            className="flex flex-col gap-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-neutral-200">
                {t('portfolio.overview.chart.heading')}
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-label={t('portfolio.overview.chart.displayModeAriaLabel')}
                  className="inline-flex gap-0.5 rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
                >
                  <ModeButton selected={!perfMode} onClick={() => setPerfMode(false)}>
                    {t('portfolio.overview.chart.valueMode')}
                  </ModeButton>
                  <ModeButton selected={perfMode} onClick={() => setPerfMode(true)}>
                    {t('portfolio.overview.chart.performanceMode')}
                  </ModeButton>
                </div>
                <button
                  type="button"
                  aria-pressed={overlay}
                  onClick={() => setOverlay((v) => !v)}
                  className={cx(
                    'rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                    overlay
                      ? 'bg-sky-600 text-white ring-sky-600'
                      : 'bg-neutral-900 text-neutral-400 ring-neutral-800 hover:bg-neutral-800 hover:text-neutral-100',
                  )}
                >
                  {t('portfolio.overview.chart.overlayToggle')}
                </button>
              </div>
            </div>
            {perfMode ? (
              <p className="text-xs text-neutral-500">{t('portfolio.overview.chart.perfHint')}</p>
            ) : null}
            <PriceChart
              series={chartPoints}
              mode={perfMode ? 'baseline' : 'area'}
              percentValues={perfMode}
              range={range}
              ranges={PORTFOLIO_RANGES}
              onRangeChange={setRange}
              overlays={overlay ? chartOverlays : []}
              loading={historyQuery.isLoading || historyQuery.isFetching}
              ariaLabel={
                perfMode
                  ? t('portfolio.overview.chart.ariaLabelPerformance')
                  : t('portfolio.overview.chart.ariaLabelValue')
              }
            />
          </section>

          <AllocationSection holdings={holdings} cashEur={totals.cashEur} />

          <section
            aria-label={t('portfolio.overview.holdingsAriaLabel')}
            className="flex flex-col gap-3"
          >
            <h2 className="text-lg font-semibold text-neutral-200">
              {t('portfolio.overview.holdingsHeading')}
            </h2>
            {actionError ? <Alert tone="error">{actionError}</Alert> : null}
            <HoldingsTable
              holdings={holdings}
              txnsByAsset={txnsByAsset}
              expanded={expanded}
              onToggle={toggleExpanded}
              onRecord={(asset) => setTxnDialog({ kind: 'create', asset })}
              onEditTxn={(transaction) => setTxnDialog({ kind: 'edit', transaction })}
              onDeleteTxn={(id) => deleteMutation.mutate(id)}
              onEditValuePoints={setValuePointAsset}
              deletingId={deleteMutation.isPending ? (deleteMutation.variables ?? null) : null}
            />
          </section>

          <WinnersLosersSection holdings={holdings} />

          <RecentTransactionsSection transactions={transactionsQuery.data?.items ?? []} />
        </>
      )}

      {renderDialogs()}
    </div>
  );
}

/** One segment of the €/% chart display-mode toggle (#125). */
function ModeButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cx(
        'rounded px-2.5 py-1 text-xs font-medium transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        selected
          ? 'bg-sky-600 text-white'
          : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
      )}
    >
      {children}
    </button>
  );
}

function PageHeader({ onRecord, onNewCustom }: { onRecord: () => void; onNewCustom: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          {t('portfolio.overview.title')}
        </h1>
        <p className="mt-1 text-sm text-neutral-400">{t('portfolio.overview.subtitle')}</p>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onNewCustom}>
          {t('portfolio.overview.newCustomButton')}
        </Button>
        <Button onClick={onRecord}>{t('portfolio.overview.recordButton')}</Button>
      </div>
    </div>
  );
}

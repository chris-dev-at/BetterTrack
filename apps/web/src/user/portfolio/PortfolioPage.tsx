import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
  getPortfolio,
  getPortfolioHistory,
  listTransactions,
} from '../../lib/portfolioApi';
import { cx } from '../../lib/cx';
import { EM_DASH, formatDate, formatQuantity, formatSignedPercent } from '../../lib/format';
import { EmptyState, MoneyText, Skeleton, StatCard } from '../../ui';
import { AllocationDonut, PriceChart } from '../../ui/charts';
import type { AllocationSegment, BenchmarkSeries, PriceRange } from '../../ui/charts';
import { Alert, Button } from '../components/ui';
import { TransactionDialog, type TransactionDialogAsset } from '../components/TransactionDialog';
import { ValuePointEditor, type ValuePointEditorAsset } from './ValuePointEditor';
import { CustomInvestmentDialog } from './CustomInvestmentDialog';

// ─── Range mapping ──────────────────────────────────────────────────────────

/** The value-over-time chart offers only these ranges (PROJECTPLAN.md §6.9). */
const PORTFOLIO_RANGES: readonly PriceRange[] = ['1M', '6M', '1Y', 'Max'];

/** The chart's `PriceRange` tokens use 'Max'; the contract uses 'MAX'. */
function toHistoryRange(r: PriceRange): PortfolioHistoryRange {
  return r === 'Max' ? 'MAX' : (r as PortfolioHistoryRange);
}

/** §6.9 caches the series 1 h; mirror that as the client staleTime. */
const HISTORY_STALE_MS = 3_600_000;

const TYPE_LABELS: Record<string, string> = {
  stock: 'Stocks',
  etf: 'ETFs',
  index: 'Indices',
  fx: 'FX',
  commodity: 'Commodities',
  crypto: 'Crypto',
  custom: 'Custom',
};

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

// ─── Allocation donuts ──────────────────────────────────────────────────────

function AllocationSection({ holdings }: { holdings: Holding[] }) {
  const byAsset: AllocationSegment[] = holdings
    .filter((h) => h.marketValueEur != null && h.marketValueEur > 0)
    .map((h) => ({ label: h.asset.symbol, value: h.marketValueEur! }));

  const byTypeMap = new Map<string, number>();
  for (const h of holdings) {
    if (h.marketValueEur == null || h.marketValueEur <= 0) continue;
    byTypeMap.set(h.asset.type, (byTypeMap.get(h.asset.type) ?? 0) + h.marketValueEur);
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
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <h3 className="mb-3 text-sm font-semibold text-neutral-200">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing to show.</p>
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
    <section aria-label="Top winners and losers" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-neutral-200">Top winners / losers</h2>
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
            Day %
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
            Total P/L
          </button>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <RankedList title="Top winners" items={winners} />
        <RankedList title="Top losers" items={losers} />
      </div>
    </section>
  );
}

// ─── Recent transactions ────────────────────────────────────────────────────

const RECENT_TRANSACTIONS_LIMIT = 8;

/** §6.8 recent transactions — flat, newest-first ledger across all holdings. */
function RecentTransactionsSection({ transactions }: { transactions: Transaction[] }) {
  if (transactions.length === 0) return null;
  const recent = [...transactions]
    .sort((a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime())
    .slice(0, RECENT_TRANSACTIONS_LIMIT);

  return (
    <section aria-label="Recent transactions" className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-neutral-200">Recent transactions</h2>
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <th scope="col" className="px-3 py-2">
                Asset
              </th>
              <th scope="col" className="px-3 py-2">
                Side
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                Qty
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                Price
              </th>
              <th scope="col" className="px-3 py-2">
                Date
              </th>
            </tr>
          </thead>
          <tbody>
            {recent.map((t) => (
              <tr key={t.id} className="border-b border-neutral-800 last:border-b-0">
                <td className="min-w-0 px-3 py-2">
                  <Link
                    to={`/assets/${t.assetId}`}
                    className="font-mono text-sm font-medium text-neutral-100 hover:text-sky-400"
                  >
                    {t.asset.symbol}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cx(
                      'rounded px-1.5 py-0.5 text-xs font-medium',
                      t.side === 'buy'
                        ? 'bg-emerald-900/50 text-emerald-300'
                        : 'bg-amber-900/50 text-amber-300',
                    )}
                  >
                    {t.side === 'buy' ? 'Buy' : 'Sell'}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(t.quantity)}</td>
                <td className="px-3 py-2 text-right">
                  <MoneyText amount={t.price} currency={t.asset.currency} />
                </td>
                <td className="px-3 py-2 text-neutral-400">{formatDate(t.executedAt)}</td>
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
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="w-5 pl-2" aria-hidden="true" />
            <th scope="col" className="px-3 py-2">
              Asset
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Qty
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Avg cost
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
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${asset.symbol} transactions`}
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
                  Transactions
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
                        })
                      }
                    >
                      Edit value points
                    </Button>
                  ) : null}
                  <Button variant="secondary" onClick={() => onRecord(dialogAsset)}>
                    + Transaction
                  </Button>
                </div>
              </div>

              {h.realizedPnl !== 0 ? (
                <p className="text-xs text-neutral-500">
                  Realized P/L:{' '}
                  <MoneyText amount={h.realizedPnl} currency={asset.currency} signed />
                </p>
              ) : null}

              {transactions.length === 0 ? (
                <p className="text-sm text-neutral-500">No transactions loaded for this asset.</p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-neutral-500">
                      <th scope="col" className="py-1 pr-3 font-medium">
                        Date
                      </th>
                      <th scope="col" className="py-1 pr-3 font-medium">
                        Side
                      </th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">
                        Qty
                      </th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">
                        Price
                      </th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">
                        Fee
                      </th>
                      <th scope="col" className="py-1 pr-3 font-medium">
                        Note
                      </th>
                      <th
                        scope="col"
                        className="py-1 text-right font-medium"
                        aria-label="Actions"
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((t) => (
                      <TransactionRow
                        key={t.id}
                        txn={t}
                        currency={asset.currency}
                        onEdit={() => onEditTxn(t)}
                        onDelete={() => onDeleteTxn(t.id)}
                        deleting={deletingId === t.id}
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
          {txn.side === 'buy' ? 'Buy' : 'Sell'}
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
            <span className="text-neutral-400">Delete?</span>
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className="rounded px-1.5 py-0.5 text-red-400 hover:bg-neutral-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {deleting ? '…' : 'Yes'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={deleting}
              className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              No
            </button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit transaction from ${formatDate(txn.executedAt)}`}
              className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`Delete transaction from ${formatDate(txn.executedAt)}`}
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

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Portfolio page (PROJECTPLAN.md §6.9, §7.2). Totals header, value-over-time
 * chart, allocation donuts, and a holdings table whose rows expand to their
 * transactions. Transactions and custom investments are created/edited through
 * the `TransactionDialog`, `ValuePointEditor` and `CustomInvestmentDialog`.
 */
export function PortfolioPage() {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<PriceRange>('1M');
  const [overlay, setOverlay] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [txnDialog, setTxnDialog] = useState<TxnDialogState | null>(null);
  const [valuePointAsset, setValuePointAsset] = useState<ValuePointEditorAsset | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const portfolioQuery = useQuery({
    queryKey: ['portfolio'],
    queryFn: ({ signal }) => getPortfolio(signal),
    staleTime: 60_000,
  });

  const historyQuery = useQuery({
    queryKey: ['portfolio', 'history', toHistoryRange(range), overlay],
    queryFn: ({ signal }) => getPortfolioHistory(toHistoryRange(range), overlay, signal),
    staleTime: HISTORY_STALE_MS,
  });

  // Recent ledger, grouped client-side so each holding's expansion shows its rows.
  const transactionsQuery = useQuery({
    queryKey: ['portfolio', 'transactions'],
    queryFn: ({ signal }) => listTransactions({ limit: 200 }, signal),
    staleTime: 60_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTransaction(id),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
    },
    onError: () => setActionError('Could not delete the transaction. Please try again.'),
  });

  const txnsByAsset = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of transactionsQuery.data?.items ?? []) {
      const list = map.get(t.assetId);
      if (list) list.push(t);
      else map.set(t.assetId, [t]);
    }
    return map;
  }, [transactionsQuery.data]);

  function refetchAll() {
    void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
  }

  function toggleExpanded(assetId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  const chartPoints = useMemo(
    () =>
      (historyQuery.data?.points ?? []).map((p) => ({
        time: p.date as Time,
        value: p.valueEur,
      })),
    [historyQuery.data],
  );

  // Per-asset overlay series (#122): raw native-currency closes; the chart
  // normalizes everything to percentage moves when overlays are shown.
  const chartOverlays = useMemo<BenchmarkSeries[]>(
    () =>
      (historyQuery.data?.assets ?? []).map((a) => ({
        label: a.symbol,
        series: a.points.map((p) => ({ time: p.date as Time, value: p.close })),
      })),
    [historyQuery.data],
  );

  // ── Loading / error ──
  if (portfolioQuery.isLoading) {
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

  if (portfolioQuery.isError || !portfolioQuery.data) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          onRecord={() => setTxnDialog({ kind: 'create' })}
          onNewCustom={() => setCustomOpen(true)}
        />
        <Alert tone="error">Could not load your portfolio. Please refresh the page.</Alert>
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
        {txnDialog ? (
          <TransactionDialog
            transaction={txnDialog.kind === 'edit' ? txnDialog.transaction : undefined}
            asset={txnDialog.kind === 'create' ? txnDialog.asset : undefined}
            onClose={() => setTxnDialog(null)}
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

      {isEmpty ? (
        <EmptyState
          icon="💼"
          title="Your portfolio is empty"
          description="Record your first transaction or add a custom investment to start tracking what you own."
          cta={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setTxnDialog({ kind: 'create' })}>Record transaction</Button>
              <Button variant="secondary" onClick={() => setCustomOpen(true)}>
                New custom investment
              </Button>
              <Link
                to="/assets/search"
                className="rounded px-3 py-2 text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                Search for an asset →
              </Link>
            </div>
          }
        />
      ) : (
        <>
          <TotalsHeader totals={totals} />

          <section aria-label="Value over time" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-neutral-200">Value over time</h2>
              <button
                type="button"
                aria-pressed={overlay}
                onClick={() => setOverlay((v) => !v)}
                className={cx(
                  'rounded px-2 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                  overlay
                    ? 'bg-sky-600 text-white ring-sky-600'
                    : 'bg-neutral-900 text-neutral-400 ring-neutral-800 hover:bg-neutral-800 hover:text-neutral-100',
                )}
              >
                Overlay assets
              </button>
            </div>
            <PriceChart
              series={chartPoints}
              mode="area"
              range={range}
              ranges={PORTFOLIO_RANGES}
              onRangeChange={setRange}
              overlays={overlay ? chartOverlays : []}
              loading={historyQuery.isLoading || historyQuery.isFetching}
              ariaLabel="Portfolio value over time"
            />
          </section>

          <AllocationSection holdings={holdings} />

          <section aria-label="Holdings" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-neutral-200">Holdings</h2>
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

function PageHeader({ onRecord, onNewCustom }: { onRecord: () => void; onNewCustom: () => void }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Portfolio</h1>
        <p className="mt-1 text-sm text-neutral-400">
          What you own, what it&rsquo;s worth, and how it&rsquo;s doing.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onNewCustom}>
          + Custom investment
        </Button>
        <Button onClick={onRecord}>+ Transaction</Button>
      </div>
    </div>
  );
}

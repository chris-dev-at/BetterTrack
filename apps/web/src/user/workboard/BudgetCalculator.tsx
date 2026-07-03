import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';

import type { AllocatePosition, AllocateRequest, AllocateResponse } from '@bettertrack/contracts';

import { allocateConglomerate } from '../../lib/conglomerateApi';
import { cx } from '../../lib/cx';
import { formatMoney, formatPercent, formatQuantity, formatSignedPercent } from '../../lib/format';
import { listPortfolios } from '../../lib/portfolioApi';
import { EmptyState, MoneyText, Skeleton, StatCard } from '../../ui';
import { Alert, Button } from '../components/ui';
import {
  TransactionDialog,
  type TransactionDialogAsset,
  type TransactionPrefillRow,
} from '../components/TransactionDialog';

type AllocateMode = AllocateRequest['mode'];

export interface BudgetCalculatorProps {
  /** The Conglomerate to allocate a budget across (POST .../allocate). */
  conglomerateId: string;
  className?: string;
}

const MODES: Array<{ value: AllocateMode; label: string }> = [
  { value: 'whole', label: 'Whole shares' },
  { value: 'fractional', label: 'Fractional' },
];

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

function ModeToggle({
  active,
  onSelect,
}: {
  active: AllocateMode;
  onSelect: (mode: AllocateMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Buying mode"
      className="inline-flex rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
    >
      {MODES.map(({ value, label }) => {
        const selected = value === active;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(value)}
            className={cx(
              'rounded px-2.5 py-1.5 text-xs font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              selected
                ? 'bg-sky-600 text-white'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function DeviationTable({ positions }: { positions: AllocatePosition[] }) {
  if (positions.length === 0) {
    return <EmptyState title="This basket has no positions to allocate yet." />;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="px-3 py-2">
              Asset
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Qty
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Cost
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Actual %
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Target %
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Δpp
            </th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <Fragment key={p.assetId}>
              <tr
                className={cx(
                  'border-b border-neutral-800 last:border-b-0',
                  p.note && 'border-b-0',
                )}
              >
                <td className="px-3 py-3">
                  <span className="font-mono text-sm font-medium text-neutral-100">{p.symbol}</span>
                  <p className="max-w-[16rem] truncate text-xs text-neutral-500" title={p.name}>
                    {p.name}
                  </p>
                </td>
                <td className="px-3 py-3 text-right text-sm tabular-nums text-neutral-300">
                  {formatQuantity(p.qty)}
                </td>
                <td className="px-3 py-3 text-right text-sm tabular-nums text-neutral-300">
                  <MoneyText amount={p.costEur} />
                </td>
                <td className="px-3 py-3 text-right text-sm tabular-nums text-neutral-300">
                  {formatPercent(p.actualPct)}
                </td>
                <td className="px-3 py-3 text-right text-sm tabular-nums text-neutral-300">
                  {formatPercent(p.targetPct)}
                </td>
                <td className="px-3 py-3 text-right text-sm tabular-nums text-neutral-300">
                  {formatSignedPercent(p.deltaPp)}
                </td>
              </tr>
              {p.note ? (
                <tr className="border-b border-neutral-800 bg-amber-950/20 last:border-b-0">
                  <td colSpan={6} className="px-3 pb-3 text-xs text-amber-300">
                    {p.unbuyable ? `⚠ ${p.note}` : p.note}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TotalsFooter({ result, budgetEur }: { result: AllocateResponse; budgetEur: number }) {
  const withinBudget = result.totalCostEur <= budgetEur + 0.005;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <StatCard label="Total cost" value={formatMoney(result.totalCostEur)} />
      <StatCard label="Leftover" value={formatMoney(result.leftoverEur)} />
      <StatCard
        label="Within budget"
        value={withinBudget ? 'Yes' : 'No'}
        className={withinBudget ? undefined : 'ring-1 ring-inset ring-red-800'}
      />
    </div>
  );
}

/**
 * Non-zero positions become the pre-filled BUY rows for the bulk buy flow
 * (§6.7). A transaction's `price` is recorded in the asset's **native**
 * currency (`domain/holdings.ts`), not the EUR-converted `costEur` used for
 * budget accounting — so the prefill must use `nativePrice`/`currency`.
 */
function toPrefillRows(positions: AllocatePosition[]): TransactionPrefillRow[] {
  return positions
    .filter((p) => p.qty > 0)
    .map((p) => {
      const asset: TransactionDialogAsset = {
        id: p.assetId,
        symbol: p.symbol,
        name: p.name,
        currency: p.currency,
      };
      return {
        asset,
        side: 'buy',
        quantity: p.qty,
        price: p.nativePrice,
      };
    });
}

/**
 * Invest Calculator panel (PROJECTPLAN.md §6.7): budget + mode inputs drive
 * `POST /conglomerates/:id/allocate`, rendered as a per-position deviation
 * table with a totals footer, followed by an "Add to Portfolio" bulk buy flow
 * over the existing `TransactionDialog` + bulk transactions endpoint.
 */
export function BudgetCalculator({ conglomerateId, className }: BudgetCalculatorProps) {
  const queryClient = useQueryClient();
  const [budget, setBudget] = useState('1000');
  const [mode, setMode] = useState<AllocateMode>('whole');
  const [step, setStep] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [lastBudgetEur, setLastBudgetEur] = useState<number | null>(null);

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });
  const portfolioId = useMemo(() => {
    const list = portfoliosQuery.data?.portfolios ?? [];
    return (list.find((p) => p.isDefault) ?? list[0])?.id ?? null;
  }, [portfoliosQuery.data]);

  const mutation = useMutation({
    mutationFn: (budgetEur: number) => {
      const stepValue = Number(step);
      const hasStep =
        mode === 'fractional' && step.trim() !== '' && Number.isFinite(stepValue) && stepValue > 0;
      return allocateConglomerate(conglomerateId, {
        budgetEur,
        mode,
        ...(hasStep ? { step: stepValue } : {}),
      });
    },
  });

  const budgetValue = Number(budget);
  const budgetValid = budget.trim() !== '' && Number.isFinite(budgetValue) && budgetValue >= 0;

  function handleCalculate(e: React.FormEvent) {
    e.preventDefault();
    if (!budgetValid) return;
    setLastBudgetEur(budgetValue);
    mutation.mutate(budgetValue);
  }

  const nonZeroCount = mutation.data ? mutation.data.positions.filter((p) => p.qty > 0).length : 0;
  const prefillRows = mutation.data ? toPrefillRows(mutation.data.positions) : [];

  return (
    <div className={cx('flex flex-col gap-4', className)}>
      <form onSubmit={handleCalculate} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">Budget (EUR)</span>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            aria-label="Budget in EUR"
            className={cx(inputClass, 'w-40')}
          />
        </label>

        <ModeToggle active={mode} onSelect={setMode} />

        {mode === 'fractional' ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">Step</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              placeholder="0.0001"
              value={step}
              onChange={(e) => setStep(e.target.value)}
              aria-label="Fractional quantity step"
              className={cx(inputClass, 'w-28')}
            />
          </label>
        ) : null}

        <Button type="submit" disabled={!budgetValid || mutation.isPending}>
          {mutation.isPending ? 'Calculating…' : 'Calculate'}
        </Button>
      </form>

      {mutation.isPending ? <Skeleton height="h-40" /> : null}

      {mutation.isError ? (
        <Alert tone="error">Could not calculate a buy list. Please try again.</Alert>
      ) : null}

      {!mutation.isPending && !mutation.data && !mutation.isError ? (
        <EmptyState title="Enter a budget and calculate to see a buy list." />
      ) : null}

      {mutation.data ? (
        <>
          {mutation.data.stale ? (
            <Alert tone="info">
              {mutation.data.quoteNotice ??
                'Some quotes are stale; showing the last known prices.'}
            </Alert>
          ) : null}
          {mutation.data.warnings.map((warning) => (
            <Alert tone="info" key={warning}>
              {warning}
            </Alert>
          ))}

          <DeviationTable positions={mutation.data.positions} />
          <TotalsFooter result={mutation.data} budgetEur={lastBudgetEur ?? budgetValue} />

          <Button
            variant="secondary"
            className="self-start"
            disabled={nonZeroCount === 0 || !portfolioId}
            onClick={() => setAddOpen(true)}
          >
            Add to Portfolio
          </Button>
        </>
      ) : null}

      {addOpen && portfolioId ? (
        <TransactionDialog
          portfolioId={portfolioId}
          prefill={prefillRows}
          onClose={() => setAddOpen(false)}
          onSubmitted={() => {
            void queryClient.invalidateQueries({ queryKey: ['portfolio', portfolioId] });
          }}
        />
      ) : null}
    </div>
  );
}

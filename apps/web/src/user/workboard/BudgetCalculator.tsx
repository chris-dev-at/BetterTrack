import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';

import type { AllocatePosition, AllocateRequest, AllocateResponse } from '@bettertrack/contracts';

import { allocateConglomerate } from '../../lib/conglomerateApi';
import { cx } from '../../lib/cx';
import { formatMoney, formatPercent, formatQuantity, formatSignedPercent } from '../../lib/format';
import { listPortfolios } from '../../lib/portfolioApi';
import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
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

function allocateModes(t: TranslateFn): Array<{ value: AllocateMode; label: string }> {
  return [
    { value: 'whole', label: t('workboard.calculator.modeWhole') },
    { value: 'fractional', label: t('workboard.calculator.modeFractional') },
  ];
}

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

/**
 * Selectable stepper granularities for the budget amount (V3-P0, #322): "how far
 * off the comma you want" — whole euros down to a hundred-thousandth. The default
 * (1) reproduces the plain whole-euro stepping; finer picks let the owner nudge
 * the budget by cents (or, for high-priced fractional assets like BTC-EUR, by a
 * fraction of a cent) without retyping. Fractional mode only — see #363.
 */
const BUDGET_STEPS = [1, 0.1, 0.01, 0.001, 0.0001, 0.00001] as const;
type BudgetStep = (typeof BUDGET_STEPS)[number];

/** Decimal places a step implies (1 → 0, 0.1 → 1, 0.01 → 2, … 0.00001 → 5). */
function decimalsForStep(step: number): number {
  return Math.max(0, Math.round(-Math.log10(step)));
}

/**
 * Step a numeric budget string by `delta`, clamped at 0 and re-quantized to the
 * step's own precision so repeated cent steps never accumulate float dust
 * (`0.1 + 0.2` etc.). An empty/invalid current value counts as 0.
 */
function stepBudget(current: string, delta: number, step: BudgetStep): string {
  const decimals = decimalsForStep(step);
  const base = current.trim() !== '' && Number.isFinite(Number(current)) ? Number(current) : 0;
  return Math.max(0, base + delta).toFixed(decimals);
}

function ModeToggle({
  active,
  onSelect,
}: {
  active: AllocateMode;
  onSelect: (mode: AllocateMode) => void;
}) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t('workboard.calculator.buyingModeAriaLabel')}
      className="inline-flex rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
    >
      {allocateModes(t).map(({ value, label }) => {
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

/**
 * "At least one share" opt-in (§13.2 V2-P7, default OFF): re-runs the allocate
 * call with #279's `atLeastOneShare` flag. Whole-mode only — hidden in
 * fractional mode, where the flag is ignored server-side.
 */
function AtLeastOneShareToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const t = useT();
  const label = t('workboard.calculator.atLeastOneShareLabel');
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-neutral-300">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          onClick={() => onChange(!checked)}
          className={cx(
            'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
            checked ? 'bg-sky-600' : 'bg-neutral-700',
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              'inline-block h-5 w-5 translate-y-0.5 rounded-full bg-white transition-transform',
              checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
            )}
          />
        </button>
        <span className="max-w-[14rem] text-xs text-neutral-500">
          {t('workboard.calculator.atLeastOneShareHint')}
        </span>
      </div>
    </div>
  );
}

function DeviationTable({ positions }: { positions: AllocatePosition[] }) {
  const t = useT();
  if (positions.length === 0) {
    return <EmptyState title={t('workboard.calculator.noPositions')} />;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="px-3 py-2">
              {t('workboard.calculator.assetHeader')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('workboard.calculator.qtyHeader')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('workboard.calculator.costHeader')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('workboard.calculator.actualHeader')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('workboard.calculator.targetHeader')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('workboard.calculator.deltaHeader')}
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
  const t = useT();
  const withinBudget = result.totalCostEur <= budgetEur + 0.005;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <StatCard
        label={t('workboard.calculator.totalCostLabel')}
        value={formatMoney(result.totalCostEur)}
      />
      <StatCard
        label={t('workboard.calculator.leftoverLabel')}
        value={formatMoney(result.leftoverEur)}
      />
      <StatCard
        label={t('workboard.calculator.withinBudgetLabel')}
        value={withinBudget ? t('common.yes') : t('common.no')}
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
  const t = useT();
  const queryClient = useQueryClient();
  const [budget, setBudget] = useState('1000');
  const [budgetStep, setBudgetStep] = useState<BudgetStep>(1);
  const [mode, setMode] = useState<AllocateMode>('whole');
  const [atLeastOneShare, setAtLeastOneShare] = useState(false);
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
    mutationFn: (vars: { budgetEur: number; atLeastOneShare: boolean }) =>
      allocateConglomerate(conglomerateId, {
        budgetEur: vars.budgetEur,
        mode,
        ...(mode === 'whole' && vars.atLeastOneShare ? { atLeastOneShare: true } : {}),
      }),
  });

  const budgetValue = Number(budget);
  const budgetValid = budget.trim() !== '' && Number.isFinite(budgetValue) && budgetValue >= 0;

  // Sub-integer step precision is meaningless in whole-shares mode (#363): the
  // picker is hidden there, so the stepper always moves by whole euros.
  const activeStep: BudgetStep = mode === 'whole' ? 1 : budgetStep;

  function handleCalculate(e: React.FormEvent) {
    e.preventDefault();
    if (!budgetValid) return;
    setLastBudgetEur(budgetValue);
    mutation.mutate({ budgetEur: budgetValue, atLeastOneShare });
  }

  /** Toggling re-runs the last calculation immediately, so the buy list stays in sync. */
  function handleAtLeastOneShareChange(next: boolean) {
    setAtLeastOneShare(next);
    if (mutation.data && lastBudgetEur !== null) {
      mutation.mutate({ budgetEur: lastBudgetEur, atLeastOneShare: next });
    }
  }

  const nonZeroCount = mutation.data ? mutation.data.positions.filter((p) => p.qty > 0).length : 0;
  const prefillRows = mutation.data ? toPrefillRows(mutation.data.positions) : [];

  return (
    <div className={cx('flex flex-col gap-4', className)}>
      <form onSubmit={handleCalculate} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('workboard.calculator.budgetLabel')}
          </span>
          <div className="flex items-stretch gap-1">
            <button
              type="button"
              aria-label={t('workboard.calculator.decreaseBudgetAriaLabel', { step: activeStep })}
              onClick={() => setBudget((b) => stepBudget(b, -activeStep, activeStep))}
              className="rounded-md bg-neutral-900 px-2.5 text-neutral-300 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              −
            </button>
            <input
              type="number"
              inputMode="decimal"
              step={activeStep}
              min="0"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              aria-label={t('workboard.calculator.budgetAriaLabel')}
              className={cx(inputClass, 'w-28 text-center')}
            />
            <button
              type="button"
              aria-label={t('workboard.calculator.increaseBudgetAriaLabel', { step: activeStep })}
              onClick={() => setBudget((b) => stepBudget(b, activeStep, activeStep))}
              className="rounded-md bg-neutral-900 px-2.5 text-neutral-300 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              +
            </button>
          </div>
        </div>

        {mode === 'fractional' ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">
              {t('workboard.calculator.stepSizeLabel')}
            </span>
            <select
              value={budgetStep}
              onChange={(e) => setBudgetStep(Number(e.target.value) as BudgetStep)}
              aria-label={t('workboard.calculator.stepPrecisionAriaLabel')}
              className={cx(inputClass, 'w-24')}
            >
              {BUDGET_STEPS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <ModeToggle active={mode} onSelect={setMode} />

        {mode === 'whole' ? (
          <AtLeastOneShareToggle checked={atLeastOneShare} onChange={handleAtLeastOneShareChange} />
        ) : null}

        <Button type="submit" disabled={!budgetValid || mutation.isPending}>
          {mutation.isPending
            ? t('workboard.calculator.calculating')
            : t('workboard.calculator.calculate')}
        </Button>
      </form>

      {mutation.isPending ? <Skeleton height="h-40" /> : null}

      {mutation.isError ? <Alert tone="error">{t('workboard.calculator.calcError')}</Alert> : null}

      {!mutation.isPending && !mutation.data && !mutation.isError ? (
        <EmptyState title={t('workboard.calculator.enterBudgetPrompt')} />
      ) : null}

      {mutation.data ? (
        <>
          {mutation.data.stale ? (
            <Alert tone="info">
              {mutation.data.quoteNotice ?? t('workboard.calculator.staleNotice')}
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
            {t('workboard.calculator.addToPortfolio')}
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

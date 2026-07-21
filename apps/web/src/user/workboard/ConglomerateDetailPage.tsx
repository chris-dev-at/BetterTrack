import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type {
  BacktestPreviewPosition,
  ConglomerateConstituent,
  ResolvedConglomeratePosition,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import {
  deleteConglomerate,
  getConglomerate,
  getResolvedConglomerate,
  updateConglomerate,
} from '../../lib/conglomerateApi';
import { formatWeight } from '../../lib/format';
import { useT } from '../../i18n';
import { cx } from '../../lib/cx';
import { EmptyState, Skeleton } from '../../ui';
import { AllocationDonut } from '../../ui/charts';
import { Alert, Button } from '../components/ui';
import { Dialog } from '../components/Dialog';
import { BacktestPanel } from './BacktestPanel';
import { BudgetCalculator } from './BudgetCalculator';
import { NestedBadge, StatusBadge } from './ConglomeratesListPage';

// ─── Positions table ────────────────────────────────────────────────────────

function PositionsFrame({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="px-3 py-2">
              {t('workboard.detail.assetHeader')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('workboard.detail.weightHeader')}
            </th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function PositionsTable({ positions }: { positions: ConglomerateConstituent[] }) {
  const t = useT();
  if (positions.length === 0) {
    return (
      <EmptyState
        icon="➕"
        title={t('workboard.detail.noPositionsTitle')}
        description={t('workboard.detail.noPositionsDescription')}
      />
    );
  }

  return (
    <PositionsFrame>
      {positions.map((p) => (
        <tr
          key={p.kind === 'asset' ? p.assetId : p.childId}
          className="border-b border-neutral-800 last:border-b-0"
        >
          <td className="px-3 py-3">
            {p.kind === 'asset' ? (
              <>
                <span className="font-mono text-sm font-medium text-neutral-100">
                  {p.asset.symbol}
                </span>
                <p className="max-w-[16rem] truncate text-xs text-neutral-500" title={p.asset.name}>
                  {p.asset.name}
                </p>
              </>
            ) : (
              <>
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-neutral-100">
                    {p.child.name}
                  </span>
                  <NestedBadge />
                </span>
                <p className="text-xs text-neutral-500">
                  {p.child.positionCount === 1
                    ? t('workboard.conglomerates.positionCountOne', {
                        count: p.child.positionCount,
                      })
                    : t('workboard.conglomerates.positionCountOther', {
                        count: p.child.positionCount,
                      })}
                </p>
              </>
            )}
          </td>
          <td className="px-3 py-3 text-right text-sm tabular-nums text-neutral-300">
            {formatWeight(p.weightPct)}
          </td>
        </tr>
      ))}
    </PositionsFrame>
  );
}

/** The resolved view (V5-P6): flattened effective asset weights. */
function ResolvedPositionsTable({ positions }: { positions: ResolvedConglomeratePosition[] }) {
  return (
    <PositionsFrame>
      {positions.map((p) => (
        <tr key={p.assetId} className="border-b border-neutral-800 last:border-b-0">
          <td className="px-3 py-3">
            <span className="font-mono text-sm font-medium text-neutral-100">{p.asset.symbol}</span>
            <p className="max-w-[16rem] truncate text-xs text-neutral-500" title={p.asset.name}>
              {p.asset.name}
            </p>
          </td>
          <td className="px-3 py-3 text-right text-sm tabular-nums text-neutral-300">
            {formatWeight(p.weightPct)}
          </td>
        </tr>
      ))}
    </PositionsFrame>
  );
}

// ─── Delete confirm dialog ──────────────────────────────────────────────────

function DeleteConfirmDialog({
  name,
  onConfirm,
  onClose,
  pending,
  error,
}: {
  name: string;
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
  error: string | null;
}) {
  const t = useT();
  return (
    <Dialog title={t('workboard.detail.deleteDialogTitle')} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">
          {t('workboard.detail.deleteDialogBody', { name })}
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={pending}
            className="bg-red-700 hover:bg-red-600 disabled:bg-red-900"
          >
            {pending ? t('workboard.detail.deleting') : t('common.delete')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

/**
 * `/workboard/conglomerates/:id` — Conglomerate detail scaffold (PROJECTPLAN.md
 * §6.5, §7.2): header, positions table, allocation donut, the backtest panel
 * (#137), and the Invest Calculator (§6.7, #138).
 */
export function ConglomerateDetailPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['conglomerate', id],
    queryFn: ({ signal }) => getConglomerate(id!, signal),
    enabled: !!id,
  });

  // The flattened effective asset weights (V5-P6): drives the resolved-view
  // toggle and feeds the backtest panel, so a nested basket always previews
  // over its resolved weights.
  const resolvedQuery = useQuery({
    queryKey: ['conglomerate', id, 'resolved'],
    queryFn: ({ signal }) => getResolvedConglomerate(id!, signal),
    enabled: !!id,
  });
  const [view, setView] = useState<'stored' | 'resolved'>('stored');

  const deleteMutation = useMutation({
    mutationFn: () => deleteConglomerate(id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conglomerates'] });
      navigate('/workboard/conglomerates');
    },
  });

  // Deleting a basket that is a constituent of another is blocked server-side
  // (409 CONGLOMERATE_IN_USE) with the parent names in `details` (V5-P6).
  const deleteError: string | null = deleteMutation.isError
    ? (() => {
        const err = deleteMutation.error;
        if (err instanceof ApiError && err.code === 'CONGLOMERATE_IN_USE') {
          const details = err.details as { parents?: Array<{ name?: string }> } | undefined;
          const parents = (details?.parents ?? [])
            .map((p) => p.name)
            .filter((n): n is string => typeof n === 'string');
          if (parents.length > 0) {
            return t('workboard.detail.deleteInUseError', { parents: parents.join(', ') });
          }
        }
        return t('workboard.detail.deleteError');
      })()
    : null;

  // Friend-sharing toggle (§6.9, V2-P9): mirrors the portfolio private↔friends model.
  const [shareError, setShareError] = useState(false);
  const shareMutation = useMutation({
    mutationFn: (visibility: 'private' | 'friends') => updateConglomerate(id!, { visibility }),
    onSuccess: () => {
      setShareError(false);
      void queryClient.invalidateQueries({ queryKey: ['conglomerate', id] });
      void queryClient.invalidateQueries({ queryKey: ['social', 'my-shared'] });
    },
    onError: () => setShareError(true),
  });

  if (!id) return null;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-64" />
        <Skeleton height="h-40" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/workboard/conglomerates" className="text-sm text-sky-400 hover:underline">
          {t('workboard.detail.backToConglomeratesError')}
        </Link>
        <Alert tone="error">{t('workboard.detail.loadError')}</Alert>
      </div>
    );
  }

  const resolved = resolvedQuery.data;
  const showResolved = view === 'resolved' && !!resolved;

  const donutData = showResolved
    ? resolved.positions.map((p) => ({ label: p.asset.symbol, value: p.weightPct }))
    : data.positions
        .filter((p) => p.weightPct > 0)
        .map((p) => ({
          label: p.kind === 'asset' ? p.asset.symbol : p.child.name,
          value: p.weightPct,
        }));

  // The backtest always runs over the resolved effective asset weights: for a
  // flat basket they equal its own weights (normalized), and a nested basket's
  // stored rows are not runnable positions (V5-P6).
  const backtestPositions: BacktestPreviewPosition[] = (resolved?.positions ?? []).map((p) => ({
    assetId: p.assetId,
    weight: p.weightPct,
  }));

  const positionCountText =
    data.positionCount === 1
      ? t('workboard.conglomerates.positionCountOne', { count: data.positionCount })
      : t('workboard.conglomerates.positionCountOther', { count: data.positionCount });

  return (
    <div className="flex flex-col gap-8">
      <Link
        to="/workboard/conglomerates"
        className="text-sm text-neutral-500 hover:text-neutral-300"
      >
        {t('workboard.detail.backLink')}
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">{data.name}</h1>
            <StatusBadge status={data.status} />
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                shareMutation.mutate(data.visibility === 'friends' ? 'private' : 'friends')
              }
              disabled={shareMutation.isPending}
              aria-pressed={data.visibility === 'friends'}
            >
              {data.visibility === 'friends'
                ? t('workboard.detail.sharedButton')
                : t('workboard.detail.shareButton')}
            </Button>
            <Link to={`/workboard/conglomerates/${id}/edit`}>
              <Button variant="secondary">{t('common.edit')}</Button>
            </Link>
            <Button variant="secondary" onClick={() => setConfirmOpen(true)}>
              {t('common.delete')}
            </Button>
          </div>
        </div>
        <p className="text-sm text-neutral-400">{positionCountText}</p>
        {data.description ? <p className="text-sm text-neutral-500">{data.description}</p> : null}
        {shareError ? <Alert tone="error">{t('workboard.detail.shareError')}</Alert> : null}
      </div>

      {/* Positions + allocation */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section aria-labelledby="positions-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="positions-heading" className="text-base font-semibold text-neutral-200">
              {t('workboard.detail.positionsHeading')}
            </h2>
            {resolved?.nested ? (
              <div
                role="group"
                aria-label={t('workboard.detail.viewToggleAriaLabel')}
                className="inline-flex rounded-md ring-1 ring-inset ring-neutral-700"
              >
                {(['stored', 'resolved'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    aria-pressed={view === v}
                    className={cx(
                      'px-2.5 py-1 text-xs font-medium first:rounded-l-md last:rounded-r-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                      view === v
                        ? 'bg-neutral-700 text-neutral-100'
                        : 'text-neutral-400 hover:text-neutral-200',
                    )}
                  >
                    {v === 'stored'
                      ? t('workboard.detail.viewStored')
                      : t('workboard.detail.viewResolved')}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {resolvedQuery.isError ? (
            <Alert tone="error">{t('workboard.detail.resolvedLoadError')}</Alert>
          ) : null}
          {showResolved && resolved ? (
            <>
              <p className="text-xs text-neutral-500">{t('workboard.detail.resolvedHint')}</p>
              <ResolvedPositionsTable positions={resolved.positions} />
            </>
          ) : (
            <PositionsTable positions={data.positions} />
          )}
        </section>
        <section aria-labelledby="allocation-heading" className="flex flex-col gap-3">
          <h2 id="allocation-heading" className="text-base font-semibold text-neutral-200">
            {t('workboard.detail.allocationHeading')}
          </h2>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <AllocationDonut data={donutData} title={t('workboard.detail.allocationChartTitle')} />
          </div>
        </section>
      </div>

      {/* Backtest panel (#137) */}
      <section aria-labelledby="backtest-heading" className="flex flex-col gap-3">
        <h2 id="backtest-heading" className="text-base font-semibold text-neutral-200">
          {t('workboard.detail.backtestHeading')}
        </h2>
        <BacktestPanel
          positions={backtestPositions}
          source={{ kind: 'conglomerate', conglomerateId: id }}
        />
      </section>

      {/* Invest Calculator (§6.7, #138) */}
      <section aria-labelledby="calculator-heading" className="flex flex-col gap-3">
        <h2 id="calculator-heading" className="text-base font-semibold text-neutral-200">
          {t('workboard.detail.calculatorHeading')}
        </h2>
        <BudgetCalculator conglomerateId={id} />
      </section>

      {confirmOpen ? (
        <DeleteConfirmDialog
          name={data.name}
          onConfirm={() => deleteMutation.mutate()}
          onClose={() => setConfirmOpen(false)}
          pending={deleteMutation.isPending}
          error={deleteError}
        />
      ) : null}
    </div>
  );
}

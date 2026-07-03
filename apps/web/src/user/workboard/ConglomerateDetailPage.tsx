import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type {
  BacktestPreviewPosition,
  ConglomeratePositionWithAsset,
} from '@bettertrack/contracts';

import { deleteConglomerate, getConglomerate } from '../../lib/conglomerateApi';
import { formatWeight } from '../../lib/format';
import { EmptyState, Skeleton } from '../../ui';
import { AllocationDonut } from '../../ui/charts';
import { Alert, Button } from '../components/ui';
import { Dialog } from '../components/Dialog';
import { BacktestPanel } from './BacktestPanel';
import { StatusBadge } from './ConglomeratesListPage';

// ─── Positions table ────────────────────────────────────────────────────────

function PositionsTable({ positions }: { positions: ConglomeratePositionWithAsset[] }) {
  if (positions.length === 0) {
    return (
      <EmptyState
        icon="➕"
        title="No positions yet"
        description="Add assets and weights in the Builder to start allocating this basket."
      />
    );
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
              Weight
            </th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.assetId} className="border-b border-neutral-800 last:border-b-0">
              <td className="px-3 py-3">
                <span className="font-mono text-sm font-medium text-neutral-100">
                  {p.asset.symbol}
                </span>
                <p className="max-w-[16rem] truncate text-xs text-neutral-500" title={p.asset.name}>
                  {p.asset.name}
                </p>
              </td>
              <td className="px-3 py-3 text-right text-sm tabular-nums text-neutral-300">
                {formatWeight(p.weightPct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Placeholder slots ──────────────────────────────────────────────────────

function PlaceholderSlot({ title, description }: { title: string; description: string }) {
  return (
    <section aria-labelledby={`${title}-heading`} className="flex flex-col gap-3">
      <h2 id={`${title}-heading`} className="text-base font-semibold text-neutral-200">
        {title}
      </h2>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-6">
        <EmptyState title={description} />
      </div>
    </section>
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
  error: boolean;
}) {
  return (
    <Dialog title="Delete Conglomerate?" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">
          This permanently deletes <span className="font-medium text-neutral-200">{name}</span> and
          all its positions. This cannot be undone.
        </p>
        {error ? (
          <Alert tone="error">Could not delete this Conglomerate. Please try again.</Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={pending}
            className="bg-red-700 hover:bg-red-600 disabled:bg-red-900"
          >
            {pending ? 'Deleting…' : 'Delete'}
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
 * (#137), and a placeholder slot for the Invest Calculator (#132/#138) landing
 * in a follow-up issue.
 */
export function ConglomerateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['conglomerate', id],
    queryFn: ({ signal }) => getConglomerate(id!, signal),
    enabled: !!id,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteConglomerate(id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conglomerates'] });
      navigate('/workboard/conglomerates');
    },
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
          ← Back to Conglomerates
        </Link>
        <Alert tone="error">
          Could not load this Conglomerate. It may not exist or the server is temporarily
          unavailable.
        </Alert>
      </div>
    );
  }

  const donutData = data.positions
    .filter((p) => p.weightPct > 0)
    .map((p) => ({ label: p.asset.symbol, value: p.weightPct }));

  const backtestPositions: BacktestPreviewPosition[] = data.positions
    .filter((p) => p.weightPct > 0)
    .map((p) => ({ assetId: p.assetId, weight: p.weightPct }));

  return (
    <div className="flex flex-col gap-8">
      <Link
        to="/workboard/conglomerates"
        className="text-sm text-neutral-500 hover:text-neutral-300"
      >
        ← Conglomerates
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">{data.name}</h1>
            <StatusBadge status={data.status} />
          </div>
          <div className="flex gap-2">
            <Link to={`/workboard/conglomerates/${id}/edit`}>
              <Button variant="secondary">Edit</Button>
            </Link>
            <Button variant="secondary" onClick={() => setConfirmOpen(true)}>
              Delete
            </Button>
          </div>
        </div>
        <p className="text-sm text-neutral-400">
          {data.positionCount} {data.positionCount === 1 ? 'position' : 'positions'}
        </p>
        {data.description ? <p className="text-sm text-neutral-500">{data.description}</p> : null}
      </div>

      {/* Positions + allocation */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section aria-labelledby="positions-heading" className="flex flex-col gap-3">
          <h2 id="positions-heading" className="text-base font-semibold text-neutral-200">
            Positions
          </h2>
          <PositionsTable positions={data.positions} />
        </section>
        <section aria-labelledby="allocation-heading" className="flex flex-col gap-3">
          <h2 id="allocation-heading" className="text-base font-semibold text-neutral-200">
            Allocation
          </h2>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <AllocationDonut data={donutData} title="Conglomerate allocation" />
          </div>
        </section>
      </div>

      {/* Backtest panel (#137) */}
      <section aria-labelledby="backtest-heading" className="flex flex-col gap-3">
        <h2 id="backtest-heading" className="text-base font-semibold text-neutral-200">
          Backtest
        </h2>
        <BacktestPanel positions={backtestPositions} />
      </section>

      {/* Placeholder slot for the follow-up Invest Calculator issue */}
      <PlaceholderSlot
        title="Calculator"
        description="Calculator — coming with the Invest Calculator."
      />

      {confirmOpen ? (
        <DeleteConfirmDialog
          name={data.name}
          onConfirm={() => deleteMutation.mutate()}
          onClose={() => setConfirmOpen(false)}
          pending={deleteMutation.isPending}
          error={deleteMutation.isError}
        />
      ) : null}
    </div>
  );
}

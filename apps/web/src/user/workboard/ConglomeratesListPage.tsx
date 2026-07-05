import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { ConglomerateStatus, ConglomerateSummary } from '@bettertrack/contracts';

import { listConglomerates } from '../../lib/conglomerateApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert } from '../components/ui';

const STATUS_LABEL: Record<ConglomerateStatus, string> = {
  draft: 'Draft',
  active: 'Active',
};

const STATUS_CLASS: Record<ConglomerateStatus, string> = {
  draft: 'bg-neutral-800 text-neutral-400 ring-neutral-700',
  active: 'bg-emerald-950/60 text-emerald-400 ring-emerald-800',
};

/**
 * What "Active" means (§6.5, §13.2 V2-P7): shared across Builder, Detail and
 * List so an owner-naive user gets the same explanation everywhere.
 */
const STATUS_EXPLAINER: Record<ConglomerateStatus, string> = {
  draft: 'Draft — not used by the calculator yet. Activate once weights sum to 100%.',
  active: 'Active — your live, validated basket used by the calculator. Weights sum to 100%.',
};

export function StatusBadge({ status }: { status: ConglomerateStatus }) {
  return (
    <span
      title={STATUS_EXPLAINER[status]}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function ConglomerateCard({ conglomerate }: { conglomerate: ConglomerateSummary }) {
  return (
    <Link
      to={`/workboard/conglomerates/${conglomerate.id}`}
      className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 transition-colors hover:border-neutral-700 hover:bg-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-base font-semibold text-neutral-100">
          {conglomerate.name}
        </h3>
        <StatusBadge status={conglomerate.status} />
      </div>
      <p className="text-sm text-neutral-500">
        {conglomerate.positionCount} {conglomerate.positionCount === 1 ? 'position' : 'positions'}
      </p>
    </Link>
  );
}

function NewConglomerateCard() {
  return (
    <Link
      to="/workboard/conglomerates/new"
      className="flex min-h-[104px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-neutral-700 p-4 text-center text-sm text-neutral-400 transition-colors hover:border-sky-500 hover:text-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      <span className="text-xl" aria-hidden="true">
        +
      </span>
      <span className="font-medium">New Conglomerate</span>
    </Link>
  );
}

/**
 * `/workboard/conglomerates` — the caller's Conglomerates as a card grid
 * (PROJECTPLAN.md §6.5, §7.2). The Builder (`/new`, `/:id/edit`) is a separate
 * issue; the "New Conglomerate" card links there ahead of that route landing.
 */
export function ConglomeratesListPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['conglomerates'],
    queryFn: ({ signal }) => listConglomerates(signal),
    staleTime: 30_000,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Conglomerates</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Your custom ETF-style baskets — build, backtest and turn a budget into a buy list.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton height="h-[104px]" />
          <Skeleton height="h-[104px]" />
          <Skeleton height="h-[104px]" />
        </div>
      ) : isError ? (
        <Alert tone="error">Could not load your Conglomerates. Please refresh the page.</Alert>
      ) : data!.conglomerates.length === 0 ? (
        <EmptyState
          icon="📊"
          title="No Conglomerates yet"
          description="Build a custom ETF-style basket, backtest it and turn a budget into a buy list."
          cta={
            <Link
              to="/workboard/conglomerates/new"
              className="rounded text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              New Conglomerate →
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data!.conglomerates.map((c) => (
            <ConglomerateCard key={c.id} conglomerate={c} />
          ))}
          <NewConglomerateCard />
        </div>
      )}
    </div>
  );
}

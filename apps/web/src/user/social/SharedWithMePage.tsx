import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { listSharedWithMe } from '../../lib/socialApi';
import { EmptyState, MoneyText, Skeleton } from '../../ui';
import { Alert } from '../components/ui';

const SHARED_STALE_MS = 30_000;

/**
 * Shared With Me (PROJECTPLAN.md §6.9 point 4) — the friend-shared portfolios
 * currently visible to the caller, each opening a read-only overview.
 */
export function SharedWithMePage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['social', 'shared'],
    queryFn: ({ signal }) => listSharedWithMe(signal),
    staleTime: SHARED_STALE_MS,
  });

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-6" width="w-48" />
        <Skeleton height="h-16" />
        <Skeleton height="h-16" />
      </section>
    );
  }

  if (isError || !data) {
    return <Alert tone="error">Could not load shared portfolios. Please refresh the page.</Alert>;
  }

  if (data.portfolios.length === 0) {
    return (
      <EmptyState
        title="Nothing shared with you yet"
        description="When a friend turns sharing on for a portfolio, it appears here."
      />
    );
  }

  return (
    <ul className="divide-y divide-neutral-800">
      {data.portfolios.map((p) => (
        <li key={p.portfolioId} className="py-3">
          <Link
            to={`/social/shared-with-me/${p.portfolioId}`}
            className="flex items-center justify-between gap-3 rounded px-1 py-1 hover:bg-neutral-900/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-neutral-100">{p.name}</p>
              <p className="truncate text-xs text-neutral-500">{p.owner.username}</p>
            </div>
            <MoneyText amount={p.totalValueEur} className="shrink-0 text-sm font-medium" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

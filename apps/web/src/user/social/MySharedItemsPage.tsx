import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { updateConglomerate } from '../../lib/conglomerateApi';
import { updatePortfolio } from '../../lib/portfolioApi';
import { listMyShared } from '../../lib/socialApi';
import { updateWatchlistSharing } from '../../lib/workboardApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button } from '../components/ui';

const MY_SHARED_STALE_MS = 30_000;
const MY_SHARED_KEY = ['social', 'my-shared'] as const;

function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{children}</h3>
  );
}

/**
 * My Shared Items (PROJECTPLAN.md §6.9 point 5, §13.2 V2-P9) — everything the
 * caller currently shares (portfolios, conglomerates, watchlist) with a quick
 * toggle-off back to private on each.
 */
export function MySharedItemsPage() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: MY_SHARED_KEY,
    queryFn: ({ signal }) => listMyShared(signal),
    staleTime: MY_SHARED_STALE_MS,
  });

  const invalidate = () => {
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: MY_SHARED_KEY });
  };

  const portfolioOff = useMutation({
    mutationFn: (portfolioId: string) => updatePortfolio(portfolioId, { visibility: 'private' }),
    onSuccess: invalidate,
    onError: () => setActionError('Could not stop sharing that portfolio. Please try again.'),
  });
  const conglomerateOff = useMutation({
    mutationFn: (id: string) => updateConglomerate(id, { visibility: 'private' }),
    onSuccess: invalidate,
    onError: () => setActionError('Could not stop sharing that conglomerate. Please try again.'),
  });
  const watchlistOff = useMutation({
    mutationFn: () => updateWatchlistSharing('private'),
    onSuccess: invalidate,
    onError: () => setActionError('Could not stop sharing your watchlist. Please try again.'),
  });

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-6" width="w-48" />
        <Skeleton height="h-16" />
      </section>
    );
  }

  if (isError || !data) {
    return <Alert tone="error">Could not load your shared items. Please refresh the page.</Alert>;
  }

  const sharesWatchlist = data.watchlist.visibility === 'friends';
  const nothing =
    data.portfolios.length === 0 && data.conglomerates.length === 0 && !sharesWatchlist;

  if (nothing) {
    return (
      <EmptyState
        title="You're not sharing anything"
        description="Turn sharing on for a portfolio, conglomerate or watchlist to have it appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      {data.portfolios.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>Portfolios</SectionHeading>
          <ul className="divide-y divide-neutral-800">
            {data.portfolios.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                <span className="text-sm font-medium text-neutral-100">{p.name}</span>
                <Button
                  variant="secondary"
                  onClick={() => portfolioOff.mutate(p.id)}
                  disabled={portfolioOff.isPending && portfolioOff.variables === p.id}
                >
                  {portfolioOff.isPending && portfolioOff.variables === p.id
                    ? 'Stopping…'
                    : 'Stop sharing'}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.conglomerates.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>Conglomerates</SectionHeading>
          <ul className="divide-y divide-neutral-800">
            {data.conglomerates.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-3">
                <span className="text-sm font-medium text-neutral-100">{c.name}</span>
                <Button
                  variant="secondary"
                  onClick={() => conglomerateOff.mutate(c.id)}
                  disabled={conglomerateOff.isPending && conglomerateOff.variables === c.id}
                >
                  {conglomerateOff.isPending && conglomerateOff.variables === c.id
                    ? 'Stopping…'
                    : 'Stop sharing'}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sharesWatchlist ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>Watchlist</SectionHeading>
          <ul className="divide-y divide-neutral-800">
            <li className="flex items-center justify-between gap-3 py-3">
              <span className="text-sm font-medium text-neutral-100">
                My watchlist ({data.watchlist.itemCount}{' '}
                {data.watchlist.itemCount === 1 ? 'asset' : 'assets'})
              </span>
              <Button
                variant="secondary"
                onClick={() => watchlistOff.mutate()}
                disabled={watchlistOff.isPending}
              >
                {watchlistOff.isPending ? 'Stopping…' : 'Stop sharing'}
              </Button>
            </li>
          </ul>
        </section>
      ) : null}
    </div>
  );
}

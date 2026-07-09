import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { getSharedWatchlist } from '../../lib/socialApi';
import { EmptyState, Skeleton } from '../../ui';

const SHARED_STALE_MS = 30_000;

/**
 * Read-only view of a friend's shared watchlist (PROJECTPLAN.md §6.9, §13.2
 * V2-P9): the watched assets, no edit affordance. A non-friend / not-sharing /
 * unknown owner 404s and surfaces the not-found affordance.
 */
export function SharedWatchlistPage() {
  const { watchlistId = '' } = useParams<{ watchlistId: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['social', 'shared', 'watchlist', watchlistId],
    queryFn: ({ signal }) => getSharedWatchlist(watchlistId, signal),
    staleTime: SHARED_STALE_MS,
    retry: false,
  });

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-8" width="w-64" />
        <Skeleton height="h-24" />
      </section>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState
          title="This watchlist isn't available"
          description="The owner may have stopped sharing it, or you're no longer friends."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <BackLink />
        <h2 className="text-lg font-semibold text-neutral-100">
          {data.owner.username}&rsquo;s {data.name}
        </h2>
      </div>

      {data.items.length === 0 ? (
        <EmptyState title="Empty watchlist" description="This friend isn't watching any assets." />
      ) : (
        <ul className="divide-y divide-neutral-800">
          {data.items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-100">{item.asset.symbol}</p>
                <p className="truncate text-xs text-neutral-500">{item.asset.name}</p>
              </div>
              {item.asset.exchange ? (
                <span className="shrink-0 text-xs text-neutral-500">{item.asset.exchange}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/social/shared-with-me"
      className="w-fit text-xs text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      ← Shared With Me
    </Link>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { getSharedConglomerate } from '../../lib/socialApi';
import { EmptyState, Skeleton } from '../../ui';

const SHARED_STALE_MS = 30_000;

/**
 * Read-only view of a friend-shared conglomerate (PROJECTPLAN.md §6.9, §13.2
 * V2-P9): its positions with the embedded asset identity, exactly as the owner
 * sees them — no edit affordance anywhere. A non-friend / private / unknown
 * basket 404s and surfaces the not-found affordance.
 */
export function SharedConglomeratePage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['social', 'shared', 'conglomerate', id],
    queryFn: ({ signal }) => getSharedConglomerate(id, signal),
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
          title="This conglomerate isn't available"
          description="The owner may have stopped sharing it, or you're no longer friends."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <BackLink />
        <h2 className="text-lg font-semibold text-neutral-100">{data.name}</h2>
        <p className="text-sm text-neutral-500">
          Shared by {data.owner.username} · {data.status === 'active' ? 'Active' : 'Draft'}
        </p>
        {data.description ? <p className="text-sm text-neutral-400">{data.description}</p> : null}
      </div>

      {data.positions.length === 0 ? (
        <EmptyState title="No positions" description="This conglomerate has no assets yet." />
      ) : (
        <ul className="divide-y divide-neutral-800">
          {data.positions.map((p) => (
            <li key={p.assetId} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-100">{p.asset.symbol}</p>
                <p className="truncate text-xs text-neutral-500">{p.asset.name}</p>
              </div>
              <span className="shrink-0 text-sm font-medium tabular-nums text-neutral-200">
                {p.weightPct.toFixed(1)}%
              </span>
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
      to="/social/friends"
      className="w-fit text-xs text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      ← Friends
    </Link>
  );
}

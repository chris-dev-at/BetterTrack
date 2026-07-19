import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { useT } from '../../i18n';
import { getSharedConglomerate } from '../../lib/socialApi';
import { formatPercent } from '../../lib/format';
import { EmptyState, Skeleton } from '../../ui';
import { CommentThread } from './CommentThread';
import { ItemFollowButton } from './ItemFollowButton';

const SHARED_STALE_MS = 30_000;

/**
 * Read-only view of a friend-shared conglomerate (PROJECTPLAN.md §6.9, §13.2
 * V2-P9): its positions with the embedded asset identity, exactly as the owner
 * sees them — no edit affordance anywhere. A non-friend / private / unknown
 * basket 404s and surfaces the not-found affordance.
 */
export function SharedConglomeratePage() {
  const t = useT();
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
          title={t('social.shared.conglomerateUnavailableTitle')}
          description={t('social.shared.unavailableDescription')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <BackLink />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-neutral-100">{data.name}</h2>
          <ItemFollowButton kind="conglomerate" subjectId={id} ownerId={data.owner.id} />
        </div>
        <p className="text-sm text-neutral-500">
          {t('social.shared.sharedByStatus', {
            username: data.owner.username,
            status:
              data.status === 'active'
                ? t('workboard.conglomerates.status.active')
                : t('workboard.conglomerates.status.draft'),
          })}
        </p>
        {data.description ? <p className="text-sm text-neutral-400">{data.description}</p> : null}
      </div>

      {data.positions.length === 0 ? (
        <EmptyState
          title={t('social.shared.noPositionsTitle')}
          description={t('social.shared.noPositionsDescription')}
        />
      ) : (
        <ul className="divide-y divide-neutral-800">
          {data.positions.map((p) => (
            <li key={p.assetId} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-100">{p.asset.symbol}</p>
                <p className="truncate text-xs text-neutral-500">{p.asset.name}</p>
              </div>
              <span className="shrink-0 text-sm font-medium tabular-nums text-neutral-200">
                {formatPercent(p.weightPct)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <CommentThread kind="conglomerate" subjectId={id} />
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link
      to="/social/friends"
      className="w-fit text-xs text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      {t('social.shared.backToFriends')}
    </Link>
  );
}

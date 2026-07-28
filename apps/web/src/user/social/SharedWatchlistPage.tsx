import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { useT } from '../../i18n';
import { getSharedWatchlist } from '../../lib/socialApi';
import { EmptyState, Skeleton } from '../../ui';
import { PageHead } from '../../ui/origin';
import { CommentThread } from './CommentThread';
import { ItemFollowButton } from './ItemFollowButton';

const SHARED_STALE_MS = 30_000;

/**
 * Read-only view of a friend's shared watchlist (PROJECTPLAN.md §6.9, §13.2
 * V2-P9): the watched assets, no edit affordance. A non-friend / not-sharing /
 * unknown owner 404s and surfaces the not-found affordance.
 */
export function SharedWatchlistPage() {
  const t = useT();
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
          title={t('social.shared.watchlistUnavailableTitle')}
          description={t('social.shared.unavailableDescription')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <BackLink />
      <PageHead
        actions={
          <ItemFollowButton kind="watchlist" subjectId={data.watchlistId} ownerId={data.owner.id} />
        }
        title={
          <>
            {data.owner.username}&rsquo;s {data.name}
          </>
        }
      />

      {data.items.length === 0 ? (
        <EmptyState
          title={t('social.shared.watchlistEmptyTitle')}
          description={t('social.shared.watchlistEmptyDescription')}
        />
      ) : (
        <ul className="bt-band bt-t-rule bt-b-rule flex flex-col">
          {data.items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="bt-row-title truncate">{item.asset.symbol}</p>
                <p className="bt-row-sub truncate">{item.asset.name}</p>
              </div>
              {item.asset.exchange ? (
                <span className="bt-meta shrink-0">{item.asset.exchange}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="bt-section">
        <CommentThread kind="watchlist" subjectId={data.watchlistId} />
      </div>
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link
      to="/social/friends"
      className="bt-link w-fit self-start"
      style={{ fontSize: 12.5, marginBottom: 10 }}
    >
      {t('social.shared.backToFriends')}
    </Link>
  );
}

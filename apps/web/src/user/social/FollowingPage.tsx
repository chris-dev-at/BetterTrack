import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { listFollowing } from '../../lib/socialApi';
import { EmptyState, Skeleton } from '../../ui';
import { Avatar } from '../components/Avatar';
import { Alert } from '../components/ui';
import { FOLLOWING_QUERY_KEY, FollowButton } from './FollowButton';

const FOLLOWING_STALE_MS = 30_000;

/**
 * The "Following" list (#438): the people the caller follows, each opening their
 * public profile and carrying an unfollow control. Following someone opts the
 * caller into `follow.published` news when that person makes a new portfolio,
 * watchlist or conglomerate public. Shares the `['social','following']` query key
 * with every {@link FollowButton}, so a follow/unfollow anywhere reflects here.
 */
export function FollowingPage() {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: FOLLOWING_QUERY_KEY,
    queryFn: ({ signal }) => listFollowing(signal),
    staleTime: FOLLOWING_STALE_MS,
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
    return <Alert tone="error">{t('social.follow.error')}</Alert>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">{t('social.follow.listTitle')}</h2>
        <p className="text-sm text-neutral-500">{t('social.follow.listSubtitle')}</p>
        <p className="text-xs text-neutral-500">
          {t(`social.follow.followingStat.${data.followingCount === 1 ? 'one' : 'other'}`, {
            count: data.followingCount,
          })}
          {' · '}
          {t(`social.follow.followers.${data.followerCount === 1 ? 'one' : 'other'}`, {
            count: data.followerCount,
          })}
        </p>
      </div>

      {data.following.length === 0 ? (
        <EmptyState title={t('social.follow.empty')} description={t('social.follow.emptyHint')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {data.following.map((f) => (
            <li
              key={f.user.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3"
            >
              <Link
                to={`/u/${encodeURIComponent(f.user.username)}`}
                className="flex min-w-0 items-center gap-3"
              >
                <Avatar name={f.user.username} size="md" />
                <span className="truncate text-sm font-medium text-neutral-100">
                  {`@${f.user.username}`}
                </span>
              </Link>
              <FollowButton userId={f.user.id} username={f.user.username} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

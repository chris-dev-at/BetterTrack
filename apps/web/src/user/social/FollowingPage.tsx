import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { FollowedItem } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { listFollowing, listItemFollows, unfollowItem } from '../../lib/socialApi';
import { EmptyState, Skeleton } from '../../ui';
import { Avatar } from '../components/Avatar';
import { Alert } from '../components/ui';
import {
  AlertFollowToggles,
  AutoFollowToggle,
  FOLLOWING_QUERY_KEY,
  FollowButton,
} from './FollowButton';
import { ITEM_FOLLOWS_QUERY_KEY } from './ItemFollowButton';

const FOLLOWING_STALE_MS = 30_000;

/**
 * Where a followed item opens (#439): a friend-visible item on the read-only
 * friend-shared pages, a public one on the owner's public profile — the two
 * existing shared-view surfaces. `viewable: false` rows have no destination.
 */
function followedItemHref(item: FollowedItem): string | null {
  if (!item.viewable || !item.owner || !item.via) return null;
  if (item.via === 'public') return `/u/${encodeURIComponent(item.owner.username)}`;
  if (item.kind === 'portfolio') return `/social/shared-with-me/${item.subjectId}`;
  if (item.kind === 'conglomerate') return `/social/shared-with-me/conglomerates/${item.subjectId}`;
  return `/social/shared-with-me/watchlists/${item.subjectId}`;
}

/**
 * One row of the followed-items collection: kind badge + name + owner, linking
 * into the item's shared view. An item that lost visibility (unshared, narrowed
 * away, deleted) renders as a "gone" shell — the chat-chip precedent — that can
 * only be unfollowed.
 */
function FollowedItemRow({ item }: { item: FollowedItem }) {
  const t = useT();
  const queryClient = useQueryClient();
  const unfollowMutation = useMutation({
    mutationFn: () => unfollowItem(item.kind, item.subjectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ITEM_FOLLOWS_QUERY_KEY }),
  });
  const href = followedItemHref(item);

  const body = (
    <>
      <span className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
        {t(`social.itemFollow.kind.${item.kind}`)}
      </span>
      {item.viewable ? (
        <span className="min-w-0 truncate text-sm font-medium text-neutral-100">
          {item.name}
          {item.owner ? (
            <span className="ml-2 font-normal text-neutral-500">
              {t('social.itemFollow.by', { username: item.owner.username })}
            </span>
          ) : null}
        </span>
      ) : (
        <span
          className="min-w-0 truncate text-sm italic text-neutral-500"
          title={t('social.itemFollow.goneHint')}
        >
          {t('social.itemFollow.gone')}
        </span>
      )}
    </>
  );

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
      {href ? (
        <Link to={href} className="flex min-w-0 items-center gap-3 hover:opacity-90">
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 items-center gap-3">{body}</div>
      )}
      <button
        type="button"
        disabled={unfollowMutation.isPending}
        onClick={() => unfollowMutation.mutate()}
        aria-label={t('social.itemFollow.unfollowAria')}
        className="shrink-0 rounded-md px-3 py-2 text-sm font-medium text-neutral-300 ring-1 ring-inset ring-neutral-700 transition-colors hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60"
      >
        {t('social.itemFollow.unfollow')}
      </button>
    </li>
  );
}

/**
 * The "Following" area (#438/#439): the people the caller follows — each with
 * an unfollow control and the per-person auto-follow-items switch — plus the
 * followed-items collection (bookmarked portfolios, watchlists, conglomerates).
 * Shares the `['social','following']` / `['social','item-follows']` query keys
 * with every follow button, so actions anywhere reflect here.
 */
export function FollowingPage() {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: FOLLOWING_QUERY_KEY,
    queryFn: ({ signal }) => listFollowing(signal),
    staleTime: FOLLOWING_STALE_MS,
  });
  const items = useQuery({
    queryKey: ITEM_FOLLOWS_QUERY_KEY,
    queryFn: ({ signal }) => listItemFollows(signal),
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
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3"
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
              <div className="flex flex-wrap items-center gap-4">
                <AutoFollowToggle userId={f.user.id} username={f.user.username} />
                <AlertFollowToggles userId={f.user.id} username={f.user.username} />
                <FollowButton userId={f.user.id} username={f.user.username} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">
          {t('social.itemFollow.sectionTitle')}
        </h2>
        <p className="text-sm text-neutral-500">{t('social.itemFollow.sectionSubtitle')}</p>
      </div>

      {items.isLoading ? (
        <Skeleton height="h-16" />
      ) : items.isError || !items.data ? (
        <Alert tone="error">{t('social.itemFollow.error')}</Alert>
      ) : items.data.items.length === 0 ? (
        <EmptyState
          title={t('social.itemFollow.empty')}
          description={t('social.itemFollow.emptyHint')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.data.items.map((item) => (
            <FollowedItemRow key={`${item.kind}:${item.subjectId}`} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

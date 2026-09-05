import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { FollowedItem, FollowingEntry } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { listFollowing, listItemFollows, unfollowItem } from '../../lib/socialApi';
import { EmptyState } from '../../ui';
import { Badge, Button, PageHead, SectionHead, SkeletonBlock } from '../../ui/origin';
import { Avatar } from '../components/Avatar';
import { Alert } from '../components/ui';
import { FOLLOWING_QUERY_KEY, FollowButton } from './FollowButton';
import { ITEM_FOLLOWS_QUERY_KEY } from './ItemFollowButton';

const FOLLOWING_STALE_MS = 30_000;

/**
 * Followed items reuse the existing friend-shared and public-profile readers.
 * The API decides which route is safe through `via`; an item that is no longer
 * visible deliberately has no destination.
 */
export function followedItemHref(item: FollowedItem): string | null {
  if (!item.viewable || !item.owner || !item.via) return null;
  if (item.via === 'public') return `/u/${encodeURIComponent(item.owner.username)}`;

  const id = encodeURIComponent(item.subjectId);
  switch (item.kind) {
    case 'portfolio':
      return `/people/shared/${id}`;
    case 'conglomerate':
      return `/people/shared/conglomerates/${id}`;
    case 'watchlist':
      return `/people/shared/watchlists/${id}`;
    case 'idea':
      return `/people/shared/ideas/${id}`;
  }
}

function LoadingRows() {
  const t = useT();
  return (
    <div aria-label={t('common.loadingLabel')} className="flex flex-col gap-2" role="status">
      <SkeletonBlock height={58} />
      <SkeletonBlock height={58} />
    </div>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-start gap-2">
      <Alert tone="error">{message}</Alert>
      <Button onClick={onRetry} size="sm">
        {t('common.retry')}
      </Button>
    </div>
  );
}

function FollowedPersonRow({ entry }: { entry: FollowingEntry }) {
  const { user } = entry;
  return (
    <li className="bt-band__row flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
      <Link
        className="flex min-w-0 items-center gap-3"
        to={`/u/${encodeURIComponent(user.username)}`}
      >
        <Avatar iconId={user.profileIcon} name={user.username} size="md" />
        <span className="bt-row-title truncate">{`@${user.username}`}</span>
      </Link>
      <div className="flex shrink-0 justify-end">
        <FollowButton userId={user.id} username={user.username} />
      </div>
    </li>
  );
}

function FollowedItemRow({ item }: { item: FollowedItem }) {
  const t = useT();
  const queryClient = useQueryClient();
  const unfollowMutation = useMutation({
    mutationFn: () => unfollowItem(item.kind, item.subjectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ITEM_FOLLOWS_QUERY_KEY });
    },
  });
  const href = followedItemHref(item);
  const available =
    href !== null && item.name !== null && item.owner !== null
      ? { href, name: item.name, owner: item.owner }
      : null;

  const identity = (
    <>
      <Badge className="shrink-0" outline>
        {t(`social.itemFollow.kind.${item.kind}`)}
      </Badge>
      {/* The item's owner carries the same face here as in the followed-PEOPLE
          row above — inline before the name, so the row gains no height. */}
      {available !== null ? (
        <Avatar
          className="shrink-0"
          iconId={available.owner.profileIcon}
          name={available.owner.username}
          size="sm"
        />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        {available !== null ? (
          <>
            <span className="bt-row-title truncate">{available.name}</span>
            <span className="bt-row-sub truncate">
              {t('social.itemFollow.by', { username: available.owner.username })}
            </span>
          </>
        ) : (
          <span className="bt-row-sub truncate italic" title={t('social.itemFollow.goneHint')}>
            {t('social.itemFollow.gone')}
          </span>
        )}
      </span>
    </>
  );

  return (
    <li className="bt-band__row flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
      {available !== null ? (
        <Link className="flex min-w-0 flex-1 items-center gap-3" to={available.href}>
          {identity}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{identity}</div>
      )}
      <Button
        aria-label={
          available === null
            ? t('social.itemFollow.unfollowAria')
            : t('social.itemFollow.unfollowNamedAria', { name: available.name })
        }
        disabled={unfollowMutation.isPending}
        onClick={() => unfollowMutation.mutate()}
        size="sm"
        variant="quiet"
      >
        {t('social.itemFollow.unfollow')}
      </Button>
      {unfollowMutation.isError ? (
        <Alert tone="error">{t('social.itemFollow.unfollowError')}</Alert>
      ) : null}
    </li>
  );
}

/** `/people/following` — the caller's followed people and visibility-safe items. */
export function FollowingPage() {
  const t = useT();
  const people = useQuery({
    queryKey: FOLLOWING_QUERY_KEY,
    queryFn: ({ signal }) => listFollowing(signal),
    staleTime: FOLLOWING_STALE_MS,
  });
  const items = useQuery({
    queryKey: ITEM_FOLLOWS_QUERY_KEY,
    queryFn: ({ signal }) => listItemFollows(signal),
    staleTime: FOLLOWING_STALE_MS,
  });

  return (
    <div className="bt-phone-surface flex flex-col">
      <PageHead sub={t('social.follow.listSubtitle')} title={t('social.follow.listTitle')} />

      <div className="flex flex-col gap-8">
        <section aria-label={t('social.follow.listTitle')} className="flex flex-col gap-3">
          {people.isLoading ? (
            <LoadingRows />
          ) : people.isError || !people.data ? (
            <LoadError message={t('social.follow.error')} onRetry={() => void people.refetch()} />
          ) : people.data.following.length === 0 ? (
            <EmptyState
              title={t('social.follow.empty')}
              description={t('social.follow.emptyHint')}
            />
          ) : (
            <ul className="bt-band flex flex-col">
              {people.data.following.map((entry) => (
                <FollowedPersonRow entry={entry} key={entry.user.id} />
              ))}
            </ul>
          )}
        </section>

        <section aria-label={t('social.itemFollow.sectionTitle')} className="bt-section">
          <SectionHead
            sub={t('social.itemFollow.sectionSubtitle')}
            title={t('social.itemFollow.sectionTitle')}
          />
          {items.isLoading ? (
            <LoadingRows />
          ) : items.isError || !items.data ? (
            <LoadError
              message={t('social.itemFollow.error')}
              onRetry={() => void items.refetch()}
            />
          ) : items.data.items.length === 0 ? (
            <EmptyState
              title={t('social.itemFollow.empty')}
              description={t('social.itemFollow.emptyHint')}
            />
          ) : (
            <ul className="bt-band flex flex-col">
              {items.data.items.map((item) => (
                <FollowedItemRow item={item} key={`${item.kind}:${item.subjectId}`} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

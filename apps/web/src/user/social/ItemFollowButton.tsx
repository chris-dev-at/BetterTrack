import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ShareKind } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { followItem, listItemFollows, unfollowItem } from '../../lib/socialApi';
import { useOptionalAuth } from '../AuthContext';

/** Shared query key for "items I follow" — one deduped fetch across buttons + the list. */
export const ITEM_FOLLOWS_QUERY_KEY = ['social', 'item-follows'] as const;

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60';

function BookmarkIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        d="M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18l-6-4-6 4V4z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Follow/unfollow (bookmark) control for another user's visible item (#439),
 * mirroring {@link FollowButton}'s shape: one deduped `['social','item-follows']`
 * query feeds every button, and mutations invalidate that key so the Following
 * collection stays in sync. Rendered only for a logged-in viewer who isn't the
 * item's owner — the server independently re-checks both, plus visibility.
 */
export function ItemFollowButton({
  kind,
  subjectId,
  ownerId,
  className,
}: {
  kind: ShareKind;
  subjectId: string;
  /** The item owner — the button hides on the caller's own items. */
  ownerId?: string;
  className?: string;
}) {
  const t = useT();
  const auth = useOptionalAuth();
  const queryClient = useQueryClient();
  const authenticated = auth?.status === 'authenticated';
  const isOwn = ownerId !== undefined && auth?.user?.id === ownerId;

  const followsQuery = useQuery({
    queryKey: ITEM_FOLLOWS_QUERY_KEY,
    queryFn: ({ signal }) => listItemFollows(signal),
    enabled: authenticated && !isOwn,
    staleTime: 30_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ITEM_FOLLOWS_QUERY_KEY });
  const followMutation = useMutation({
    mutationFn: () => followItem(kind, subjectId),
    onSuccess: invalidate,
  });
  const unfollowMutation = useMutation({
    mutationFn: () => unfollowItem(kind, subjectId),
    onSuccess: invalidate,
  });

  // Your own item is never followable; a logged-out visitor has no bookmarks.
  if (!authenticated || isOwn) return null;

  const isFollowing =
    followsQuery.data?.items.some((i) => i.kind === kind && i.subjectId === subjectId) ?? false;
  const busy = followMutation.isPending || unfollowMutation.isPending;

  if (isFollowing) {
    return (
      <button
        type="button"
        disabled={busy}
        aria-label={t('social.itemFollow.unfollowAria')}
        onClick={() => unfollowMutation.mutate()}
        className={`${BUTTON_BASE} bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-700 ${className ?? ''}`}
      >
        <BookmarkIcon filled />
        {t('social.itemFollow.following')}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={t('social.itemFollow.followAria')}
      onClick={() => followMutation.mutate()}
      className={`${BUTTON_BASE} bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-700 ${className ?? ''}`}
    >
      <BookmarkIcon filled={false} />
      {t('social.itemFollow.follow')}
    </button>
  );
}

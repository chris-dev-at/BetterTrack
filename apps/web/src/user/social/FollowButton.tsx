import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useT } from '../../i18n';
import { followUser, listFollowing, unfollowUser } from '../../lib/socialApi';
import { useOptionalAuth } from '../AuthContext';

/** Shared query key for "who I follow" — one deduped fetch across every button + the list. */
export const FOLLOWING_QUERY_KEY = ['social', 'following'] as const;

/**
 * Follow / unfollow control for a person (#438), reused on the public profile and
 * the friend surfaces. It reads the caller's following set from ONE deduped
 * `['social','following']` query (so many buttons on a page share a single fetch),
 * and its mutations invalidate that key so every button + the Following list stay
 * in sync. Renders nothing for a logged-out visitor or the caller's own row —
 * following requires an authenticated, distinct target.
 */
export function FollowButton({
  userId,
  username,
  className,
}: {
  userId: string;
  username: string;
  className?: string;
}) {
  const t = useT();
  const auth = useOptionalAuth();
  const queryClient = useQueryClient();
  const authenticated = auth?.status === 'authenticated';
  const isSelf = auth?.user?.id === userId;

  const followingQuery = useQuery({
    queryKey: FOLLOWING_QUERY_KEY,
    queryFn: ({ signal }) => listFollowing(signal),
    enabled: authenticated && !isSelf,
    staleTime: 30_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: FOLLOWING_QUERY_KEY });
  const followMutation = useMutation({
    mutationFn: () => followUser(userId),
    onSuccess: invalidate,
  });
  const unfollowMutation = useMutation({
    mutationFn: () => unfollowUser(userId),
    onSuccess: invalidate,
  });

  // No follow control for logged-out visitors or the caller's own profile/row.
  if (!authenticated || isSelf) return null;

  const isFollowing = followingQuery.data?.following.some((f) => f.user.id === userId) ?? false;
  const busy = followMutation.isPending || unfollowMutation.isPending;

  const base =
    'inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60';

  if (isFollowing) {
    return (
      <button
        type="button"
        disabled={busy}
        aria-label={t('social.follow.unfollowAria', { username })}
        onClick={() => unfollowMutation.mutate()}
        className={`${base} bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-700 ${className ?? ''}`}
      >
        {t('social.follow.following')}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={t('social.follow.followAria', { username })}
      onClick={() => followMutation.mutate()}
      className={`${base} bg-sky-500 text-white hover:bg-sky-400 ${className ?? ''}`}
    >
      {t('social.follow.follow')}
    </button>
  );
}

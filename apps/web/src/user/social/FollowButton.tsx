import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';

import { useT } from '../../i18n';
import { followUser, listFollowing, unfollowUser, updateFollow } from '../../lib/socialApi';
import { useOptionalAuth } from '../AuthContext';
import { ITEM_FOLLOWS_QUERY_KEY } from './ItemFollowButton';

/** Shared query key for "who I follow" — one deduped fetch across every button + the list. */
export const FOLLOWING_QUERY_KEY = ['social', 'following'] as const;

/** Button/link chrome shared by every state (Follow / Following / Log in to follow). */
const BUTTON_BASE =
  'inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60';

/**
 * Follow / unfollow control for a person (#438), reused on the public profile and
 * the friend surfaces. It reads the caller's following set from ONE deduped
 * `['social','following']` query (so many buttons on a page share a single fetch),
 * and its mutations invalidate that key so every button + the Following list stay
 * in sync. The caller's own row shows nothing; a logged-out visitor (only reached
 * on a public profile) gets a "log in to follow" link that returns them here.
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
  const location = useLocation();
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

  // Never a self-follow control on the caller's own profile/row.
  if (isSelf) return null;

  // Logged-out visitor: send them to sign in and back here (via `state.from`),
  // where the button turns into a real Follow once authenticated.
  if (!authenticated) {
    return (
      <Link
        to="/login"
        state={{ from: `${location.pathname}${location.search}` }}
        className={`${BUTTON_BASE} bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-700 ${className ?? ''}`}
      >
        {t('social.follow.loginToFollow')}
      </Link>
    );
  }

  const isFollowing = followingQuery.data?.following.some((f) => f.user.id === userId) ?? false;
  const busy = followMutation.isPending || unfollowMutation.isPending;

  if (isFollowing) {
    return (
      <button
        type="button"
        disabled={busy}
        aria-label={t('social.follow.unfollowAria', { username })}
        onClick={() => unfollowMutation.mutate()}
        className={`${BUTTON_BASE} bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-700 ${className ?? ''}`}
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
      className={`${BUTTON_BASE} bg-sky-500 text-white hover:bg-sky-400 ${className ?? ''}`}
    >
      {t('social.follow.follow')}
    </button>
  );
}

/**
 * Per-followed-person auto-follow switch (#439): when ON, every item of theirs
 * that becomes newly visible to the caller is auto-added to the caller's
 * followed items (in addition to the follow news). Rendered ONLY while the
 * caller follows the person — it reads its state from the same deduped
 * `['social','following']` query as the FollowButton and PATCHes the follow row,
 * so the button, this switch and the Following list never disagree.
 */
export function AutoFollowToggle({ userId, username }: { userId: string; username: string }) {
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
  const entry = followingQuery.data?.following.find((f) => f.user.id === userId);

  const toggleMutation = useMutation({
    mutationFn: (next: boolean) => updateFollow(userId, { autoFollowItems: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLLOWING_QUERY_KEY });
      // Flipping it ON changes what lands in the followed-items collection next.
      void queryClient.invalidateQueries({ queryKey: ITEM_FOLLOWS_QUERY_KEY });
    },
  });

  if (!authenticated || isSelf || !entry) return null;

  const on = entry.autoFollowItems;
  return (
    <label
      className="flex items-center gap-2 text-xs text-neutral-400"
      title={t('social.follow.autoFollowHint')}
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t('social.follow.autoFollowAria', { username })}
        disabled={toggleMutation.isPending}
        onClick={() => toggleMutation.mutate(!on)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60 ${
          on ? 'bg-sky-600' : 'bg-neutral-700'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            on ? 'translate-x-[18px]' : 'translate-x-1'
          }`}
        />
      </button>
      {t('social.follow.autoFollow')}
    </label>
  );
}

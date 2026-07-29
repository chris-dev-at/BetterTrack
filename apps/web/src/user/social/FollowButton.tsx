import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';

import { useT } from '../../i18n';
import { followUser, listFollowing, unfollowUser, updateFollow } from '../../lib/socialApi';
import { Icon, Switch } from '../../ui/origin';
import { cx } from '../components/ui';
import { useOptionalAuth } from '../AuthContext';
import { ITEM_FOLLOWS_QUERY_KEY } from './ItemFollowButton';

/** Shared query key for "who I follow" — one deduped fetch across every button + the list. */
export const FOLLOWING_QUERY_KEY = ['social', 'following'] as const;

/**
 * Follow / unfollow control for a person (#438), reused on the public profile and
 * the friend surfaces. It reads the caller's following set from ONE deduped
 * `['social','following']` query (so many buttons on a page share a single fetch),
 * and its mutations invalidate that key so every button + the Following list stay
 * in sync. The caller's own row shows nothing; a logged-out visitor (only reached
 * on a public profile) gets a "log in to follow" link that returns them here.
 *
 * Origin styling: the follow state is a *selection*, not a call to action, so it
 * rides the `bt-subtab` / `.is-active` pattern (quiet outline → restrained
 * selected surface with a check) instead of a loud filled button. Gold stays
 * reserved for the one real primary on whatever screen hosts this control.
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
        className={cx('bt-btn bt-btn--sm', className)}
      >
        {t('social.follow.loginToFollow')}
      </Link>
    );
  }

  const isFollowing = followingQuery.data?.following.some((f) => f.user.id === userId) ?? false;
  // Also hold the button while the following set is still loading, so a click
  // can't act on a not-yet-known state (it would flash Follow → Following).
  const busy = followMutation.isPending || unfollowMutation.isPending || followingQuery.isLoading;

  if (isFollowing) {
    return (
      <button
        type="button"
        disabled={busy}
        aria-label={t('social.follow.unfollowAria', { username })}
        onClick={() => unfollowMutation.mutate()}
        className={cx('bt-subtab is-active', className)}
      >
        <Icon name="check" size={14} />
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
      className={cx('bt-subtab', className)}
    >
      <Icon name="plus" size={14} />
      {t('social.follow.follow')}
    </button>
  );
}

/** The switch chrome shared by every per-follow pref toggle (#439/#455). */
function FollowPrefSwitch({
  on,
  disabled,
  ariaLabel,
  hint,
  label,
  onToggle,
}: {
  on: boolean;
  disabled: boolean;
  ariaLabel: string;
  hint: string;
  label: string;
  onToggle: () => void;
}) {
  return (
    <label className="bt-meta flex items-center gap-2" title={hint}>
      <Switch aria-label={ariaLabel} checked={on} disabled={disabled} onChange={onToggle} />
      {label}
    </label>
  );
}

/** The caller's follow row for `userId` off the shared following query, or undefined. */
function useFollowingEntry(userId: string) {
  const auth = useOptionalAuth();
  const authenticated = auth?.status === 'authenticated';
  const isSelf = auth?.user?.id === userId;
  const followingQuery = useQuery({
    queryKey: FOLLOWING_QUERY_KEY,
    queryFn: ({ signal }) => listFollowing(signal),
    enabled: authenticated && !isSelf,
    staleTime: 30_000,
  });
  const entry =
    authenticated && !isSelf
      ? followingQuery.data?.following.find((f) => f.user.id === userId)
      : undefined;
  return entry;
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
  const queryClient = useQueryClient();
  const entry = useFollowingEntry(userId);

  const toggleMutation = useMutation({
    mutationFn: (next: boolean) => updateFollow(userId, { autoFollowItems: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLLOWING_QUERY_KEY });
      // Flipping it ON changes what lands in the followed-items collection next.
      void queryClient.invalidateQueries({ queryKey: ITEM_FOLLOWS_QUERY_KEY });
    },
  });

  if (!entry) return null;

  return (
    <FollowPrefSwitch
      on={entry.autoFollowItems}
      disabled={toggleMutation.isPending}
      ariaLabel={t('social.follow.autoFollowAria', { username })}
      hint={t('social.follow.autoFollowHint')}
      label={t('social.follow.autoFollow')}
      onToggle={() => toggleMutation.mutate(!entry.autoFollowItems)}
    />
  );
}

/**
 * Per-followed-person "Follow their alerts" switch (#455, simplified V4): ONE
 * toggle over the person's alert activity. The server keeps its created/fired
 * granularity, but the UI exposes a single decision — ON subscribes to both
 * (new alerts AND fires), OFF unsubscribes from both; it reads ON whenever
 * either trigger is set (so a legacy one-sided state still shows as following).
 * Notify-only: nothing is copied into the caller's own alert list, and nothing
 * arrives unless the followed person shares their alerts. Rendered ONLY while
 * the caller follows the person AND that person currently shares their alert
 * activity (`sharesAlertActivity`, V4-P0b) — mirroring the former switches, so
 * it never appears when it would deliver nothing — off the same deduped
 * following query as the FollowButton.
 */
export function AlertFollowToggle({ userId, username }: { userId: string; username: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const entry = useFollowingEntry(userId);

  const toggleMutation = useMutation({
    mutationFn: (next: boolean) =>
      updateFollow(userId, { notifyOnAlertCreate: next, notifyOnAlertFire: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLLOWING_QUERY_KEY });
    },
  });

  if (!entry || !entry.sharesAlertActivity) return null;

  const on = entry.notifyOnAlertCreate || entry.notifyOnAlertFire;

  return (
    <FollowPrefSwitch
      on={on}
      disabled={toggleMutation.isPending}
      ariaLabel={t('social.follow.alertFollowAria', { username })}
      hint={t('social.follow.alertFollowHint')}
      label={t('social.follow.alertFollow')}
      onToggle={() => toggleMutation.mutate(!on)}
    />
  );
}

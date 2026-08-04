import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import type { FriendRequest, Friendship, MirrorInvite } from '@bettertrack/contracts';

import {
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  listFriendRequests,
  listFriends,
  listSharedWithMe,
  removeFriend,
  sendFriendRequest,
} from '../../lib/socialApi';
import { useT } from '../../i18n';
import { EmptyState, MoneyText } from '../../ui';
import { Button, Field, Icon, Input, PageHead, SkeletonBlock } from '../../ui/origin';
import { Alert } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { AsyncReadState } from '../components/AsyncReadState';
import { Dialog } from '../components/Dialog';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';
import { AlertFollowToggle, AutoFollowToggle, FollowButton } from './FollowButton';
import { FriendGroupsSection } from './FriendGroupsSection';
import {
  AcceptInviteDialog,
  useMirrorInvites,
  useRevokeMirrorInvite,
} from '../portfolio/MirrorchainPanel';
import {
  ActivityAlertToggle,
  SharedItemRow,
  kindCountSummary,
  personFor,
  type SharedPerson,
} from './SharedPeople';

/** Disclosure chevron for the expandable friend rows. */
function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="chevron-right"
      size={16}
      style={{
        color: 'var(--bt-faint)',
        flex: 'none',
        transform: open ? 'rotate(90deg)' : undefined,
        transition: 'transform var(--bt-t-fast)',
      }}
    />
  );
}

const REQUESTS_STALE_MS = 15_000;
const FRIENDS_STALE_MS = 30_000;

// ─── Add friend ─────────────────────────────────────────────────────────────

// `social.friends.requestSent` is the identical, no-enumeration success message
// shown after every `POST /social/requests` — the backend always answers
// `{ ok: true }` regardless of whether the target exists (PROJECTPLAN.md §6.9),
// so the UI never has a "user not found" branch to surface.
function AddFriendForm() {
  const t = useT();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    null,
  );

  const mutation = useMutation({
    mutationFn: (value: string) => sendFriendRequest({ identifier: value }),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: t('social.friends.requestSent') });
      setIdentifier('');
      void queryClient.invalidateQueries({ queryKey: ['social', 'requests'] });
    },
    onError: () => setFeedback({ tone: 'error', text: t('social.friends.requestError') }),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = identifier.trim();
    if (!trimmed) return;
    setFeedback(null);
    mutation.mutate(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <h2 className="bt-label">{t('social.friends.addTitle')}</h2>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field className="flex-1" htmlFor="identifier" label={t('social.friends.identifierLabel')}>
          <Input
            autoComplete="off"
            id="identifier"
            name="identifier"
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={t('social.friends.identifierPlaceholder')}
            value={identifier}
          />
        </Field>
        <Button disabled={mutation.isPending || !identifier.trim()} type="submit">
          {mutation.isPending ? t('social.friends.sending') : t('social.friends.sendRequest')}
        </Button>
      </div>
      {feedback ? <Alert tone={feedback.tone}>{feedback.text}</Alert> : null}
    </form>
  );
}

// ─── Requests ───────────────────────────────────────────────────────────────

function IncomingRequestRow({
  request,
  onAccept,
  onDecline,
  pendingAction,
}: {
  request: FriendRequest;
  onAccept: () => void;
  onDecline: () => void;
  pendingAction: 'accept' | 'decline' | null;
}) {
  const t = useT();
  const busy = pendingAction !== null;
  return (
    <li className="bt-band__row bt-friend-request-row flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
      <span className="flex min-w-0 items-center gap-3">
        <Avatar name={request.user.username} iconId={request.user.profileIcon} size="sm" />
        <span className="bt-row-title truncate">{request.user.username}</span>
      </span>
      <span className="bt-friend-request-row__actions flex flex-wrap gap-2">
        {/* Accepting is the one action this block exists for — it carries the
            gold; everything beside it stays quiet (Origin: one primary). */}
        <Button disabled={busy} onClick={onAccept} size="sm" variant="primary">
          {pendingAction === 'accept' ? t('social.friends.accepting') : t('social.friends.accept')}
        </Button>
        <Button disabled={busy} onClick={onDecline} size="sm" variant="quiet">
          {pendingAction === 'decline'
            ? t('social.friends.declining')
            : t('social.friends.decline')}
        </Button>
      </span>
    </li>
  );
}

function OutgoingRequestRow({
  request,
  onCancel,
  pending,
}: {
  request: FriendRequest;
  onCancel: () => void;
  pending: boolean;
}) {
  const t = useT();
  return (
    <li className="bt-band__row bt-friend-request-row flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
      <span className="flex min-w-0 items-center gap-3">
        <Avatar name={request.user.username} iconId={request.user.profileIcon} size="sm" />
        <span className="bt-row-title truncate">{request.user.username}</span>
      </span>
      <Button disabled={pending} onClick={onCancel} size="sm" variant="quiet">
        {pending ? t('social.friends.cancelling') : t('common.cancel')}
      </Button>
    </li>
  );
}

/**
 * MIRRORCHAIN group-portfolio invites (V5-P7 M5, design §4 + §11): shows
 * inbound + outbound pending invites in the same Social requests area as
 * friend requests. Accepting opens the §4 one-screen acknowledgment — the
 * confirmation IS the accept (design §4 zero-config).
 */
function MirrorInvitesSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const invitesQuery = useMirrorInvites();
  const revoke = useRevokeMirrorInvite();
  const [acceptTarget, setAcceptTarget] = useState<MirrorInvite | null>(null);

  if (invitesQuery.isLoading) {
    return (
      <div aria-label={t('common.loadingLabel')} className="flex flex-col gap-2" role="status">
        <SkeletonBlock height={14} width={144} />
        <SkeletonBlock height={48} />
      </div>
    );
  }
  if (invitesQuery.isError || !invitesQuery.data) {
    return (
      <AsyncReadState
        loading={false}
        error={invitesQuery.error ?? new Error('Mirror invites returned no data')}
        errorLabel={t('mirrorchain.invites.loadError')}
        onRetry={() => void invitesQuery.refetch()}
      />
    );
  }
  const { incoming, outgoing } = invitesQuery.data;
  if (incoming.length === 0 && outgoing.length === 0) return null;

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['mirror', 'invites'] });
    void queryClient.invalidateQueries({ queryKey: ['mirror', 'chains'] });
    void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
  }

  return (
    <div className="flex flex-col gap-4">
      {incoming.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="bt-label">{t('mirrorchain.invites.incomingTitle')}</h2>
          <ul className="bt-panel bt-band overflow-hidden">
            {incoming.map((invite) => (
              <li
                key={invite.id}
                className="bt-band__row flex flex-wrap items-center justify-between gap-3"
              >
                <span className="bt-meta flex items-center gap-2">
                  {t('mirrorchain.invites.incomingLabel', {
                    inviter: invite.fromUsername ?? t('common.unknown'),
                  })}
                  <span className="bt-row-title">{invite.chainName}</span>
                </span>
                {/* Opens the §4 acknowledgment; the accept itself happens inside
                    that dialog, so this stays neutral and the requests area
                    keeps a single gold action (the friend-request accept). */}
                <Button onClick={() => setAcceptTarget(invite)} size="sm">
                  {t('mirrorchain.invites.openAccept')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {outgoing.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="bt-label">{t('mirrorchain.invites.outgoingTitle')}</h2>
          <ul className="bt-panel bt-band overflow-hidden">
            {outgoing.map((invite) => (
              <li
                key={invite.id}
                className="bt-band__row flex flex-wrap items-center justify-between gap-3"
              >
                <span className="bt-meta flex items-center gap-2">
                  {t('mirrorchain.invites.outgoingLabel', { invitee: invite.toUsername })}
                  <span className="bt-row-title">{invite.chainName}</span>
                </span>
                <Button
                  disabled={revoke.isPending && revoke.variables === invite.id}
                  onClick={() => revoke.mutate(invite.id)}
                  size="sm"
                  variant="quiet"
                >
                  {t('mirrorchain.actions.revokeInvite')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {acceptTarget ? (
        <AcceptInviteDialog
          invite={acceptTarget}
          onClose={() => setAcceptTarget(null)}
          onAccepted={() => {
            setAcceptTarget(null);
            invalidate();
          }}
        />
      ) : null}
    </div>
  );
}

function RequestsSection({ sharingAllowed }: { sharingAllowed: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['social', 'requests'],
    queryFn: ({ signal }) => listFriendRequests(signal),
    staleTime: REQUESTS_STALE_MS,
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['social', 'requests'] });
    void queryClient.invalidateQueries({ queryKey: ['social', 'friends'] });
    // Becoming friends CHANGES WHAT IS SHARED WITH YOU: anything the other
    // person had already shared to "all friends" becomes visible the moment the
    // request is accepted. Without this the new friend's row read "nothing
    // shared yet" until a manual reload — the share was there, the cache was
    // not. The same pair is invalidated together on the un-friend path below.
    void queryClient.invalidateQueries({ queryKey: ['social', 'shared-with-me'] });
  }

  // `invalidate()` already refreshes shared-with-me: `all_friends` audiences
  // admit this user the moment the friendship forms, and the shared pair is
  // covered there for accept and un-friend alike (both sides of the second
  // merge wave had added this fix — once each).
  const acceptMutation = useMutation({
    mutationFn: (id: string) => acceptFriendRequest(id),
    onSuccess: invalidate,
  });
  const declineMutation = useMutation({
    mutationFn: (id: string) => declineFriendRequest(id),
    onSuccess: invalidate,
  });
  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelFriendRequest(id),
    onSuccess: invalidate,
  });

  const actionFailed = acceptMutation.isError || declineMutation.isError || cancelMutation.isError;

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <SkeletonBlock height={14} width={128} />
        <SkeletonBlock height={64} />
      </section>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Alert tone="error">{t('social.friends.requestsLoadError')}</Alert>
        <Button onClick={() => void refetch()} size="sm">
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    // `#requests` is the deep-link anchor for friend.request notifications (V4-P0c).
    <div id="requests" className="flex flex-col gap-8 scroll-mt-20">
      {sharingAllowed ? <MirrorInvitesSection /> : null}
      <section className="flex flex-col gap-3">
        <h2 className="bt-label">{t('social.friends.incomingTitle')}</h2>
        {actionFailed ? <Alert tone="error">{t('social.friends.actionError')}</Alert> : null}
        {data.incoming.length === 0 ? (
          <EmptyState
            compact
            title={t('social.friends.incomingEmptyTitle')}
            description={t('social.friends.incomingEmptyDescription')}
          />
        ) : (
          <ul className="bt-panel bt-band overflow-hidden">
            {data.incoming.map((request) => (
              <IncomingRequestRow
                key={request.id}
                request={request}
                onAccept={() => acceptMutation.mutate(request.id)}
                onDecline={() => declineMutation.mutate(request.id)}
                pendingAction={
                  acceptMutation.isPending && acceptMutation.variables === request.id
                    ? 'accept'
                    : declineMutation.isPending && declineMutation.variables === request.id
                      ? 'decline'
                      : null
                }
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="bt-label">{t('social.friends.outgoingTitle')}</h2>
        {data.outgoing.length === 0 ? (
          <EmptyState
            compact
            title={t('social.friends.outgoingEmptyTitle')}
            description={t('social.friends.outgoingEmptyDescription')}
          />
        ) : (
          <ul className="bt-panel bt-band overflow-hidden">
            {data.outgoing.map((request) => (
              <OutgoingRequestRow
                key={request.id}
                request={request}
                onCancel={() => cancelMutation.mutate(request.id)}
                pending={cancelMutation.isPending && cancelMutation.variables === request.id}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ─── Friends list ───────────────────────────────────────────────────────────

function RemoveFriendDialog({
  username,
  onConfirm,
  onClose,
  pending,
  error,
}: {
  username: string;
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
  error: boolean;
}) {
  const t = useT();
  return (
    <Dialog phoneSheet title={t('social.friends.removeTitle')} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="bt-soft">
          <span className="bt-row-title">{username}</span> {t('social.friends.removeBody')}
        </p>
        {error ? <Alert tone="error">{t('social.friends.removeError')}</Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={pending} onClick={onClose} variant="quiet">
            {t('common.cancel')}
          </Button>
          <Button disabled={pending} onClick={onConfirm} variant="danger">
            {pending ? t('social.friends.removing') : t('common.remove')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The per-friend "what they share with me" list inside the overview: each item is
 * a read-only deep link carrying its own activity-alert control (relocated here
 * from the retired Shared-with-me tab, #384) so you opt in to a friend's trades on
 * the very item they share.
 */
function FriendShares({
  person,
  username,
}: {
  person: SharedPerson | undefined;
  username: string;
}) {
  const t = useT();
  if (!person || person.total === 0) {
    return <p className="bt-meta">{t('social.friend.sharesEmpty', { username })}</p>;
  }
  return (
    <div className="bt-band flex flex-col">
      {person.portfolios.map((p) => (
        <SharedItemRow
          key={p.portfolioId}
          kind="portfolio"
          subjectId={p.portfolioId}
          name={p.name}
          secondary={<MoneyText amount={p.totalValueEur} />}
          footer={
            <ActivityAlertToggle
              kind="portfolio"
              subjectId={p.portfolioId}
              enabled={p.activityAlertsEnabled}
              friendName={username}
            />
          }
        />
      ))}
      {person.conglomerates.map((c) => (
        <SharedItemRow
          key={c.conglomerateId}
          kind="conglomerate"
          subjectId={c.conglomerateId}
          name={c.name}
          secondary={t('social.item.positions', { count: c.positionCount })}
          footer={
            <ActivityAlertToggle
              kind="conglomerate"
              subjectId={c.conglomerateId}
              enabled={c.activityAlertsEnabled}
              friendName={username}
            />
          }
        />
      ))}
      {person.watchlists.map((w) => (
        <SharedItemRow
          key={w.watchlistId}
          kind="watchlist"
          subjectId={w.watchlistId}
          name={w.name}
          secondary={t('social.item.assets', { count: w.itemCount })}
          footer={
            <ActivityAlertToggle
              kind="watchlist"
              subjectId={w.watchlistId}
              enabled={w.activityAlertsEnabled}
              friendName={username}
            />
          }
        />
      ))}
      {person.ideas.map((i) => (
        <SharedItemRow
          key={i.ideaId}
          kind="idea"
          subjectId={i.ideaId}
          name={i.name}
          secondary={i.hasThesis ? t('social.item.ideaThesis') : undefined}
          footer={
            <ActivityAlertToggle
              kind="idea"
              subjectId={i.ideaId}
              enabled={i.activityAlertsEnabled}
              friendName={username}
            />
          }
        />
      ))}
    </div>
  );
}

/**
 * A clean friend card that expands in place to the **friend overview** (V3-P6):
 * collapsed it shows only avatar + username + a chat shortcut; expanded it shows
 * the friend's profile line, a Chat button, everything they share with me
 * (read-only), and the per-friend actions (remove) that used to clutter the card.
 */
function FriendCard({
  friendship,
  person,
  onRequestRemove,
  sharingAllowed,
  sharesReady,
}: {
  friendship: Friendship;
  person: SharedPerson | undefined;
  onRequestRemove: () => void;
  sharingAllowed: boolean;
  sharesReady: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { user } = friendship;
  const panelId = `friend-${user.id}`;
  const chatHref = `/people/chat/${user.id}`;
  const countLine =
    sharingAllowed && person && person.total > 0 ? kindCountSummary(person, t) : null;

  return (
    <li className="bt-panel bt-friend-card overflow-hidden">
      <div className="flex items-center gap-2 pr-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={user.username}
          className="bt-band__row flex min-w-0 flex-1 items-center gap-3 text-left"
          style={{
            background: 'none',
            border: 0,
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          <Avatar name={user.username} iconId={user.profileIcon} size="md" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="bt-row-title truncate">{user.username}</span>
            {countLine ? <span className="bt-row-sub truncate">{countLine}</span> : null}
          </span>
          <Chevron open={open} />
        </button>
        <Link
          to={chatHref}
          aria-label={t('social.friend.messageAria', { username: user.username })}
          title={t('social.friend.chat')}
          className="bt-btn bt-btn--quiet bt-btn--icon"
        >
          <Icon name="message" size={17} />
        </Link>
      </div>

      {open ? (
        <div id={panelId} className="bt-t-rule flex flex-col gap-4" style={{ padding: 16 }}>
          <div className="bt-friend-card__identity flex flex-wrap items-center gap-3">
            <Avatar name={user.username} iconId={user.profileIcon} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="bt-h2 truncate">{user.username}</p>
              <p className="bt-meta truncate">
                {t('social.friend.since', { date: friendship.createdAt.slice(0, 10) })}
              </p>
            </div>
            <Link className="bt-btn" to={chatHref}>
              <Icon name="message" size={16} />
              {t('social.friend.chat')}
            </Link>
          </div>

          {sharingAllowed && sharesReady ? (
            <div className="flex flex-col gap-2">
              <h3 className="bt-label">{t('social.friend.sharesHeading')}</h3>
              <FriendShares person={person} username={user.username} />
            </div>
          ) : null}

          {/* Following-in-place (V4-P0b): a friend is followable straight from
              their row — no public profile needed. The auto-follow switch and
              the single "Follow their alerts" toggle (the latter only when this
              friend shares their alert activity) appear once you follow them. */}
          {sharingAllowed ? (
            <div className="bt-t-rule flex flex-col gap-3" style={{ paddingTop: 14 }}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="bt-label">{t('social.friend.followHeading')}</h3>
                  <p className="bt-meta" style={{ marginTop: 2 }}>
                    {t('social.friend.followHint')}
                  </p>
                </div>
                <FollowButton userId={user.id} username={user.username} />
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 empty:hidden">
                <AutoFollowToggle userId={user.id} username={user.username} />
                <AlertFollowToggle userId={user.id} username={user.username} />
              </div>
            </div>
          ) : null}

          <div className="bt-t-rule flex items-center justify-end gap-3" style={{ paddingTop: 14 }}>
            <Button onClick={onRequestRemove} size="sm" variant="danger">
              {t('social.friend.remove')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function FriendsListSection({ sharingAllowed }: { sharingAllowed: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [removeTarget, setRemoveTarget] = useState<Friendship | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['social', 'friends'],
    queryFn: ({ signal }) => listFriends(signal),
    staleTime: FRIENDS_STALE_MS,
  });

  // The friend overview reuses the SAME enforcement-derived Shared-With-Me data,
  // grouped per person — no separate per-friend endpoint, no new privacy path.
  const sharedQuery = useQuery({
    queryKey: ['social', 'shared-with-me'],
    queryFn: ({ signal }) => listSharedWithMe(signal),
    staleTime: FRIENDS_STALE_MS,
    enabled: sharingAllowed,
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeFriend(userId),
    onSuccess: () => {
      setRemoveTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['social', 'friends'] });
      void queryClient.invalidateQueries({ queryKey: ['social', 'shared-with-me'] });
    },
  });

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <SkeletonBlock height={14} width={96} />
        <SkeletonBlock height={64} />
      </section>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Alert tone="error">{t('social.friends.friendsLoadError')}</Alert>
        <Button onClick={() => void refetch()} size="sm">
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="bt-h2">{t('common.friends')}</h2>
      {sharedQuery.isLoading ? (
        <div aria-label={t('common.loadingLabel')} className="flex flex-col gap-2" role="status">
          <SkeletonBlock height={14} width={144} />
          <SkeletonBlock height={48} />
        </div>
      ) : sharedQuery.isError ? (
        <div className="flex flex-col items-start gap-2">
          <Alert tone="error">{t('social.shared.loadError')}</Alert>
          <Button onClick={() => void sharedQuery.refetch()} size="sm">
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
      {data.friends.length === 0 ? (
        <EmptyState
          icon="🫂"
          title={t('social.friends.emptyTitle')}
          description={t('social.friends.emptyDescription')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {data.friends.map((friendship) => (
            <FriendCard
              key={friendship.user.id}
              friendship={friendship}
              person={
                sharedQuery.isSuccess ? personFor(sharedQuery.data, friendship.user.id) : undefined
              }
              onRequestRemove={() => setRemoveTarget(friendship)}
              sharingAllowed={sharingAllowed}
              sharesReady={sharedQuery.isSuccess}
            />
          ))}
        </ul>
      )}

      {removeTarget ? (
        <RemoveFriendDialog
          username={removeTarget.user.username}
          onConfirm={() => removeMutation.mutate(removeTarget.user.id)}
          onClose={() => (removeMutation.isPending ? undefined : setRemoveTarget(null))}
          pending={removeMutation.isPending}
          error={removeMutation.isError}
        />
      ) : null}
    </section>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

/**
 * `/people` — add friends by username/email, respond to requests and
 * manage the friends list (PROJECTPLAN.md §6.9).
 */
export function FriendsPage() {
  const t = useT();
  const sharingAllowed = useResolvedPrivacyMode() === 'normal';
  return (
    <div className="bt-phone-surface bt-friends-page flex flex-col">
      <PageHead title={t('common.friends')} />
      {/* PageHead already carries its own 22px rhythm below the title, so the
          section stack starts here rather than inheriting the page gap. */}
      <div className="flex flex-col gap-8">
        <AddFriendForm />
        <FriendsListSection sharingAllowed={sharingAllowed} />
        {sharingAllowed ? <FriendGroupsSection /> : null}
        <RequestsSection sharingAllowed={sharingAllowed} />
      </div>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import type { FriendRequest, Friendship } from '@bettertrack/contracts';

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
import { EmptyState, MoneyText, Skeleton } from '../../ui';
import { Alert, Button, TextField, cx } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../components/Dialog';
import {
  ActivityAlertToggle,
  SharedItemRow,
  kindCountSummary,
  personFor,
  type SharedPerson,
} from './SharedPeople';

/** Inline chat glyph — the chat entry point (routes to #349's future surface). */
function ChatIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5.5h16v10H9l-4 3.5v-3.5H4z" />
    </svg>
  );
}

const REQUESTS_STALE_MS = 15_000;
const FRIENDS_STALE_MS = 30_000;

/**
 * The identical, no-enumeration success message shown after every
 * `POST /social/requests` — the backend always answers `{ ok: true }`
 * regardless of whether the target exists (PROJECTPLAN.md §6.9), so the UI
 * never has a "user not found" branch to surface.
 */
const REQUEST_SENT_MESSAGE =
  "If that account exists, we've sent your friend request. They'll see it if they accept.";

// ─── Add friend ─────────────────────────────────────────────────────────────

function AddFriendForm() {
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    null,
  );

  const mutation = useMutation({
    mutationFn: (value: string) => sendFriendRequest({ identifier: value }),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: REQUEST_SENT_MESSAGE });
      setIdentifier('');
      void queryClient.invalidateQueries({ queryKey: ['social', 'requests'] });
    },
    onError: () =>
      setFeedback({ tone: 'error', text: 'Could not send that request. Please try again.' }),
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
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Add a friend
      </h2>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <TextField
            label="Username or email"
            name="identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="jane or jane@example.com"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={mutation.isPending || !identifier.trim()}>
          {mutation.isPending ? 'Sending…' : 'Send request'}
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
  const busy = pendingAction !== null;
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-sm font-medium text-neutral-100">{request.user.username}</span>
      <span className="flex gap-2">
        <Button onClick={onAccept} disabled={busy}>
          {pendingAction === 'accept' ? 'Accepting…' : 'Accept'}
        </Button>
        <Button variant="secondary" onClick={onDecline} disabled={busy}>
          {pendingAction === 'decline' ? 'Declining…' : 'Decline'}
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
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-sm font-medium text-neutral-100">{request.user.username}</span>
      <Button variant="secondary" onClick={onCancel} disabled={pending}>
        {pending ? 'Cancelling…' : 'Cancel'}
      </Button>
    </li>
  );
}

function RequestsSection() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['social', 'requests'],
    queryFn: ({ signal }) => listFriendRequests(signal),
    staleTime: REQUESTS_STALE_MS,
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['social', 'requests'] });
    void queryClient.invalidateQueries({ queryKey: ['social', 'friends'] });
  }

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
        <Skeleton height="h-4" width="w-32" />
        <Skeleton height="h-16" />
      </section>
    );
  }

  if (isError || !data) {
    return (
      <Alert tone="error">Could not load your friend requests. Please refresh the page.</Alert>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Incoming requests
        </h2>
        {actionFailed ? (
          <Alert tone="error">That action didn't go through. Please try again.</Alert>
        ) : null}
        {data.incoming.length === 0 ? (
          <EmptyState title="No incoming requests" description="New friend requests appear here." />
        ) : (
          <ul className="divide-y divide-neutral-800 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40">
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
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Pending requests
        </h2>
        {data.outgoing.length === 0 ? (
          <EmptyState
            title="No pending requests"
            description="Requests you send are listed here until they're accepted or declined."
          />
        ) : (
          <ul className="divide-y divide-neutral-800 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40">
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
  return (
    <Dialog title="Remove friend?" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">
          <span className="font-medium text-neutral-200">{username}</span> will no longer be your
          friend and won't be notified.
        </p>
        {error ? <Alert tone="error">Could not remove this friend. Please try again.</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={pending}
            className="bg-red-700 hover:bg-red-600 disabled:bg-red-900"
          >
            {pending ? 'Removing…' : 'Remove'}
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
    return (
      <p className="text-sm text-neutral-500">{t('social.friend.sharesEmpty', { username })}</p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
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
}: {
  friendship: Friendship;
  person: SharedPerson | undefined;
  onRequestRemove: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { user } = friendship;
  const panelId = `friend-${user.id}`;
  const chatHref = `/social/chat/${user.id}`;
  const countLine = person && person.total > 0 ? kindCountSummary(person, t) : null;

  return (
    <li className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
      <div className="flex items-center gap-3 pr-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={user.username}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500"
        >
          <Avatar name={user.username} size="md" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold text-neutral-100">{user.username}</span>
            {countLine ? (
              <span className="truncate text-xs text-neutral-500">{countLine}</span>
            ) : null}
          </span>
          <svg
            className={cx(
              'h-4 w-4 shrink-0 text-neutral-500 transition-transform',
              open && 'rotate-90',
            )}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
        <Link
          to={chatHref}
          aria-label={t('social.friend.messageAria', { username: user.username })}
          title={t('social.friend.chat')}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <ChatIcon className="h-5 w-5" />
        </Link>
      </div>

      {open ? (
        <div id={panelId} className="flex flex-col gap-4 border-t border-neutral-800 p-4">
          <div className="flex items-center gap-3">
            <Avatar name={user.username} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-neutral-100">{user.username}</p>
              <p className="truncate text-xs text-neutral-500">
                {t('social.friend.since', { date: friendship.createdAt.slice(0, 10) })}
              </p>
            </div>
            <Link
              to={chatHref}
              className="inline-flex items-center gap-2 rounded-md bg-neutral-800 px-3 py-2 text-sm font-medium text-neutral-100 ring-1 ring-inset ring-neutral-700 transition-colors hover:bg-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <ChatIcon className="h-4 w-4" />
              {t('social.friend.chat')}
            </Link>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {t('social.friend.sharesHeading')}
            </h3>
            <FriendShares person={person} username={user.username} />
          </div>

          <div className="flex justify-end border-t border-neutral-800 pt-3">
            <Button
              variant="secondary"
              onClick={onRequestRemove}
              className="text-red-300 hover:text-red-200"
            >
              {t('social.friend.remove')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function FriendsListSection() {
  const queryClient = useQueryClient();
  const [removeTarget, setRemoveTarget] = useState<Friendship | null>(null);

  const { data, isLoading, isError } = useQuery({
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
        <Skeleton height="h-4" width="w-24" />
        <Skeleton height="h-16" />
      </section>
    );
  }

  if (isError || !data) {
    return <Alert tone="error">Could not load your friends. Please refresh the page.</Alert>;
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Friends</h2>
      {data.friends.length === 0 ? (
        <EmptyState
          icon="🫂"
          title="No friends yet"
          description="Add a friend by username or email above to start sharing."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {data.friends.map((friendship) => (
            <FriendCard
              key={friendship.user.id}
              friendship={friendship}
              person={personFor(sharedQuery.data, friendship.user.id)}
              onRequestRemove={() => setRemoveTarget(friendship)}
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
 * `/social/friends` — add friends by username/email, respond to requests and
 * manage the friends list (PROJECTPLAN.md §6.9).
 */
export function FriendsPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Friends</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Add friends by username or email, respond to requests, and manage who you're connected
          with.
        </p>
      </div>
      <AddFriendForm />
      <RequestsSection />
      <FriendsListSection />
    </div>
  );
}

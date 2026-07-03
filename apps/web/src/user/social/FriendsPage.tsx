import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import type { FriendRequest, Friendship } from '@bettertrack/contracts';

import {
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  listFriendRequests,
  listFriends,
  removeFriend,
  sendFriendRequest,
} from '../../lib/socialApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button, TextField } from '../components/ui';
import { Dialog } from '../components/Dialog';

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
      <h2 className="text-lg font-semibold text-neutral-100">Add a friend</h2>
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
    <li className="flex items-center justify-between gap-3 py-3">
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
    <li className="flex items-center justify-between gap-3 py-3">
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
        <Skeleton height="h-6" width="w-40" />
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
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-neutral-100">Incoming requests</h2>
        {actionFailed ? (
          <Alert tone="error">That action didn't go through. Please try again.</Alert>
        ) : null}
        {data.incoming.length === 0 ? (
          <EmptyState title="No incoming requests" description="New friend requests appear here." />
        ) : (
          <ul className="divide-y divide-neutral-800">
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

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-neutral-100">Pending requests</h2>
        {data.outgoing.length === 0 ? (
          <EmptyState
            title="No pending requests"
            description="Requests you send are listed here until they're accepted or declined."
          />
        ) : (
          <ul className="divide-y divide-neutral-800">
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

function FriendRow({
  friendship,
  onRequestRemove,
}: {
  friendship: Friendship;
  onRequestRemove: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <span className="text-sm font-medium text-neutral-100">{friendship.user.username}</span>
      <Button variant="secondary" onClick={onRequestRemove}>
        Remove
      </Button>
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

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeFriend(userId),
    onSuccess: () => {
      setRemoveTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['social', 'friends'] });
    },
  });

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-6" width="w-32" />
        <Skeleton height="h-16" />
      </section>
    );
  }

  if (isError || !data) {
    return <Alert tone="error">Could not load your friends. Please refresh the page.</Alert>;
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold text-neutral-100">Friends</h2>
      {data.friends.length === 0 ? (
        <EmptyState
          icon="🫂"
          title="No friends yet"
          description="Add a friend by username or email above to start sharing."
        />
      ) : (
        <ul className="divide-y divide-neutral-800">
          {data.friends.map((friendship) => (
            <FriendRow
              key={friendship.user.id}
              friendship={friendship}
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

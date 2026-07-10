import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  REALTIME_SERVER_EVENTS,
  realtimeChatMessageSchema,
  type ChatChip,
  type ChatConversation,
  type ChatMessage,
} from '@bettertrack/contracts';

import {
  getThread,
  listConversations,
  markConversationRead,
  openConversation,
  sendChatMessage,
} from '../../lib/chatApi';
import { listConglomerates } from '../../lib/conglomerateApi';
import { listPortfolios } from '../../lib/portfolioApi';
import { usePresence, useRealtimeEvent } from '../../lib/realtime';
import { listFriends } from '../../lib/socialApi';
import { formatDateTime } from '../../lib/format';
import { useT, type TranslateFn } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { useAuth } from '../AuthContext';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';

const CONVERSATIONS_KEY = ['chat', 'conversations'] as const;
const threadKey = (conversationId: string) => ['chat', 'thread', conversationId] as const;
// The realtime push makes updates instant; these polls are the §4.5 fallback for
// when the socket is absent (flag off, gateway down, reconnecting).
const LIST_POLL_MS = 20_000;
const THREAD_POLL_MS = 10_000;
const THREAD_PAGE = 40;

// ── Chip kind glyphs ─────────────────────────────────────────────────────────

function ChipIcon({ kind, className }: { kind: ChatChip['kind']; className?: string }) {
  const paths: Record<ChatChip['kind'], string> = {
    asset: 'M4 18l5-6 4 4 6-8',
    portfolio: 'M12 3v9l7 3M12 3a9 9 0 100 18 9 9 0 000-18z',
    conglomerate: 'M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z',
    watchlist: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zm10 3a3 3 0 100-6 3 3 0 000 6z',
  };
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
      <path d={paths[kind]} />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
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
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  );
}

/** The in-app route a viewable chip opens — owner vs. shared-with-me view. */
function chipHref(chip: ChatChip): string {
  const owned = chip.subtitle === null; // subtitle carries the owner username for a shared item
  switch (chip.kind) {
    case 'asset':
      return `/assets/${chip.subjectId}`;
    case 'portfolio':
      return owned ? '/portfolio' : `/social/shared-with-me/${chip.subjectId}`;
    case 'conglomerate':
      return owned
        ? `/workboard/conglomerates/${chip.subjectId}`
        : `/social/shared-with-me/conglomerates/${chip.subjectId}`;
    case 'watchlist':
      return owned ? '/workboard/watchlist' : `/social/shared-with-me/watchlists/${chip.subjectId}`;
  }
}

function chipKindLabel(t: TranslateFn, kind: ChatChip['kind']): string {
  return t(`social.chat.chip.kind.${kind}`);
}

// ── Share chip ───────────────────────────────────────────────────────────────

function ShareChipView({ chip }: { chip: ChatChip }) {
  const t = useT();
  if (!chip.viewable) {
    // "Not shared with you" — never leaks the item's name or any data.
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-neutral-700 bg-neutral-900/60 px-3 py-2">
        <LockIcon className="h-5 w-5 shrink-0 text-neutral-500" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-300">{chipKindLabel(t, chip.kind)}</p>
          <p className="text-xs text-neutral-500">{t('social.chat.chip.notShared')}</p>
        </div>
      </div>
    );
  }
  return (
    <Link
      to={chipHref(chip)}
      className="flex items-center gap-2.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 transition-colors hover:bg-sky-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      <ChipIcon kind={chip.kind} className="h-6 w-6 shrink-0 text-sky-300" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-neutral-100">
          {chip.title ?? chipKindLabel(t, chip.kind)}
        </p>
        <p className="truncate text-xs text-neutral-400">
          {chip.subtitle
            ? `${chipKindLabel(t, chip.kind)} · ${chip.subtitle}`
            : chipKindLabel(t, chip.kind)}
        </p>
      </div>
      <span className="text-xs font-semibold text-sky-300">{t('social.chat.chip.view')}</span>
    </Link>
  );
}

// ── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ message, mine }: { message: ChatMessage; mine: boolean }) {
  return (
    <div className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'flex max-w-[85%] flex-col gap-1.5 rounded-2xl border px-3 py-2 sm:max-w-[70%]',
          mine
            ? 'rounded-br-sm border-sky-500/40 bg-sky-500/15'
            : 'rounded-bl-sm border-neutral-800 bg-neutral-900/70',
        )}
      >
        {message.chip ? <ShareChipView chip={message.chip} /> : null}
        {message.body ? (
          <p className="whitespace-pre-wrap break-words text-sm text-neutral-100">{message.body}</p>
        ) : null}
        <span className={cx('text-[0.65rem] text-neutral-500', mine ? 'text-right' : 'text-left')}>
          {formatDateTime(message.createdAt)}
        </span>
      </div>
    </div>
  );
}

// ── Conversation list ────────────────────────────────────────────────────────

function conversationPreview(
  t: TranslateFn,
  convo: ChatConversation,
  selfId: string | undefined,
): string {
  const last = convo.lastMessage;
  if (!last) return t('social.chat.noMessages');
  const mine = last.senderId === selfId;
  const prefix = mine ? t('social.chat.youPrefix') : '';
  if (last.chipKind) return prefix + t(`social.chat.preview.shared.${last.chipKind}`);
  return prefix + (last.body ?? '');
}

function ConversationRow({
  convo,
  active,
  selfId,
  onClick,
}: {
  convo: ChatConversation;
  active: boolean;
  selfId: string | undefined;
  onClick: () => void;
}) {
  const t = useT();
  const unread = convo.unreadCount > 0;
  // `user: null` = the other account was deleted (#362): the thread stays
  // readable (anonymized) and renders under the localized placeholder name.
  const displayName = convo.user?.username ?? t('social.chat.deletedUser');
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500',
        active ? 'bg-neutral-800' : 'hover:bg-neutral-800/50',
      )}
    >
      <Avatar name={displayName} size="md" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span
            className={cx(
              'truncate text-sm',
              convo.user ? 'text-neutral-100' : 'italic text-neutral-400',
              unread ? 'font-bold' : 'font-semibold',
            )}
          >
            {displayName}
          </span>
          {convo.lastMessageAt ? (
            <span className="ml-auto shrink-0 text-[0.65rem] text-neutral-500">
              {formatDateTime(convo.lastMessageAt)}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          <span
            className={cx(
              'truncate text-xs',
              unread ? 'font-medium text-neutral-300' : 'text-neutral-500',
            )}
          >
            {conversationPreview(t, convo, selfId)}
          </span>
          {unread ? (
            <span className="ml-auto inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-sky-500 px-1.5 text-[0.65rem] font-bold text-white">
              {convo.unreadCount}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

function NewChatDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['social', 'friends'],
    queryFn: ({ signal }) => listFriends(signal),
  });
  const friends = data?.friends ?? [];
  return (
    <Dialog title={t('social.chat.new')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-400">{t('social.chat.newPrompt')}</p>
        {isLoading ? (
          <Skeleton height="h-16" />
        ) : friends.length === 0 ? (
          <p className="text-sm text-neutral-500">{t('social.chat.noFriends')}</p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {friends.map((f) => (
              <li key={f.user.id}>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    navigate(`/social/chat/${f.user.id}`);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                >
                  <Avatar name={f.user.username} size="sm" />
                  <span className="text-sm font-medium text-neutral-100">{f.user.username}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function ConversationListPane({
  selectedUserId,
  selectedConversationId,
}: {
  selectedUserId: string | undefined;
  selectedConversationId: string | undefined;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [newOpen, setNewOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: CONVERSATIONS_KEY,
    queryFn: ({ signal }) => listConversations(signal),
    refetchInterval: LIST_POLL_MS,
  });

  return (
    <div className="flex h-full flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-neutral-200">{t('social.chat.title')}</h2>
        <Button
          variant="secondary"
          onClick={() => setNewOpen(true)}
          className="px-2.5 py-1 text-xs"
        >
          {t('social.chat.new')}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2 p-1">
          <Skeleton height="h-12" />
          <Skeleton height="h-12" />
        </div>
      ) : isError ? (
        <Alert tone="error">{t('social.chat.error')}</Alert>
      ) : !data || data.conversations.length === 0 ? (
        <EmptyState
          icon="💬"
          title={t('social.chat.empty.title')}
          description={t('social.chat.empty.body')}
        />
      ) : (
        <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {data.conversations.map((convo) => (
            <li key={convo.id}>
              <ConversationRow
                convo={convo}
                active={
                  convo.user
                    ? convo.user.id === selectedUserId
                    : convo.id === selectedConversationId
                }
                selfId={user?.id}
                // A deleted partner has no user id to route by — the thread
                // deep-links by conversation id instead (#362).
                onClick={() =>
                  navigate(
                    convo.user ? `/social/chat/${convo.user.id}` : `/social/chat/c/${convo.id}`,
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}

      {newOpen ? <NewChatDialog onClose={() => setNewOpen(false)} /> : null}
    </div>
  );
}

// ── Share-in-chat attach picker ──────────────────────────────────────────────

interface Attachable {
  kind: ChatChip['kind'];
  subjectId: string;
  name: string;
}

function SharePickerDialog({
  onPick,
  onClose,
}: {
  onPick: (item: Attachable) => void;
  onClose: () => void;
}) {
  const t = useT();
  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
  });
  const conglomeratesQuery = useQuery({
    queryKey: ['conglomerates'],
    queryFn: ({ signal }) => listConglomerates(signal),
  });

  const portfolios = portfoliosQuery.data?.portfolios ?? [];
  const conglomerates = conglomeratesQuery.data?.conglomerates ?? [];
  const empty = portfolios.length === 0 && conglomerates.length === 0;

  function row(item: Attachable) {
    return (
      <li key={`${item.kind}:${item.subjectId}`}>
        <button
          type="button"
          onClick={() => onPick(item)}
          className="flex w-full items-center gap-3 rounded-lg border border-neutral-800 px-3 py-2 text-left hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <ChipIcon kind={item.kind} className="h-5 w-5 shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-neutral-100">{item.name}</span>
            <span className="block text-xs text-neutral-500">{chipKindLabel(t, item.kind)}</span>
          </span>
        </button>
      </li>
    );
  }

  return (
    <Dialog title={t('social.chat.share.title')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-neutral-500">{t('social.chat.share.disclaimer')}</p>
        {portfoliosQuery.isLoading || conglomeratesQuery.isLoading ? (
          <Skeleton height="h-16" />
        ) : empty ? (
          <p className="text-sm text-neutral-500">{t('social.chat.share.empty')}</p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
            {portfolios.map((p) => row({ kind: 'portfolio', subjectId: p.id, name: p.name }))}
            {conglomerates.map((c) => row({ kind: 'conglomerate', subjectId: c.id, name: c.name }))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

// ── Thread ───────────────────────────────────────────────────────────────────

function MessageComposer({
  onSendText,
  onSendChip,
  disabled,
}: {
  onSendText: (body: string) => Promise<unknown>;
  onSendChip: (item: Attachable) => void;
  disabled: boolean;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Desktop-only surface: put the caret in the composer as soon as the thread
  // opens, and return it whenever the input re-enables. The field is disabled
  // while a send is in-flight (which drops focus and, on the click path, the
  // send button steals it); one effect covers both cases because the input is
  // enabled on mount and again once each send settles — so a rerender or the
  // disabled→enabled toggle never leaves the user re-clicking the field.
  useEffect(() => {
    if (!disabled) inputRef.current?.focus();
  }, [disabled]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    // Clear the field only once the send resolves; a failed send keeps the
    // draft in place so it can be retried without retyping.
    void (async () => {
      try {
        await onSendText(trimmed);
        setText('');
      } catch {
        // Send failed — leave the text so the user can retry.
      }
    })();
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2 border-t border-neutral-800 p-3">
      <button
        type="button"
        onClick={() => setShareOpen(true)}
        disabled={disabled}
        title={t('social.chat.attach')}
        aria-label={t('social.chat.attach')}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50"
      >
        <svg
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8.5-8.5" />
        </svg>
      </button>
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e);
        }}
        rows={1}
        placeholder={t('social.chat.composerPlaceholder')}
        disabled={disabled}
        className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-2xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:opacity-50"
      />
      <Button type="submit" disabled={disabled || !text.trim()} className="h-10 shrink-0">
        {t('social.chat.send')}
      </Button>
      {shareOpen ? (
        <SharePickerDialog
          onClose={() => setShareOpen(false)}
          onPick={(item) => {
            setShareOpen(false);
            onSendChip(item);
          }}
        />
      ) : null}
    </form>
  );
}

function ChatThreadPane({
  userId,
  fixedConversationId,
}: {
  userId?: string;
  fixedConversationId?: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Resolve (or open) the conversation with this friend. A non-friend 404s.
  // A thread deep-linked by conversation id (a deleted partner, #362) skips the
  // open call — its summary rides on the thread response instead.
  const convoQuery = useQuery<ChatConversation, Error>({
    queryKey: userId
      ? ['chat', 'conversation-for-user', userId]
      : ['chat', 'conversation-by-id', fixedConversationId],
    queryFn: () =>
      userId
        ? openConversation(userId)
        : getThread(fixedConversationId!, { limit: 1 }).then((r) => r.conversation),
    retry: false,
  });
  const conversationId = convoQuery.data?.id;

  // Presence (#368): while this thread is open + the tab focused, tell the
  // gateway we're viewing it — the dispatcher then suppresses the bell/email/
  // push for messages that land right here in front of us. Heartbeated with a
  // server-side TTL, cleared on blur/close, so it can never go stale.
  usePresence('chat', conversationId ?? null);

  const threadQuery = useInfiniteQuery({
    queryKey: conversationId ? threadKey(conversationId) : ['chat', 'thread', 'pending'],
    queryFn: ({ pageParam, signal }) =>
      getThread(conversationId!, { cursor: pageParam, limit: THREAD_PAGE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(conversationId),
    refetchInterval: THREAD_POLL_MS,
  });

  // Pages are newest-first; flatten then reverse for oldest→newest display.
  const messages = useMemo(() => {
    const flat = (threadQuery.data?.pages ?? []).flatMap((p) => p.messages);
    return [...flat].reverse();
  }, [threadQuery.data]);

  const newestId = messages.at(-1)?.id;

  // Keep the open thread read as new messages arrive, and clear the list badge.
  useEffect(() => {
    if (!conversationId || !newestId) return;
    void markConversationRead(conversationId).then(() => {
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    });
  }, [conversationId, newestId, queryClient]);

  // Auto-scroll to the latest message.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [newestId]);

  const sendMutation = useMutation({
    mutationFn: (input: { body?: string; chip?: { kind: ChatChip['kind']; subjectId: string } }) =>
      sendChatMessage(conversationId!, input),
    onSuccess: () => {
      if (conversationId)
        void queryClient.invalidateQueries({ queryKey: threadKey(conversationId) });
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });

  if (convoQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Skeleton height="h-24" width="w-48" />
      </div>
    );
  }

  if (convoQuery.isError) {
    // A non-friend / unknown user — the API 404s and we show a calm state, no data.
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon="🔒"
          title={t('social.chat.notFriend.title')}
          description={t('social.chat.notFriend.body')}
        />
      </div>
    );
  }

  const other = convoQuery.data!.user;
  const otherName = other?.username ?? t('social.chat.deletedUser');

  return (
    <div className="flex h-full flex-col rounded-xl border border-neutral-800 bg-neutral-900/40">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
        <Link
          to="/social/chat"
          className="md:hidden text-neutral-400 hover:text-neutral-100"
          aria-label={t('common.back')}
        >
          ←
        </Link>
        <Avatar name={otherName} size="sm" />
        <span
          className={cx(
            'text-sm font-semibold',
            other ? 'text-neutral-100' : 'italic text-neutral-400',
          )}
        >
          {otherName}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
        {threadQuery.hasNextPage ? (
          <button
            type="button"
            onClick={() => void threadQuery.fetchNextPage()}
            disabled={threadQuery.isFetchingNextPage}
            className="mx-auto rounded-full border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-50"
          >
            {t('social.chat.loadEarlier')}
          </button>
        ) : null}

        {messages.length === 0 && !threadQuery.isLoading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <Avatar name={otherName} size="lg" />
            <p className="text-base font-semibold text-neutral-100">
              {t('social.chat.sayHi', { username: otherName })}
            </p>
            <p className="max-w-xs text-sm text-neutral-500">{t('social.chat.sayHiBody')}</p>
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} mine={m.senderId === user?.id} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {sendMutation.isError ? (
        <div className="px-3">
          <Alert tone="error">{t('social.chat.sendError')}</Alert>
        </div>
      ) : null}

      {other ? (
        <MessageComposer
          disabled={!conversationId || sendMutation.isPending}
          onSendText={(body) => sendMutation.mutateAsync({ body })}
          onSendChip={(item) =>
            sendMutation.mutate({ chip: { kind: item.kind, subjectId: item.subjectId } })
          }
        />
      ) : (
        // The partner deleted their account (#362): history stays readable, the
        // thread is closed to new messages — mirror the server's 403.
        <p className="border-t border-neutral-800 px-4 py-3 text-center text-xs text-neutral-500">
          {t('social.chat.deletedClosed')}
        </p>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * `/social/chat` (and `/social/chat/:userId`) — friend chat (PROJECTPLAN.md
 * §13.3 V3-P8). A master-detail layout: the conversation list beside the open
 * thread. Realtime pushes over the §4.5 gateway invalidate the relevant queries;
 * each query keeps a TanStack Query poll so chat stays live with the socket
 * absent. Share chips are resolved per-viewer server-side (never a leak).
 */
export function ChatPage() {
  const t = useT();
  const queryClient = useQueryClient();
  // `/social/chat/:userId` opens by friend; `/social/chat/c/:conversationId`
  // opens a thread directly — the only path to one whose partner was deleted (#362).
  const { userId, conversationId } = useParams<{ userId?: string; conversationId?: string }>();
  const selected = userId ?? conversationId;

  // A new-message push for the recipient → refetch the list + the affected thread.
  useRealtimeEvent(REALTIME_SERVER_EVENTS.chatMessage, (payload) => {
    const parsed = realtimeChatMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    void queryClient.invalidateQueries({ queryKey: threadKey(parsed.data.conversationId) });
  });

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          {t('social.chat.title')}
        </h1>
        <p className="mt-1 text-sm text-neutral-400">{t('social.chat.subhead')}</p>
      </div>

      <div className="flex h-[70vh] gap-4">
        <aside className={cx('w-full shrink-0 md:w-80', selected && 'hidden md:block')}>
          <ConversationListPane selectedUserId={userId} selectedConversationId={conversationId} />
        </aside>
        <section className={cx('min-w-0 flex-1', !selected && 'hidden md:block')}>
          {selected ? (
            <ChatThreadPane key={selected} userId={userId} fixedConversationId={conversationId} />
          ) : (
            <div className="flex h-full items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900/40 p-6">
              <EmptyState
                icon="💬"
                title={t('social.chat.selectTitle')}
                description={t('social.chat.selectBody')}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

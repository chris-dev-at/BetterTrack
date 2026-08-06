import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { Link } from 'react-router-dom';

import {
  CHAT_BANNED_ERROR_CODE,
  REALTIME_SERVER_EVENTS,
  SHARE_KINDS,
  audienceTransitionRequiresConfirmation,
  realtimeChatMessageSchema,
  type ChatChip,
  type ChatConversation,
  type ChatMessage,
  type ShareKind,
} from '@bettertrack/contracts';

import { ApiError, isConfirmedApiOutcome } from '../../lib/apiClient';

import {
  getThread,
  listConversations,
  markConversationRead,
  openConversation,
  sendChatMessage,
} from '../../lib/chatApi';
import { listConglomerates } from '../../lib/conglomerateApi';
import { listIdeas } from '../../lib/ideasApi';
import { listPortfolios } from '../../lib/portfolioApi';
import { usePresence, useRealtimeEvent } from '../../lib/realtime';
import { getAudience, listFriends, setAudience } from '../../lib/socialApi';
import { formatDateTime } from '../../lib/format';
import { useT, type TranslateFn } from '../../i18n';
import { EmptyState } from '../../ui';
import { AsyncReadState, type AsyncRead } from '../components/AsyncReadState';
import { Badge, Button, SkeletonBlock } from '../../ui/origin';
import { useAuth } from '../AuthContext';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../components/Dialog';
import { Alert, cx } from '../components/ui';
import { useMutationFeedback } from '../hooks/useMutationFeedback';
import { NormalModeOnly } from '../vault/ui/ParanoidSurfaceGate';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';

/**
 * The friend-chat surface (PROJECTPLAN.md §13.3 V3-P8) as reusable parts.
 *
 * R2: this is the chat itself — conversation list, thread, composer, share
 * chips, realtime sync — extracted out of `ChatPage.tsx` so the same live code
 * backs BOTH mounts: the `/people/chat` master-detail page and the popped-out
 * `/chat-window` (`ChatWindowPage`). Nothing here knows about routes: the two
 * page-bound decisions (what selecting a conversation does, and what "back"
 * means) are props, so each surface owns its own URL contract and neither can
 * hijack the other's deep links.
 */

export const CONVERSATIONS_KEY = ['chat', 'conversations'] as const;
export const threadKey = (conversationId: string) => ['chat', 'thread', conversationId] as const;
// The realtime push makes updates instant; these polls are the §4.5 fallback for
// when the socket is absent (flag off, gateway down, reconnecting).
const LIST_POLL_MS = 20_000;
const THREAD_POLL_MS = 10_000;
const THREAD_PAGE = 40;

/**
 * Which thread to show. A conversation whose partner deleted their account has
 * no user id to address it by, so it is identified by conversation id (#362) —
 * the same split the `/people/chat/:userId` vs `/people/chat/c/:id` routes make.
 */
export interface ChatTarget {
  userId?: string;
  conversationId?: string;
}

/** The route (or dock selection) a conversation row resolves to. */
export function conversationTarget(convo: ChatConversation): ChatTarget {
  return convo.user ? { userId: convo.user.id } : { conversationId: convo.id };
}

/**
 * Wire the gateway's new-message push to the chat query keys (§4.5): the list
 * badge and the affected thread refetch the moment a message lands. Mounted by
 * whichever chat surface is on screen; with no socket it is a no-op and the
 * per-query polls above carry the freshness.
 */
export function useChatRealtimeSync(): void {
  const queryClient = useQueryClient();
  useRealtimeEvent(REALTIME_SERVER_EVENTS.chatMessage, (payload) => {
    const parsed = realtimeChatMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    void queryClient.invalidateQueries({ queryKey: threadKey(parsed.data.conversationId) });
  });
}

// ── Chip kind glyphs ─────────────────────────────────────────────────────────

function ChipIcon({
  kind,
  className,
  style,
}: {
  kind: ChatChip['kind'];
  className?: string;
  style?: CSSProperties;
}) {
  const paths: Record<ChatChip['kind'], string> = {
    asset: 'M4 18l5-6 4 4 6-8',
    portfolio: 'M12 3v9l7 3M12 3a9 9 0 100 18 9 9 0 000-18z',
    conglomerate: 'M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z',
    watchlist: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zm10 3a3 3 0 100-6 3 3 0 000 6z',
    idea: 'M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.6.6 1 1.3 1 2.5h6c0-1.2.4-1.9 1-2.5A6 6 0 0012 3z',
  };
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

function LockIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
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
      return owned ? '/portfolio' : `/people/shared/${chip.subjectId}`;
    case 'conglomerate':
      return owned
        ? `/workbench/blueprints/${chip.subjectId}`
        : `/people/shared/conglomerates/${chip.subjectId}`;
    case 'watchlist':
      return owned ? '/assets/watchlists' : `/people/shared/watchlists/${chip.subjectId}`;
    case 'idea':
      // Owned → the idea reopens in the Workboard; shared → the read-only
      // shared-idea view where the recipient can clone it (V4-P9).
      return owned
        ? `/workbench/ideas/${chip.subjectId}`
        : `/people/shared/ideas/${chip.subjectId}`;
  }
}

function chipKindLabel(t: TranslateFn, kind: ChatChip['kind']): string {
  return t(`social.chat.chip.kind.${kind}`);
}

// ── Share chip ───────────────────────────────────────────────────────────────

/**
 * A shared item inside a bubble reads as an *inset* surface: the raised canvas
 * tone with a 1px rule, so it sits back from both bubble fills. Its affordance
 * is the analytical blue link, not gold — gold stays with the composer's send.
 */
const CHIP_SURFACE = {
  background: 'var(--bt-bg-raised)',
  border: '1px solid var(--bt-border-strong)',
  borderRadius: 7,
  padding: '8px 11px',
} as const;

function ShareChipView({ chip }: { chip: ChatChip }) {
  const t = useT();
  if (!chip.viewable) {
    // "Not shared with you" — never leaks the item's name or any data.
    return (
      <div className="flex items-center gap-2.5" style={CHIP_SURFACE}>
        <LockIcon className="h-5 w-5 shrink-0" style={{ color: 'var(--bt-faint)' }} />
        <div className="min-w-0">
          <p className="bt-row-title">{chipKindLabel(t, chip.kind)}</p>
          <p className="bt-row-sub">{t('social.chat.chip.notShared')}</p>
        </div>
      </div>
    );
  }
  return (
    <Link
      className="flex items-center gap-2.5"
      style={{ ...CHIP_SURFACE, textDecoration: 'none' }}
      to={chipHref(chip)}
    >
      <ChipIcon
        kind={chip.kind}
        className="h-5 w-5 shrink-0"
        style={{ color: 'var(--bt-muted)' }}
      />
      <div className="min-w-0 flex-1">
        <p className="bt-row-title truncate">{chip.title ?? chipKindLabel(t, chip.kind)}</p>
        <p className="bt-row-sub truncate">
          {chip.subtitle
            ? `${chipKindLabel(t, chip.kind)} · ${chip.subtitle}`
            : chipKindLabel(t, chip.kind)}
        </p>
      </div>
      <span className="bt-link" style={{ fontSize: 12, fontWeight: 570 }}>
        {t('social.chat.chip.view')}
      </span>
    </Link>
  );
}

// ── Share-in-chat quick-share shortcut (#380) ─────────────────────────────────

/** The two chat participants, narrowed to what the shortcut needs. */
type ChipRecipient = { id: string; username: string };

const isShareKind = (kind: ChatChip['kind']): kind is ShareKind =>
  (SHARE_KINDS as readonly string[]).includes(kind);

/**
 * Offered under the OWNER's own share chip when the recipient can't currently see
 * the item (#380). A one-tap shortcut over the existing AudiencePicker / setAudience
 * (`PUT /social/audience/:kind/:subjectId`): it only ever ADDS this one named
 * friend to the item's audience (private → `specific_friends` + them; or add them
 * to the existing set). The shared audience lattice makes that widening explicit
 * before submit. A current group audience can only be replaced after a specific
 * warning that the group will be lost. Assets carry no audience, so the shortcut
 * never shows for them.
 */
function ChipShareShortcut({ chip, recipient }: { chip: ChatChip; recipient: ChipRecipient }) {
  const t = useT();
  const queryClient = useQueryClient();
  const feedback = useMutationFeedback();
  const shareKind = isShareKind(chip.kind) ? chip.kind : null;

  const audienceQuery = useQuery({
    queryKey: ['social', 'audience', chip.kind, chip.subjectId],
    queryFn: ({ signal }) => getAudience(shareKind!, chip.subjectId, signal),
    enabled: shareKind !== null,
  });
  const state = audienceQuery.data;
  const existing = state?.audience === 'specific_friends' ? state.friendIds : [];
  const friendIds = existing.includes(recipient.id) ? existing : [...existing, recipient.id];
  const nextSelection = { audience: 'specific_friends' as const, friendIds };
  const requiresWidenConfirmation = state
    ? audienceTransitionRequiresConfirmation(state, nextSelection)
    : false;
  const [widenConfirmed, setWidenConfirmed] = useState(false);

  useEffect(() => {
    setWidenConfirmed(false);
  }, [state?.audience, state?.groupId, state?.friendIds.join(':')]);

  const mutation = useMutation({
    mutationFn: () => {
      return setAudience(shareKind!, chip.subjectId, {
        audience: 'specific_friends',
        friendIds,
        confirmWiden: requiresWidenConfirmation ? widenConfirmed : undefined,
      });
    },
    onSuccess: () => {
      // Re-resolve the audience (the prompt vanishes as the recipient is now
      // admitted) and refresh the sharing surfaces the picker also feeds.
      void queryClient.invalidateQueries({ queryKey: ['social'] });
      void queryClient.invalidateQueries({ queryKey: ['workboard'] });
      feedback.success(t('mutationFeedback.sharedWithFriend', { username: recipient.username }));
    },
    onError: (error) => feedback.error(t('social.chat.chip.shortcut.error'), error),
  });

  if (shareKind === null) return null;
  if (!state) return null; // loading, or a read the owner can't make — offer nothing.

  // Mirror the enforcement layer's audience-grant rule: a friend recipient is
  // admitted by `all_friends` / `public_link`, or by `specific_friends` naming
  // them. Anything else (private, or a set without them) means they can't see it.
  const admitted =
    state.audience === 'all_friends' ||
    state.audience === 'public_link' ||
    (state.audience === 'specific_friends' && state.friendIds.includes(recipient.id));
  if (admitted) return null;

  return (
    <div className="flex flex-col items-start gap-1.5" style={CHIP_SURFACE}>
      <p className="bt-meta">
        {t('social.chat.chip.shortcut.prompt', { username: recipient.username })}
      </p>
      {requiresWidenConfirmation ? (
        <label className="bt-meta flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={widenConfirmed}
            onChange={(event) => setWidenConfirmed(event.target.checked)}
          />
          <span>
            {state.audience === 'group'
              ? t('social.chat.chip.shortcut.confirmGroupReplace', {
                  username: recipient.username,
                })
              : t('social.chat.chip.shortcut.confirmWiden', { username: recipient.username })}
          </span>
        </label>
      ) : null}
      <Button
        disabled={mutation.isPending || (requiresWidenConfirmation && !widenConfirmed)}
        onClick={() => mutation.mutate()}
        size="sm"
      >
        {mutation.isPending
          ? t('social.chat.chip.shortcut.sharing')
          : t('social.chat.chip.shortcut.action')}
      </Button>
    </div>
  );
}

// ── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({
  message,
  mine,
  recipient,
}: {
  message: ChatMessage;
  mine: boolean;
  recipient: ChipRecipient | null;
}) {
  return (
    <div className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      {/* Flat surfaces, 8px radii, one clipped corner as the speech tail — the
          only tonal difference between the two speakers is the fill: my own
          messages take the brand's soft gold wash and its accent rule; the
          partner's take the neutral strong surface. */}
      <div
        className="flex max-w-[85%] flex-col gap-1.5 sm:max-w-[70%]"
        style={{
          background: mine ? 'var(--bt-gold-soft)' : 'var(--bt-surface-strong)',
          border: `1px solid ${mine ? 'var(--bt-border-accent)' : 'var(--bt-border)'}`,
          borderRadius: 8,
          [mine ? 'borderBottomRightRadius' : 'borderBottomLeftRadius']: 3,
          padding: '8px 11px',
        }}
      >
        <NormalModeOnly>
          {message.chip ? <ShareChipView chip={message.chip} /> : null}
          {mine && message.chip && recipient ? (
            <ChipShareShortcut chip={message.chip} recipient={recipient} />
          ) : null}
        </NormalModeOnly>
        {message.body ? <p className="whitespace-pre-wrap break-words">{message.body}</p> : null}
        <span className={cx('bt-meta', mine ? 'text-right' : 'text-left')} style={{ fontSize: 11 }}>
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
    // The selected row borrows the navigation rail's own selected language —
    // strong surface only (owner feedback: no edge markings on selection) —
    // everywhere in the suite.
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 text-left"
      style={{
        background: active ? 'var(--bt-surface-strong)' : 'none',
        border: 0,
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        padding: '11px 14px',
        transition: 'background var(--bt-t-fast)',
      }}
    >
      <Avatar name={displayName} iconId={convo.user?.profileIcon ?? null} size="md" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          {/* `.bt-row-title` is declared after `.bt-muted` in origin.css, so a
              deleted partner's dimmed tone has to come from the token directly. */}
          <span
            className="bt-row-title truncate"
            style={{
              color: convo.user ? undefined : 'var(--bt-muted)',
              fontStyle: convo.user ? undefined : 'italic',
              fontWeight: unread ? 700 : 590,
            }}
          >
            {displayName}
          </span>
          {convo.lastMessageAt ? (
            <span className="bt-meta ml-auto shrink-0" style={{ fontSize: 11 }}>
              {formatDateTime(convo.lastMessageAt)}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          <span
            className={cx('truncate', unread ? 'bt-soft' : 'bt-muted')}
            style={{ fontSize: 11.5, fontWeight: unread ? 550 : undefined }}
          >
            {conversationPreview(t, convo, selfId)}
          </span>
          {unread ? (
            <Badge className="ml-auto" tone="gold">
              {convo.unreadCount}
            </Badge>
          ) : null}
        </span>
      </span>
    </button>
  );
}

function NewChatDialog({
  onPick,
  onClose,
}: {
  onPick: (userId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const query = useQuery({
    queryKey: ['social', 'friends'],
    queryFn: ({ signal }) => listFriends(signal),
  });
  const friends = query.data?.friends ?? [];
  return (
    <Dialog phoneSheet title={t('social.chat.new')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="bt-soft">{t('social.chat.newPrompt')}</p>
        <AsyncReadState
          loading={query.isLoading}
          error={query.error}
          errorLabel={t('social.chat.error')}
          onRetry={() => void query.refetch()}
        />
        {!query.isLoading && !query.error && friends.length === 0 ? (
          <p className="bt-meta">{t('social.chat.noFriends')}</p>
        ) : !query.isLoading && !query.error ? (
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {friends.map((f) => (
              <li key={f.user.id}>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onPick(f.user.id);
                  }}
                  className="bt-menu-item"
                  style={{ minHeight: 40 }}
                >
                  <Avatar name={f.user.username} iconId={f.user.profileIcon} size="sm" />
                  <span className="bt-row-title truncate">{f.user.username}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * The conversation list. `onSelect` is the one page-bound decision: the page
 * navigates to the thread's URL, the dock swaps its own pane.
 */
export function ConversationListPane({
  selectedUserId,
  selectedConversationId,
  onSelect,
}: {
  selectedUserId: string | undefined;
  selectedConversationId: string | undefined;
  onSelect: (target: ChatTarget) => void;
}) {
  const t = useT();
  const { user } = useAuth();
  const [newOpen, setNewOpen] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: CONVERSATIONS_KEY,
    queryFn: ({ signal }) => listConversations(signal),
    refetchInterval: LIST_POLL_MS,
  });

  return (
    <div className="bt-panel flex h-full flex-col overflow-hidden">
      <div
        className="bt-b-rule flex items-center justify-between gap-2"
        style={{ padding: '10px 14px' }}
      >
        <h2 className="bt-h3">{t('social.chat.title')}</h2>
        <Button icon="plus" onClick={() => setNewOpen(true)} size="sm" variant="quiet">
          {t('social.chat.new')}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2" style={{ padding: 14 }}>
          <SkeletonBlock height={48} />
          <SkeletonBlock height={48} />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-start gap-2" style={{ padding: 14 }}>
          <Alert tone="error">{t('social.chat.error')}</Alert>
          <Button onClick={() => void refetch()} size="sm">
            {t('common.retry')}
          </Button>
        </div>
      ) : !data || data.conversations.length === 0 ? (
        <EmptyState
          compact
          icon="💬"
          title={t('social.chat.empty.title')}
          description={t('social.chat.empty.body')}
        />
      ) : (
        <ul className="bt-band flex flex-1 flex-col overflow-y-auto">
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
                onClick={() => onSelect(conversationTarget(convo))}
              />
            </li>
          ))}
        </ul>
      )}

      {newOpen ? (
        <NewChatDialog
          onClose={() => setNewOpen(false)}
          onPick={(userId) => onSelect({ userId })}
        />
      ) : null}
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
  const ideasQuery = useQuery({
    queryKey: ['ideas'],
    queryFn: ({ signal }) => listIdeas(signal),
  });

  const portfolios = portfoliosQuery.data?.portfolios ?? [];
  const conglomerates = conglomeratesQuery.data?.conglomerates ?? [];
  const ideas = ideasQuery.data?.ideas ?? [];
  const empty = portfolios.length === 0 && conglomerates.length === 0 && ideas.length === 0;
  const loading = portfoliosQuery.isLoading || conglomeratesQuery.isLoading || ideasQuery.isLoading;
  // The three attachable sources fail independently: each is classified on its
  // own, so a recoverable 5xx keeps its Retry even next to a confirmed
  // rejection, and Retry re-runs only the reads that can actually recover.
  const attachableReads: AsyncRead[] = [
    { error: portfoliosQuery.error, refetch: () => portfoliosQuery.refetch() },
    { error: conglomeratesQuery.error, refetch: () => conglomeratesQuery.refetch() },
    { error: ideasQuery.error, refetch: () => ideasQuery.refetch() },
  ];
  // Any failure at all still suppresses the list: a partial set would read as
  // "this is everything you can attach" when it is not.
  const failed = attachableReads.some((read) => read.error != null);

  function row(item: Attachable) {
    return (
      <li key={`${item.kind}:${item.subjectId}`}>
        <button
          type="button"
          onClick={() => onPick(item)}
          className="bt-menu-item"
          style={{ minHeight: 44 }}
        >
          <ChipIcon
            kind={item.kind}
            className="h-5 w-5 shrink-0"
            style={{ color: 'var(--bt-muted)' }}
          />
          <span className="min-w-0 flex-1">
            <span className="bt-row-title block truncate">{item.name}</span>
            <span className="bt-row-sub block">{chipKindLabel(t, item.kind)}</span>
          </span>
        </button>
      </li>
    );
  }

  return (
    <Dialog phoneSheet title={t('social.chat.share.title')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="bt-meta">{t('social.chat.share.disclaimer')}</p>
        <AsyncReadState
          loading={loading}
          reads={attachableReads}
          errorLabel={t('social.chat.error')}
        />
        {!loading && !failed && empty ? (
          <p className="bt-meta">{t('social.chat.share.empty')}</p>
        ) : !loading && !failed ? (
          <ul className="flex max-h-80 flex-col overflow-y-auto">
            {portfolios.map((p) => row({ kind: 'portfolio', subjectId: p.id, name: p.name }))}
            {conglomerates.map((c) => row({ kind: 'conglomerate', subjectId: c.id, name: c.name }))}
            {ideas.map((i) => row({ kind: 'idea', subjectId: i.id, name: i.name }))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}

// ── Thread ───────────────────────────────────────────────────────────────────

function shouldAutofocusComposer(): boolean {
  // Opening a thread must not summon the software keyboard on a phone or touch
  // device. In browsers without media-query support, retain the desktop default.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return !(
    window.matchMedia('(pointer: coarse)').matches ||
    window.matchMedia('(max-width: 767px)').matches
  );
}

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
  const sharingAllowed = useResolvedPrivacyMode() === 'normal';
  const [text, setText] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const hasBeenEnabledRef = useRef(false);

  // Desktop-only on first open: do not summon a phone's software keyboard.
  // Once a user has interacted with the composer, returning focus after a send
  // still makes retries and consecutive messages effortless on every device.
  useEffect(() => {
    if (disabled) return;
    if (!hasBeenEnabledRef.current) {
      hasBeenEnabledRef.current = true;
      if (!shouldAutofocusComposer()) return;
    }
    inputRef.current?.focus();
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
    <form
      onSubmit={submit}
      className="bt-chat-composer bt-t-rule flex items-end gap-2"
      style={{ padding: 12 }}
    >
      {sharingAllowed ? (
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          disabled={disabled}
          title={t('social.chat.attach')}
          aria-label={t('social.chat.attach')}
          className="bt-btn bt-btn--quiet bt-btn--icon"
        >
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8.5-8.5" />
          </svg>
        </button>
      ) : null}
      {/* Native element (not the `Textarea` primitive) because the composer owns
          a ref for the focus dance; the Origin class carries the same visuals. */}
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            e.nativeEvent.keyCode !== 229
          ) {
            submit(e);
          }
        }}
        rows={1}
        aria-label={t('social.chat.composerLabel')}
        placeholder={t('social.chat.composerPlaceholder')}
        disabled={disabled}
        className="bt-textarea max-h-32 flex-1 resize-none"
        style={{ minHeight: 34 }}
      />
      {/* The composer's send is the one gold action on this screen. */}
      <Button
        className="shrink-0"
        disabled={disabled || !text.trim()}
        type="submit"
        variant="primary"
      >
        {t('social.chat.send')}
      </Button>
      {shareOpen && sharingAllowed ? (
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

/**
 * One open thread. `onBack` is the second page-bound decision: given, the back
 * affordance is a button that returns to the list in place (the dock, at every
 * width); omitted, it stays the page's mobile-only link back to `/people/chat`.
 */
export function ChatThreadPane({
  userId,
  fixedConversationId,
  onBack,
}: {
  userId?: string;
  fixedConversationId?: string;
  onBack?: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const threadRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const previousNewestIdRef = useRef<string | undefined>(undefined);
  const isNearBottomRef = useRef(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);

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

  const scrollToLatest = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
    isNearBottomRef.current = true;
    setHasNewMessages(false);
  }, []);

  function handleThreadScroll() {
    const thread = threadRef.current;
    if (!thread) return;
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 48;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) setHasNewMessages(false);
  }

  // Keep readers anchored only when they are already following the end of the
  // conversation. Initial history and a just-sent message still land at the
  // bottom; otherwise retain the reader's place and offer a compact jump back.
  useEffect(() => {
    if (!newestId) return;
    const previousNewestId = previousNewestIdRef.current;
    previousNewestIdRef.current = newestId;
    if (previousNewestId === newestId) return;

    if (previousNewestId === undefined || isNearBottomRef.current) {
      scrollToLatest();
      return;
    }

    setHasNewMessages(true);
  }, [newestId, scrollToLatest]);

  const sendMutation = useMutation({
    mutationFn: (input: { body?: string; chip?: { kind: ChatChip['kind']; subjectId: string } }) =>
      sendChatMessage(conversationId!, input),
    onSuccess: () => {
      // Sending is an explicit request to continue the conversation, even if
      // the reader had been looking back through history.
      scrollToLatest();
      if (conversationId)
        void queryClient.invalidateQueries({ queryKey: threadKey(conversationId) });
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });

  // A CHAT_BANNED send (403) means an admin banned this account from chat: swap the
  // composer for a neutral notice. Reading + incoming messages are unaffected.
  const banned =
    sendMutation.error instanceof ApiError && sendMutation.error.code === CHAT_BANNED_ERROR_CODE;

  if (convoQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <SkeletonBlock height={96} width={192} />
      </div>
    );
  }

  if (convoQuery.isError && isConfirmedApiOutcome(convoQuery.error)) {
    // A confirmed non-friend / unknown user stays privacy-indistinguishable and
    // calm. Transport/5xx failures below must never manufacture this outcome.
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

  if (convoQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex flex-col items-start gap-3">
          <Alert tone="error">{t('social.chat.error')}</Alert>
          <Button onClick={() => void convoQuery.refetch()}>{t('common.retry')}</Button>
        </div>
      </div>
    );
  }

  const other = convoQuery.data!.user;
  const otherName = other?.username ?? t('social.chat.deletedUser');

  return (
    <div className="bt-chat-thread bt-panel flex h-full flex-col overflow-hidden">
      <div className="bt-b-rule flex items-center gap-3" style={{ padding: '10px 14px' }}>
        {onBack ? (
          <button
            aria-label={t('common.back')}
            className="bt-btn bt-btn--quiet bt-btn--sm bt-btn--icon shrink-0"
            onClick={onBack}
            type="button"
          >
            ←
          </button>
        ) : (
          <Link className="bt-muted md:hidden" to="/people/chat" aria-label={t('common.back')}>
            ←
          </Link>
        )}
        <Avatar name={otherName} iconId={other?.profileIcon ?? null} size="sm" />
        <span
          className="bt-h3"
          style={{
            color: other ? undefined : 'var(--bt-muted)',
            fontStyle: other ? undefined : 'italic',
          }}
        >
          {otherName}
        </span>
      </div>

      <div className="relative flex flex-1 overflow-hidden">
        <div
          ref={threadRef}
          role="log"
          aria-atomic="false"
          aria-label={t('social.chat.logLabel', { username: otherName })}
          aria-live="polite"
          aria-relevant="additions text"
          className="bt-chat-log flex flex-1 flex-col gap-2 overflow-y-auto"
          onScroll={handleThreadScroll}
          style={{ padding: 16 }}
        >
          {threadQuery.hasNextPage ? (
            <Button
              className="mx-auto"
              disabled={threadQuery.isFetchingNextPage}
              onClick={() => void threadQuery.fetchNextPage()}
              size="sm"
              variant="quiet"
            >
              {t('social.chat.loadEarlier')}
            </Button>
          ) : null}

          {threadQuery.isLoading ? (
            <div className="flex flex-col gap-2">
              <SkeletonBlock height={48} />
              <SkeletonBlock height={48} />
            </div>
          ) : threadQuery.isError ? (
            <div className="flex flex-col items-start gap-2">
              <Alert tone="error">{t('social.chat.error')}</Alert>
              <Button onClick={() => void threadQuery.refetch()} size="sm">
                {t('common.retry')}
              </Button>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <Avatar name={otherName} iconId={other?.profileIcon ?? null} size="lg" />
              <p className="bt-h2">{t('social.chat.sayHi', { username: otherName })}</p>
              <p className="bt-meta max-w-xs">{t('social.chat.sayHiBody')}</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {messages.map((m) => (
                <li key={m.id}>
                  <MessageBubble message={m} mine={m.senderId === user?.id} recipient={other} />
                </li>
              ))}
            </ul>
          )}
          <div ref={bottomRef} aria-hidden="true" />
        </div>

        {hasNewMessages ? (
          <Button
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
            onClick={scrollToLatest}
            size="sm"
            type="button"
            variant="quiet"
          >
            {t('social.chat.newMessages')}
          </Button>
        ) : null}
      </div>

      {sendMutation.isError && !banned ? (
        <div style={{ padding: '0 12px 8px' }}>
          <Alert tone="error">{t('social.chat.sendError')}</Alert>
        </div>
      ) : null}

      {banned ? (
        // Admin chat ban (§13.4 V4-P0d): a neutral, localized notice — the server
        // refused the send (CHAT_BANNED). Existing history stays readable above and
        // incoming messages still arrive; only sending is closed off.
        <p className="bt-t-rule bt-meta text-center" style={{ padding: '12px 16px' }}>
          {t('social.chat.banned')}
        </p>
      ) : other ? (
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
        <p className="bt-t-rule bt-meta text-center" style={{ padding: '12px 16px' }}>
          {t('social.chat.deletedClosed')}
        </p>
      )}
    </div>
  );
}

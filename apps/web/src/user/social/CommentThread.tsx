import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  COMMENT_BODY_MAX,
  REACTION_EMOJIS,
  type ReactionEmoji,
  type ShareKind,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { isConfirmedApiOutcome } from '../../lib/apiClient';
import {
  deleteComment,
  getCommentThread,
  getCommentThreadSummary,
  postComment,
  toggleCommentReaction,
  toggleItemReaction,
} from '../../lib/socialApi';
import { formatDateTime } from '../../lib/format';
import { Button, Textarea } from '../../ui/origin';
import { Avatar } from '../components/Avatar';
import { Alert } from '../components/ui';

/**
 * Comments + reactions on a shared item (§13.5 V5-P8). Mounted on the
 * friend-shared read-only pages AND — since #1677 — on the OWNER's My items
 * surface, which is the only place the owner can reach the thread they moderate
 * (every friend-shared page inner-joins friendship, and nobody is their own
 * friend). Never the public-link pages: those stay read-only, §16.
 *
 * The component is viewer-agnostic on purpose. Authorization is entirely
 * server-side, off the item's current audience, and it admits the owner by
 * ownership rather than by a friendship row — so the same endpoints serve both
 * mounts. `canDelete` arrives per comment (author, or the item owner on ALL of
 * them), so the moderation affordance is simply what the server already says.
 *
 * Anti-bloat: the whole surface collapses to a comment count + the compact
 * reaction chips until it is expanded; the thread and composer only render on
 * expand. A collapsed section reads ONLY the cheap summary (count + item
 * reactions) and does not poll: a thread of any length costs nothing until it is
 * opened. `defaultExpanded` is for the mounts that ARE the thread (the owner's
 * dialog, a `comment.created` deep link), where a second click to reveal what
 * the user explicitly opened would be pure friction. On expand the newest page
 * loads and the 30 s poll starts; "load older" walks backwards one page at a
 * time. TanStack Query poll-refetches (no realtime).
 */

const THREAD_POLL_MS = 30_000;

/**
 * A row of the curated six emoji, each a toggle chip with a live count. Origin:
 * a reaction is a selection, not a positive/negative signal — the "on" state is
 * the neutral (raised) button surface with a gold count, never jade/red.
 */
function ReactionChips({
  reactions,
  onToggle,
  pending,
  ariaLabel,
}: {
  reactions: { emoji: ReactionEmoji; count: number; reacted: boolean }[];
  onToggle: (emoji: ReactionEmoji) => void;
  pending: boolean;
  ariaLabel: string;
}) {
  const byEmoji = new Map(reactions.map((r) => [r.emoji, r]));
  return (
    <div
      className="bt-comment-reactions flex flex-wrap items-center gap-1"
      role="group"
      aria-label={ariaLabel}
    >
      {REACTION_EMOJIS.map((emoji) => {
        const r = byEmoji.get(emoji);
        const reacted = r?.reacted ?? false;
        return (
          <Button
            key={emoji}
            disabled={pending}
            aria-pressed={reacted}
            aria-label={emoji}
            onClick={() => onToggle(emoji)}
            size="sm"
            style={{ gap: 5 }}
            variant={reacted ? 'neutral' : 'quiet'}
          >
            <span aria-hidden="true">{emoji}</span>
            {r && r.count > 0 ? (
              <span className={reacted ? 'bt-num bt-gold' : 'bt-num'}>{r.count}</span>
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}

export function CommentThread({
  kind,
  subjectId,
  defaultExpanded = false,
}: {
  kind: ShareKind;
  subjectId: string;
  /** Open the thread immediately — for mounts that ARE the thread (owner dialog). */
  defaultExpanded?: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [draft, setDraft] = useState('');

  // Both queries hang off the same prefix, so one invalidation refreshes the
  // collapsed head and every loaded page together.
  const threadKey = ['social', 'thread', kind, subjectId] as const;
  const {
    data: summary,
    error,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: [...threadKey, 'summary'],
    queryFn: ({ signal }) => getCommentThreadSummary(kind, subjectId, signal),
    retry: false,
  });

  const thread = useInfiniteQuery({
    queryKey: [...threadKey, 'pages'],
    queryFn: ({ pageParam, signal }) => getCommentThread(kind, subjectId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Nothing is fetched — and nothing polls — while the section is collapsed.
    enabled: expanded,
    refetchInterval: expanded ? THREAD_POLL_MS : false,
    retry: false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: threadKey });

  const postMutation = useMutation({
    mutationFn: (body: string) => postComment(kind, subjectId, body),
    onSuccess: () => {
      setDraft('');
      void invalidate();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (commentId: string) => deleteComment(commentId),
    onSuccess: () => void invalidate(),
  });
  const itemReactionMutation = useMutation({
    mutationFn: (emoji: ReactionEmoji) => toggleItemReaction(kind, subjectId, emoji),
    onSuccess: () => void invalidate(),
  });
  const commentReactionMutation = useMutation({
    mutationFn: (vars: { commentId: string; emoji: ReactionEmoji }) =>
      toggleCommentReaction(vars.commentId, vars.emoji),
    onSuccess: () => void invalidate(),
  });

  // A confirmed audience rejection stays invisible: exposing a different state
  // would leak whether the item still exists. A transport/server failure is
  // recoverable, so keep one compact retry row instead of silently removing the
  // entire comments surface.
  if (isError && isConfirmedApiOutcome(error)) return null;
  if (isError) {
    return (
      <section
        className="bt-phone-surface bt-comment-thread bt-t-rule flex flex-col items-start gap-2"
        style={{ paddingTop: 18 }}
      >
        <Alert tone="error">{t('social.comments.loadError')}</Alert>
        <Button onClick={() => void refetch()} size="sm" variant="quiet">
          {t('common.retry')}
        </Button>
      </section>
    );
  }

  // Page 0 is the newest window and carries the authoritative live count, so an
  // expanded thread keeps its header honest off the poll it already runs; the
  // collapsed head falls back to the cheap summary (which never polls).
  const count = thread.data?.pages[0]?.commentCount ?? summary?.commentCount ?? 0;
  const trimmed = draft.trim();
  // Pages arrive newest-first (page 0 is the newest window); render oldest-first.
  const comments = [...(thread.data?.pages ?? [])].reverse().flatMap((page) => page.comments);
  const reactionError = itemReactionMutation.isError || commentReactionMutation.isError;

  return (
    <section
      className="bt-phone-surface bt-comment-thread bt-t-rule flex flex-col gap-3"
      style={{ paddingTop: 18 }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          disabled={isLoading}
          size="sm"
          variant="quiet"
        >
          <span aria-hidden="true">💬</span>
          {isLoading
            ? t('common.loading')
            : t(`social.comments.count.${count === 1 ? 'one' : 'other'}`, { count })}
          <span aria-hidden="true" className="bt-muted">
            {expanded ? '▲' : '▼'}
          </span>
        </Button>
        {summary ? (
          <ReactionChips
            reactions={summary.reactions}
            onToggle={(emoji) => itemReactionMutation.mutate(emoji)}
            pending={itemReactionMutation.isPending}
            ariaLabel={t('social.comments.itemReactionsLabel')}
          />
        ) : null}
      </div>

      {/* A failed toggle must not look like a toggle that simply did nothing. */}
      {reactionError ? (
        <span className="bt-neg" style={{ fontSize: 12 }}>
          {t('social.comments.reactionError')}
        </span>
      ) : null}

      {expanded ? (
        <div className="flex flex-col gap-4">
          {deleteMutation.isError ? (
            <span className="bt-neg" style={{ fontSize: 12 }}>
              {t('social.comments.deleteError')}
            </span>
          ) : null}
          {thread.isLoading ? (
            <p className="bt-meta">{t('common.loading')}</p>
          ) : thread.isError ? (
            <p className="bt-neg">{t('social.comments.loadError')}</p>
          ) : comments.length === 0 ? (
            <p className="bt-meta">{t('social.comments.empty')}</p>
          ) : (
            <ul className="bt-band flex flex-col">
              {thread.hasNextPage ? (
                <li className="py-2">
                  <Button
                    disabled={thread.isFetchingNextPage}
                    onClick={() => void thread.fetchNextPage()}
                    size="sm"
                    variant="quiet"
                  >
                    {thread.isFetchingNextPage
                      ? t('common.loading')
                      : t('social.comments.loadOlder')}
                  </Button>
                </li>
              ) : null}
              {comments.map((comment) => (
                <li key={comment.id} className="bt-comment-row flex gap-3 py-3">
                  <Avatar
                    name={comment.author.username}
                    iconId={comment.author.profileIcon}
                    size="sm"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="bt-row-title">{comment.author.username}</span>
                      <span className="bt-meta">{formatDateTime(comment.createdAt)}</span>
                      {comment.canDelete ? (
                        <Button
                          className="ml-auto"
                          disabled={deleteMutation.isPending}
                          onClick={() => deleteMutation.mutate(comment.id)}
                          size="sm"
                          variant="danger"
                        >
                          {t('social.comments.delete')}
                        </Button>
                      ) : null}
                    </div>
                    <p className="whitespace-pre-wrap break-words">{comment.body}</p>
                    <ReactionChips
                      reactions={comment.reactions}
                      onToggle={(emoji) =>
                        commentReactionMutation.mutate({ commentId: comment.id, emoji })
                      }
                      pending={commentReactionMutation.isPending}
                      ariaLabel={t('social.comments.commentReactionsLabel')}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form
            className="bt-comment-composer flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (trimmed.length > 0) postMutation.mutate(trimmed);
            }}
          >
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={COMMENT_BODY_MAX}
              rows={2}
              placeholder={t('social.comments.placeholder')}
              aria-label={t('social.comments.placeholder')}
            />
            <div className="flex items-center justify-end gap-3">
              {postMutation.isError ? (
                <span className="bt-neg" style={{ fontSize: 12 }}>
                  {t('social.comments.postError')}
                </span>
              ) : null}
              <Button
                type="submit"
                disabled={trimmed.length === 0 || postMutation.isPending}
                variant="primary"
              >
                {postMutation.isPending ? t('social.comments.posting') : t('social.comments.post')}
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

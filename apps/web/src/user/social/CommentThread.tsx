import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  COMMENT_BODY_MAX,
  REACTION_EMOJIS,
  type ReactionEmoji,
  type ShareKind,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import {
  deleteComment,
  getCommentThread,
  postComment,
  toggleCommentReaction,
  toggleItemReaction,
} from '../../lib/socialApi';
import { formatDateTime } from '../../lib/format';
import { Avatar } from '../components/Avatar';
import { cx } from '../components/ui';

/**
 * Comments + reactions on a shared item (§13.5 V5-P8). Mounted ONLY on the
 * friend-shared read-only pages (never the public-link pages — those stay
 * read-only, §16). Anti-bloat: the whole surface is collapsed to a comment count
 * + the compact reaction chips until the viewer expands it; the thread and
 * composer only render on expand. Read/write is authorized server-side by the
 * item's audience — an unauthorized viewer never sees the page, so if this
 * mounts the viewer may participate. TanStack Query poll-refetches (no realtime).
 */

const THREAD_POLL_MS = 30_000;

/** A row of the curated six emoji, each a toggle chip with a live count. */
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
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={ariaLabel}>
      {REACTION_EMOJIS.map((emoji) => {
        const r = byEmoji.get(emoji);
        const reacted = r?.reacted ?? false;
        return (
          <button
            key={emoji}
            type="button"
            disabled={pending}
            aria-pressed={reacted}
            aria-label={emoji}
            onClick={() => onToggle(emoji)}
            className={cx(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition disabled:opacity-50',
              reacted
                ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200'
                : 'border-neutral-700 text-neutral-400 hover:border-neutral-500',
            )}
          >
            <span aria-hidden="true">{emoji}</span>
            {r && r.count > 0 ? <span className="tabular-nums">{r.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function CommentThread({ kind, subjectId }: { kind: ShareKind; subjectId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');

  const threadKey = ['social', 'thread', kind, subjectId] as const;
  const { data, isLoading, isError } = useQuery({
    queryKey: threadKey,
    queryFn: ({ signal }) => getCommentThread(kind, subjectId, signal),
    // Poll refetch is the only freshness mechanism (no realtime for comments).
    refetchInterval: THREAD_POLL_MS,
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

  // The thread 404s for a viewer the audience no longer admits; render nothing
  // rather than a broken shell (the page around it already handles the 404).
  if (isError) return null;

  const count = data?.commentCount ?? 0;
  const trimmed = draft.trim();

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-2 text-sm font-medium text-neutral-200 hover:text-neutral-50"
        >
          <span aria-hidden="true">💬</span>
          {t('social.comments.count', { count })}
          <span aria-hidden="true" className="text-neutral-500">
            {expanded ? '▲' : '▼'}
          </span>
        </button>
        {data ? (
          <ReactionChips
            reactions={data.reactions}
            onToggle={(emoji) => itemReactionMutation.mutate(emoji)}
            pending={itemReactionMutation.isPending}
            ariaLabel={t('social.comments.itemReactionsLabel')}
          />
        ) : null}
      </div>

      {expanded ? (
        <div className="flex flex-col gap-4">
          {isLoading ? (
            <p className="text-sm text-neutral-500">{t('common.loading')}</p>
          ) : count === 0 ? (
            <p className="text-sm text-neutral-500">{t('social.comments.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {data?.comments.map((comment) => (
                <li key={comment.id} className="flex gap-3">
                  <Avatar
                    name={comment.author.username}
                    iconId={comment.author.profileIcon}
                    size="sm"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-neutral-100">
                        {comment.author.username}
                      </span>
                      <span className="text-xs text-neutral-500">
                        {formatDateTime(comment.createdAt)}
                      </span>
                      {comment.canDelete ? (
                        <button
                          type="button"
                          disabled={deleteMutation.isPending}
                          onClick={() => deleteMutation.mutate(comment.id)}
                          className="text-xs text-neutral-500 hover:text-red-400 disabled:opacity-50"
                        >
                          {t('social.comments.delete')}
                        </button>
                      ) : null}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm text-neutral-300">
                      {comment.body}
                    </p>
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
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (trimmed.length > 0) postMutation.mutate(trimmed);
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={COMMENT_BODY_MAX}
              rows={2}
              placeholder={t('social.comments.placeholder')}
              aria-label={t('social.comments.placeholder')}
              className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
            <div className="flex items-center justify-end gap-3">
              {postMutation.isError ? (
                <span className="text-xs text-red-400">{t('social.comments.postError')}</span>
              ) : null}
              <button
                type="submit"
                disabled={trimmed.length === 0 || postMutation.isPending}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
              >
                {postMutation.isPending ? t('social.comments.posting') : t('social.comments.post')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

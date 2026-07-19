import type {
  CommentThreadResponse,
  CreateCommentResponse,
  ItemComment,
  ReactionListResponse,
  ReactionSummary,
  ShareKind,
} from '@bettertrack/contracts';

import { coerceProfileIcon } from '../../http/serializers';
import type { ItemCommentRepository } from '../../data/repositories/itemCommentRepository';
import type {
  ReactionAggregate,
  ItemReactionRepository,
} from '../../data/repositories/itemReactionRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { notFound } from '../../errors';
import type { AudienceService } from './audienceService';

/**
 * Comments + reactions on shared items (§13.5 V5-P8). Every read AND write here
 * derives its authorization ENTIRELY from the item's current audience, resolved
 * through the ONE {@link AudienceService} enforcement layer (fail-closed): a
 * viewer may read/comment/react on an item's thread iff the item's audience
 * currently admits them (a friend the owner shares with) OR they own the item.
 * Narrowing the audience narrows the thread on the very next read — nothing is
 * cached. A public link is read-only and never reaches these endpoints (they all
 * sit behind `requireUser`, and the non-owner path requires a friendship join),
 * so there are no public comments (§16).
 *
 * Not authorized → a uniform 404, never a 403, consistent with every other
 * social read (§6.9 no-enumeration): the thread of an item you can't see is
 * indistinguishable from one that doesn't exist.
 */

export interface CommentServiceDeps {
  comments: ItemCommentRepository;
  reactions: ItemReactionRepository;
  /** The single sharing-enforcement layer — the sole source of read/write authorization. */
  audience: AudienceService;
  /** Public-safe author identity for the just-posted comment echo. */
  userRepo: Pick<UserRepository, 'findById'>;
}

export interface CommentService {
  /** The item's full thread + item-level reactions, or 404 when unauthorized. */
  getThread(viewerId: string, kind: ShareKind, subjectId: string): Promise<CommentThreadResponse>;
  /** Post one comment on an authorized item, or 404 when unauthorized. */
  addComment(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    body: string,
  ): Promise<CreateCommentResponse>;
  /** Soft-delete a comment: its author, or the item owner. 404 otherwise. */
  deleteComment(viewerId: string, commentId: string): Promise<void>;
  /** Toggle the viewer's reaction on an item; returns the fresh aggregate. */
  toggleItemReaction(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    emoji: string,
  ): Promise<ReactionListResponse>;
  /** Toggle the viewer's reaction on a comment; returns the fresh aggregate. */
  toggleCommentReaction(
    viewerId: string,
    commentId: string,
    emoji: string,
  ): Promise<ReactionListResponse>;
}

const THREAD_NOT_FOUND = () => notFound('Not found.', 'NOT_FOUND');
const COMMENT_NOT_FOUND = () => notFound('Comment not found.', 'COMMENT_NOT_FOUND');

/** How a viewer relates to a shared item they may access. */
interface ThreadAccess {
  ownerId: string;
  isOwner: boolean;
}

function toReactionSummaries(aggs: ReactionAggregate[]): ReactionSummary[] {
  return aggs.map((a) => ({ emoji: a.emoji, count: a.count, reacted: a.reacted }));
}

export function createCommentService(deps: CommentServiceDeps): CommentService {
  const { comments, reactions, audience, userRepo } = deps;

  /**
   * The heart of the fail-closed rule: resolve whether `viewerId` may currently
   * read/write the thread of (kind, subjectId), and whether they own the item.
   * The owner is never their own friend, so the friendship-gated audience reads
   * don't grant them — they're admitted here by ownership. `undefined` → 404.
   */
  async function resolveAccess(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
  ): Promise<ThreadAccess | undefined> {
    if (await audience.ownsSubject(viewerId, kind, subjectId)) {
      return { ownerId: viewerId, isOwner: true };
    }
    const shared =
      kind === 'portfolio'
        ? await audience.authorizePortfolioRead(viewerId, subjectId)
        : kind === 'conglomerate'
          ? await audience.authorizeConglomerateRead(viewerId, subjectId)
          : kind === 'idea'
            ? await audience.authorizeIdeaRead(viewerId, subjectId)
            : await audience.authorizeWatchlistRead(viewerId, subjectId);
    if (!shared) return undefined;
    return { ownerId: shared.ownerId, isOwner: false };
  }

  return {
    async getThread(viewerId, kind, subjectId) {
      const access = await resolveAccess(viewerId, kind, subjectId);
      if (!access) throw THREAD_NOT_FOUND();
      const rows = await comments.listForItem(kind, subjectId);
      const reactionMap = await reactions.summaryForComments(
        viewerId,
        rows.map((r) => r.id),
      );
      const itemReactions = await reactions.summaryForItem(viewerId, kind, subjectId);
      const commentList: ItemComment[] = rows.map((row) => ({
        id: row.id,
        author: {
          id: row.authorId,
          username: row.authorUsername,
          profileIcon: coerceProfileIcon(row.authorProfileIcon),
        },
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        // Author deletes their own; the item owner moderates every comment.
        canDelete: access.isOwner || row.authorId === viewerId,
        reactions: toReactionSummaries(reactionMap.get(row.id) ?? []),
      }));
      return {
        kind,
        subjectId,
        commentCount: commentList.length,
        comments: commentList,
        reactions: toReactionSummaries(itemReactions),
      };
    },

    async addComment(viewerId, kind, subjectId, body) {
      const access = await resolveAccess(viewerId, kind, subjectId);
      if (!access) throw THREAD_NOT_FOUND();
      const created = await comments.create(kind, subjectId, viewerId, body);
      const author = await userRepo.findById(viewerId);
      return {
        id: created.id,
        author: {
          id: viewerId,
          username: author?.username ?? '',
          profileIcon: coerceProfileIcon(author?.profileIcon ?? null),
        },
        body,
        createdAt: created.createdAt.toISOString(),
        canDelete: true,
        reactions: [],
      };
    },

    async deleteComment(viewerId, commentId) {
      const comment = await comments.getById(commentId);
      // A tombstoned or unknown comment is a uniform 404 (idempotent re-delete).
      if (!comment || comment.deletedAt) throw COMMENT_NOT_FOUND();
      // Author deletes their own regardless of current visibility (cleanup);
      // the item owner moderates any comment on their item. Anyone else → 404.
      const isAuthor = comment.authorId === viewerId;
      const isOwner = await audience.ownsSubject(viewerId, comment.kind, comment.subjectId);
      if (!isAuthor && !isOwner) throw COMMENT_NOT_FOUND();
      const removed = await comments.softDelete(commentId, viewerId);
      if (!removed) throw COMMENT_NOT_FOUND();
    },

    async toggleItemReaction(viewerId, kind, subjectId, emoji) {
      const access = await resolveAccess(viewerId, kind, subjectId);
      if (!access) throw THREAD_NOT_FOUND();
      await reactions.toggleItem(viewerId, kind, subjectId, emoji);
      const summary = await reactions.summaryForItem(viewerId, kind, subjectId);
      return { reactions: toReactionSummaries(summary) };
    },

    async toggleCommentReaction(viewerId, commentId, emoji) {
      const comment = await comments.getById(commentId);
      if (!comment || comment.deletedAt) throw COMMENT_NOT_FOUND();
      // Reacting needs the SAME access as reading the thread the comment lives in.
      const access = await resolveAccess(viewerId, comment.kind, comment.subjectId);
      if (!access) throw COMMENT_NOT_FOUND();
      await reactions.toggleComment(viewerId, commentId, emoji);
      const summary = await reactions.summaryForComment(viewerId, commentId);
      return { reactions: toReactionSummaries(summary) };
    },
  };
}

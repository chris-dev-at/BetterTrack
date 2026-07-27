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
import type { ParanoidModeGuard } from '../account/paranoidEnforcement';
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
  /** Locks viewer/owner plus optional thread actors across reads and writes. */
  paranoid?: Pick<ParanoidModeGuard, 'runAllowedMany' | 'runAllowedWithOptional'>;
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

  async function withLockedAccess<T>(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    action: (access: ThreadAccess) => Promise<T>,
  ): Promise<T> {
    const candidate = await resolveAccess(viewerId, kind, subjectId);
    if (!candidate) throw THREAD_NOT_FOUND();
    const revalidateAndRun = async () => {
      const access = await resolveAccess(viewerId, kind, subjectId);
      if (!access || access.ownerId !== candidate.ownerId) throw THREAD_NOT_FOUND();
      return action(access);
    };
    return deps.paranoid
      ? deps.paranoid.runAllowedMany([viewerId, candidate.ownerId], 'sharing', revalidateAndRun)
      : revalidateAndRun();
  }

  async function withLockedAccessAndOptionalActors<T>(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    optionalActorIds: readonly string[],
    action: (access: ThreadAccess, allowedActorIds: readonly string[]) => Promise<T>,
    additionalRequiredActorIds: readonly string[] = [],
  ): Promise<T> {
    const candidate = await resolveAccess(viewerId, kind, subjectId);
    if (!candidate) throw THREAD_NOT_FOUND();
    if (!deps.paranoid) {
      return action(candidate, []);
    }
    return deps.paranoid.runAllowedWithOptional(
      [viewerId, candidate.ownerId, ...additionalRequiredActorIds],
      optionalActorIds,
      'sharing',
      async (allowedOptionalActorIds) => {
        const access = await resolveAccess(viewerId, kind, subjectId);
        if (!access || access.ownerId !== candidate.ownerId) throw THREAD_NOT_FOUND();
        return action(access, [
          ...new Set([
            viewerId,
            candidate.ownerId,
            ...additionalRequiredActorIds,
            ...allowedOptionalActorIds,
          ]),
        ]);
      },
    );
  }

  async function buildThread(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    access: ThreadAccess,
    allowedActorIds?: readonly string[],
  ): Promise<CommentThreadResponse> {
    const rows = await comments.listForItem(kind, subjectId, allowedActorIds);
    const reactionMap = await reactions.summaryForComments(
      viewerId,
      rows.map((row) => row.id),
      allowedActorIds,
    );
    const itemReactions = await reactions.summaryForItem(
      viewerId,
      kind,
      subjectId,
      allowedActorIds,
    );
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
  }

  return {
    async getThread(viewerId, kind, subjectId) {
      if (!deps.paranoid) {
        return withLockedAccess(viewerId, kind, subjectId, (access) =>
          buildThread(viewerId, kind, subjectId, access),
        );
      }

      const candidate = await resolveAccess(viewerId, kind, subjectId);
      if (!candidate) throw THREAD_NOT_FOUND();
      // Discover ids without selecting bodies, usernames, profile icons, emojis,
      // or aggregates. Every candidate is optional: a paranoid third-party actor
      // disappears from the thread instead of making unrelated rows fail or
      // revealing their mode. Viewer + item owner remain required.
      const [commentParticipants, reactionActorIds] = await Promise.all([
        comments.listParticipantsForItem(kind, subjectId),
        reactions.listActorIdsForThread(kind, subjectId),
      ]);
      const optionalActorIds = [
        ...new Set([...commentParticipants.map((row) => row.authorId), ...reactionActorIds]),
      ];
      return deps.paranoid.runAllowedWithOptional(
        [viewerId, candidate.ownerId],
        optionalActorIds,
        'sharing',
        async (allowedOptionalActorIds) => {
          const access = await resolveAccess(viewerId, kind, subjectId);
          if (!access || access.ownerId !== candidate.ownerId) throw THREAD_NOT_FOUND();
          // Required principals may themselves have authored/reacted; include
          // them alongside the admitted optional set. SQL filters make a newly
          // appearing, undiscovered actor invisible until the next locked read.
          const allowedActorIds = [
            ...new Set([viewerId, candidate.ownerId, ...allowedOptionalActorIds]),
          ];
          return buildThread(viewerId, kind, subjectId, access, allowedActorIds);
        },
      );
    },

    async addComment(viewerId, kind, subjectId, body) {
      return withLockedAccess(viewerId, kind, subjectId, async () => {
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
      });
    },

    async deleteComment(viewerId, commentId) {
      const candidate = await comments.getById(commentId);
      // A tombstoned or unknown comment is a uniform 404 (idempotent re-delete).
      if (!candidate || candidate.deletedAt) throw COMMENT_NOT_FOUND();
      const ownerId = await audience.subjectOwner(candidate.kind, candidate.subjectId);
      if (!ownerId) throw COMMENT_NOT_FOUND();
      const remove = async () => {
        const comment = await comments.getById(commentId);
        if (
          !comment ||
          comment.deletedAt ||
          comment.kind !== candidate.kind ||
          comment.subjectId !== candidate.subjectId
        ) {
          throw COMMENT_NOT_FOUND();
        }
        const currentOwnerId = await audience.subjectOwner(comment.kind, comment.subjectId);
        if (currentOwnerId !== ownerId) throw COMMENT_NOT_FOUND();
        // Author deletes their own regardless of current visibility (cleanup);
        // the item owner moderates any comment on their item. Anyone else → 404.
        const isAuthor = comment.authorId === viewerId;
        const isOwner = ownerId === viewerId;
        if (!isAuthor && !isOwner) throw COMMENT_NOT_FOUND();
        const removed = await comments.softDelete(commentId, viewerId);
        if (!removed) throw COMMENT_NOT_FOUND();
      };
      return deps.paranoid
        ? deps.paranoid.runAllowedMany([viewerId, ownerId], 'sharing', remove)
        : remove();
    },

    async toggleItemReaction(viewerId, kind, subjectId, emoji) {
      if (!deps.paranoid) {
        return withLockedAccess(viewerId, kind, subjectId, async () => {
          await reactions.toggleItem(viewerId, kind, subjectId, emoji);
          const summary = await reactions.summaryForItem(viewerId, kind, subjectId);
          return { reactions: toReactionSummaries(summary) };
        });
      }
      const reactionActorIds = await reactions.listActorIdsForItem(kind, subjectId);
      return withLockedAccessAndOptionalActors(
        viewerId,
        kind,
        subjectId,
        reactionActorIds,
        async (_access, allowedActorIds) => {
          await reactions.toggleItem(viewerId, kind, subjectId, emoji);
          const summary = await reactions.summaryForItem(
            viewerId,
            kind,
            subjectId,
            allowedActorIds,
          );
          return { reactions: toReactionSummaries(summary) };
        },
      );
    },

    async toggleCommentReaction(viewerId, commentId, emoji) {
      const candidate = await comments.getById(commentId);
      if (!candidate || candidate.deletedAt) throw COMMENT_NOT_FOUND();
      if (!deps.paranoid) {
        // Reacting needs the SAME access as reading the thread the comment lives in.
        return withLockedAccess(viewerId, candidate.kind, candidate.subjectId, async () => {
          await reactions.toggleComment(viewerId, commentId, emoji);
          const summary = await reactions.summaryForComment(viewerId, commentId);
          return { reactions: toReactionSummaries(summary) };
        });
      }
      const reactionActorIds = await reactions.listActorIdsForComment(commentId);
      return withLockedAccessAndOptionalActors(
        viewerId,
        candidate.kind,
        candidate.subjectId,
        reactionActorIds,
        async (_access, allowedActorIds) => {
          const comment = await comments.getById(commentId);
          if (
            !comment ||
            comment.deletedAt ||
            comment.kind !== candidate.kind ||
            comment.subjectId !== candidate.subjectId ||
            comment.authorId !== candidate.authorId
          ) {
            throw COMMENT_NOT_FOUND();
          }
          await reactions.toggleComment(viewerId, commentId, emoji);
          const summary = await reactions.summaryForComment(viewerId, commentId, allowedActorIds);
          return { reactions: toReactionSummaries(summary) };
        },
        [candidate.authorId],
      );
    },
  };
}

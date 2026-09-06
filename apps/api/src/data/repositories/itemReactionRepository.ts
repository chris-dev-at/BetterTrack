import { and, eq, exists, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';

import type { ReactionEmoji, ShareKind } from '@bettertrack/contracts';

import type { Database } from '../db';
import { itemComments, itemReactions, users } from '../schema';

/**
 * Reaction SQL (§13.5 V5-P8). The ONE `item_reactions` table serves reactions on
 * a shared item AND on a comment, discriminated by `target_type`. Authorization
 * (only the item's audience may react) lives in the comment service; here we
 * just toggle and aggregate. The curated emoji set is enforced by the contract,
 * so any string that reaches these methods is already one of the fixed six.
 */

/** One emoji's aggregate: how many reacted + whether the viewer did. */
export interface ReactionAggregate {
  emoji: ReactionEmoji;
  count: number;
  reacted: boolean;
}

/** Reduce raw (emoji, count, mine) rows into the sorted aggregate the API returns. */
function toAggregates(
  rows: { emoji: string; count: number; reacted: boolean }[],
): ReactionAggregate[] {
  return rows.map((r) => ({
    emoji: r.emoji as ReactionEmoji,
    count: r.count,
    reacted: r.reacted,
  }));
}

export function createItemReactionRepository(db: Database) {
  /**
   * "Is any NOT-normal account a reactor here?" — driven from `users` so the
   * partial `users_privacy_mode_restricted_idx` (migration 0113) answers it out
   * of an index that is empty on a deployment with no paranoid account. The
   * caller supplies the participation test as a correlated `EXISTS` on
   * `users.id`; nothing but that one boolean leaves this query (#1829).
   */
  async function restrictedActorExists(participates: SQL): Promise<boolean> {
    const rows = await db
      .select({ one: sql<number>`1` })
      .from(users)
      .where(and(ne(users.privacyMode, 'normal'), participates))
      .limit(1);
    return rows.length > 0;
  }

  return {
    /**
     * Identity-only discovery for actors contributing to one item aggregate.
     * `limit` is a hard ceiling: the caller locks one `users` row per id it gets
     * back, so an unbounded list would be an unbounded transaction (#1829). A
     * full `limit` rows means "truncated" — the caller must fail closed.
     */
    async listActorIdsForItem(
      kind: ShareKind,
      subjectId: string,
      limit: number,
    ): Promise<string[]> {
      const rows = await db
        .selectDistinct({ userId: itemReactions.userId })
        .from(itemReactions)
        .where(
          and(
            eq(itemReactions.targetType, 'item'),
            eq(itemReactions.kind, kind),
            eq(itemReactions.subjectId, subjectId),
          ),
        )
        .limit(limit);
      return rows.map((row) => row.userId);
    },

    /** @see listActorIdsForItem — the same bounded discovery for one comment. */
    async listActorIdsForComment(commentId: string, limit: number): Promise<string[]> {
      const rows = await db
        .selectDistinct({ userId: itemReactions.userId })
        .from(itemReactions)
        .where(and(eq(itemReactions.targetType, 'comment'), eq(itemReactions.commentId, commentId)))
        .limit(limit);
      return rows.map((row) => row.userId);
    },

    /**
     * Identity-only discovery for every live participant whose reaction could
     * contribute to an item thread. No emoji, body, profile, or aggregate is
     * selected before the service holds the participant privacy locks. Each half
     * carries the caller's ceiling, so the union can exceed `limit` by at most
     * one entry — enough for the caller to SEE the truncation and fail closed.
     */
    async listActorIdsForThread(
      kind: ShareKind,
      subjectId: string,
      limit: number,
    ): Promise<string[]> {
      const [itemActors, commentActors] = await Promise.all([
        db
          .selectDistinct({ userId: itemReactions.userId })
          .from(itemReactions)
          .where(
            and(
              eq(itemReactions.targetType, 'item'),
              eq(itemReactions.kind, kind),
              eq(itemReactions.subjectId, subjectId),
            ),
          )
          .limit(limit),
        db
          .selectDistinct({ userId: itemReactions.userId })
          .from(itemReactions)
          .innerJoin(itemComments, eq(itemComments.id, itemReactions.commentId))
          .where(
            and(
              eq(itemReactions.targetType, 'comment'),
              eq(itemComments.kind, kind),
              eq(itemComments.subjectId, subjectId),
              isNull(itemComments.deletedAt),
            ),
          )
          .limit(limit),
      ]);
      return [...new Set([...itemActors, ...commentActors].map((row) => row.userId))];
    },

    /**
     * Does ANY reaction on this item come from an account that is not in the
     * `normal` privacy mode? The reaction half of the probe that lets a thread
     * read skip participant enumeration and per-participant locks entirely
     * (#1829, see `itemCommentRepository.hasRestrictedParticipant`).
     */
    async hasRestrictedItemActor(kind: ShareKind, subjectId: string): Promise<boolean> {
      return restrictedActorExists(
        exists(
          db
            .select({ one: sql<number>`1` })
            .from(itemReactions)
            .where(
              and(
                eq(itemReactions.userId, users.id),
                eq(itemReactions.targetType, 'item'),
                eq(itemReactions.kind, kind),
                eq(itemReactions.subjectId, subjectId),
              ),
            ),
        ),
      );
    },

    /** @see hasRestrictedItemActor — the same probe over ONE comment's reactions. */
    async hasRestrictedCommentActor(commentId: string): Promise<boolean> {
      return restrictedActorExists(
        exists(
          db
            .select({ one: sql<number>`1` })
            .from(itemReactions)
            .where(
              and(
                eq(itemReactions.userId, users.id),
                eq(itemReactions.targetType, 'comment'),
                eq(itemReactions.commentId, commentId),
              ),
            ),
        ),
      );
    },

    /**
     * @see hasRestrictedItemActor — the same probe over the WHOLE thread: the
     * item's own reactions and the reactions on its live comments.
     */
    async hasRestrictedThreadActor(kind: ShareKind, subjectId: string): Promise<boolean> {
      const [onItem, onComments] = await Promise.all([
        this.hasRestrictedItemActor(kind, subjectId),
        restrictedActorExists(
          exists(
            db
              .select({ one: sql<number>`1` })
              .from(itemReactions)
              .innerJoin(itemComments, eq(itemComments.id, itemReactions.commentId))
              .where(
                and(
                  eq(itemReactions.userId, users.id),
                  eq(itemReactions.targetType, 'comment'),
                  eq(itemComments.kind, kind),
                  eq(itemComments.subjectId, subjectId),
                  isNull(itemComments.deletedAt),
                ),
              ),
          ),
        ),
      ]);
      return onItem || onComments;
    },

    /**
     * Toggle the viewer's reaction on an ITEM: remove it if present, else add it.
     * Idempotent per (user, item, emoji) via the partial unique index.
     */
    async toggleItem(
      userId: string,
      kind: ShareKind,
      subjectId: string,
      emoji: string,
    ): Promise<void> {
      const removed = await db
        .delete(itemReactions)
        .where(
          and(
            eq(itemReactions.userId, userId),
            eq(itemReactions.targetType, 'item'),
            eq(itemReactions.kind, kind),
            eq(itemReactions.subjectId, subjectId),
            eq(itemReactions.emoji, emoji),
          ),
        )
        .returning({ id: itemReactions.id });
      if (removed.length > 0) return;
      await db
        .insert(itemReactions)
        .values({ userId, targetType: 'item', kind, subjectId, emoji })
        .onConflictDoNothing();
    },

    /** Toggle the viewer's reaction on a COMMENT. */
    async toggleComment(userId: string, commentId: string, emoji: string): Promise<void> {
      const removed = await db
        .delete(itemReactions)
        .where(
          and(
            eq(itemReactions.userId, userId),
            eq(itemReactions.targetType, 'comment'),
            eq(itemReactions.commentId, commentId),
            eq(itemReactions.emoji, emoji),
          ),
        )
        .returning({ id: itemReactions.id });
      if (removed.length > 0) return;
      await db
        .insert(itemReactions)
        .values({ userId, targetType: 'comment', commentId, emoji })
        .onConflictDoNothing();
    },

    /**
     * Does the viewer currently hold exactly this reaction on this item? The
     * question the withdrawal path asks BEFORE it deletes anything, so a caller
     * the item no longer admits — or never did — cannot drive a write against a
     * subject id they merely named (#1829). It reads one row through the same
     * `item_reactions_item_unique` index the delete uses, and it answers about
     * the CALLER's own row only: nothing here can describe anybody else.
     */
    async hasOwnItemReaction(
      userId: string,
      kind: ShareKind,
      subjectId: string,
      emoji: string,
    ): Promise<boolean> {
      const rows = await db
        .select({ one: sql<number>`1` })
        .from(itemReactions)
        .where(
          and(
            eq(itemReactions.userId, userId),
            eq(itemReactions.targetType, 'item'),
            eq(itemReactions.kind, kind),
            eq(itemReactions.subjectId, subjectId),
            eq(itemReactions.emoji, emoji),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    /** @see hasOwnItemReaction — the same own-row question for a COMMENT reaction. */
    async hasOwnCommentReaction(
      userId: string,
      commentId: string,
      emoji: string,
    ): Promise<boolean> {
      const rows = await db
        .select({ one: sql<number>`1` })
        .from(itemReactions)
        .where(
          and(
            eq(itemReactions.userId, userId),
            eq(itemReactions.targetType, 'comment'),
            eq(itemReactions.commentId, commentId),
            eq(itemReactions.emoji, emoji),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    /**
     * Remove — never add — the viewer's OWN reaction on an item. The withdrawal
     * half of {@link toggleItem}, split out because taking a reaction back is a
     * cleanup right that survives the item's audience narrowing, exactly like
     * deleting your own comment (§13.5 V5-P8, #1780). Returns whether a row went,
     * which is also what tells the caller this was a withdrawal rather than a new
     * reaction — decided by the delete itself, so there is no check-then-act
     * window in which the toggle could flip.
     */
    async removeItem(
      userId: string,
      kind: ShareKind,
      subjectId: string,
      emoji: string,
    ): Promise<boolean> {
      const removed = await db
        .delete(itemReactions)
        .where(
          and(
            eq(itemReactions.userId, userId),
            eq(itemReactions.targetType, 'item'),
            eq(itemReactions.kind, kind),
            eq(itemReactions.subjectId, subjectId),
            eq(itemReactions.emoji, emoji),
          ),
        )
        .returning({ id: itemReactions.id });
      return removed.length > 0;
    },

    /** @see removeItem — the same withdrawal-only path for a COMMENT reaction. */
    async removeComment(userId: string, commentId: string, emoji: string): Promise<boolean> {
      const removed = await db
        .delete(itemReactions)
        .where(
          and(
            eq(itemReactions.userId, userId),
            eq(itemReactions.targetType, 'comment'),
            eq(itemReactions.commentId, commentId),
            eq(itemReactions.emoji, emoji),
          ),
        )
        .returning({ id: itemReactions.id });
      return removed.length > 0;
    },

    /**
     * Drop every reaction hanging off ONE comment. Runs when that comment is
     * moderated away (§13.5 V5-P8, #1780): the tombstone keeps the row for
     * auditability, but every read filters tombstoned comments out, so their
     * reactions become unreachable AND unremovable — the toggle 404s on a
     * tombstone and no sweep exists. `exec` lets the caller run this inside the
     * soft-delete transaction, so the cleared body and the removed reactions
     * commit together.
     */
    async deleteForComment(commentId: string, exec: Database = db): Promise<void> {
      await exec
        .delete(itemReactions)
        .where(
          and(eq(itemReactions.targetType, 'comment'), eq(itemReactions.commentId, commentId)),
        );
    },

    /** Aggregate an item's reactions from the viewer's perspective. */
    async summaryForItem(
      viewerId: string,
      kind: ShareKind,
      subjectId: string,
      actorIds?: readonly string[],
    ): Promise<ReactionAggregate[]> {
      if (actorIds?.length === 0) return [];
      const rows = await db
        .select({
          emoji: itemReactions.emoji,
          count: sql<number>`count(*)::int`,
          reacted: sql<boolean>`bool_or(${itemReactions.userId} = ${viewerId})`,
        })
        .from(itemReactions)
        .where(
          and(
            eq(itemReactions.targetType, 'item'),
            eq(itemReactions.kind, kind),
            eq(itemReactions.subjectId, subjectId),
            actorIds ? inArray(itemReactions.userId, [...actorIds]) : undefined,
          ),
        )
        .groupBy(itemReactions.emoji)
        .orderBy(itemReactions.emoji);
      return toAggregates(rows);
    },

    /**
     * Aggregate reactions for a set of comments in ONE query, from the viewer's
     * perspective. Returns a map keyed by comment id (missing = no reactions).
     */
    async summaryForComments(
      viewerId: string,
      commentIds: readonly string[],
      actorIds?: readonly string[],
    ): Promise<Map<string, ReactionAggregate[]>> {
      const out = new Map<string, ReactionAggregate[]>();
      if (commentIds.length === 0 || actorIds?.length === 0) return out;
      const rows = await db
        .select({
          commentId: itemReactions.commentId,
          emoji: itemReactions.emoji,
          count: sql<number>`count(*)::int`,
          reacted: sql<boolean>`bool_or(${itemReactions.userId} = ${viewerId})`,
        })
        .from(itemReactions)
        .where(
          and(
            eq(itemReactions.targetType, 'comment'),
            inArray(itemReactions.commentId, [...commentIds]),
            actorIds ? inArray(itemReactions.userId, [...actorIds]) : undefined,
          ),
        )
        .groupBy(itemReactions.commentId, itemReactions.emoji)
        .orderBy(itemReactions.emoji);
      for (const r of rows) {
        if (!r.commentId) continue;
        const list = out.get(r.commentId) ?? [];
        list.push({ emoji: r.emoji as ReactionEmoji, count: r.count, reacted: r.reacted });
        out.set(r.commentId, list);
      }
      return out;
    },

    /** Aggregate one comment's reactions (the toggle response). */
    async summaryForComment(
      viewerId: string,
      commentId: string,
      actorIds?: readonly string[],
    ): Promise<ReactionAggregate[]> {
      const map = await this.summaryForComments(viewerId, [commentId], actorIds);
      return map.get(commentId) ?? [];
    },
  };
}

export type ItemReactionRepository = ReturnType<typeof createItemReactionRepository>;

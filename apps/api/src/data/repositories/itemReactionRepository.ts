import { and, eq, inArray, sql } from 'drizzle-orm';

import type { ReactionEmoji, ShareKind } from '@bettertrack/contracts';

import type { Database } from '../db';
import { itemReactions } from '../schema';

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
  return {
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

    /** Aggregate an item's reactions from the viewer's perspective. */
    async summaryForItem(
      viewerId: string,
      kind: ShareKind,
      subjectId: string,
    ): Promise<ReactionAggregate[]> {
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
    ): Promise<Map<string, ReactionAggregate[]>> {
      const out = new Map<string, ReactionAggregate[]>();
      if (commentIds.length === 0) return out;
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
    async summaryForComment(viewerId: string, commentId: string): Promise<ReactionAggregate[]> {
      const map = await this.summaryForComments(viewerId, [commentId]);
      return map.get(commentId) ?? [];
    },
  };
}

export type ItemReactionRepository = ReturnType<typeof createItemReactionRepository>;

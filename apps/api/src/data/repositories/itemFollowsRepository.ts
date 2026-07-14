import { and, desc, eq } from 'drizzle-orm';

import type { ShareKind } from '@bettertrack/contracts';

import type { Database } from '../db';
import { itemFollows } from '../schema';

/**
 * Item-follow SQL (#439) — bookmarks of other people's shareable items. All
 * `item_follows` queries live here; the rules (only currently-visible items are
 * followable, never your own, viewable-at-read-time) live in the social/audience
 * services. A row grants no read access, so — like the person-follow repository —
 * there is no authorization join here.
 */

/** One raw item-follow row — the subject triple + when it was bookmarked. */
export interface ItemFollowListRow {
  kind: ShareKind;
  subjectId: string;
  createdAt: Date;
}

export function createItemFollowsRepository(db: Database) {
  return {
    /**
     * Record an item follow. Idempotent against the composite PK: a repeat
     * follow — manual or from the auto-follow fan-out — is a no-op (never a
     * duplicate-key crash). Returns whether a NEW row was created.
     */
    async follow(userId: string, kind: ShareKind, subjectId: string): Promise<boolean> {
      const rows = await db
        .insert(itemFollows)
        .values({ userId, kind, subjectId })
        .onConflictDoNothing()
        .returning({ userId: itemFollows.userId });
      return rows.length > 0;
    },

    /** Remove an item follow. Returns whether a row was removed (service 404s a non-follow). */
    async unfollow(userId: string, kind: ShareKind, subjectId: string): Promise<boolean> {
      const rows = await db
        .delete(itemFollows)
        .where(
          and(
            eq(itemFollows.userId, userId),
            eq(itemFollows.kind, kind),
            eq(itemFollows.subjectId, subjectId),
          ),
        )
        .returning({ userId: itemFollows.userId });
      return rows.length > 0;
    },

    /** The caller's followed items, newest bookmark first. Raw triples — no join. */
    async list(userId: string): Promise<ItemFollowListRow[]> {
      return db
        .select({
          kind: itemFollows.kind,
          subjectId: itemFollows.subjectId,
          createdAt: itemFollows.createdAt,
        })
        .from(itemFollows)
        .where(eq(itemFollows.userId, userId))
        .orderBy(desc(itemFollows.createdAt));
    },

    /**
     * Purge every follow of one subject on subject deletion (hygiene — reads
     * already degrade to `viewable: false` while a stale row lingers). Called
     * through the audience layer's `clearForSubject`, alongside the audience row.
     */
    async clearForSubject(kind: ShareKind, subjectId: string): Promise<void> {
      await db
        .delete(itemFollows)
        .where(and(eq(itemFollows.kind, kind), eq(itemFollows.subjectId, subjectId)));
    },
  };
}

export type ItemFollowsRepository = ReturnType<typeof createItemFollowsRepository>;

import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';

import type { ShareKind } from '@bettertrack/contracts';

import type { Database } from '../db';
import { itemFollows, portfolios } from '../schema';
import { ownedSubjectsPredicate } from './shareAudienceRepository';

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

    /**
     * The caller's followed items, newest bookmark first. A stale bookmark for a
     * locked portfolio is absent rather than rendered as an unavailable shell:
     * vault membership permanently removes the portfolio from every sharing /
     * discovery surface. Missing and merely unshared subjects retain the legacy
     * shell behavior so callers can still clean those bookmarks up.
     */
    async list(userId: string): Promise<ItemFollowListRow[]> {
      return db
        .select({
          kind: itemFollows.kind,
          subjectId: itemFollows.subjectId,
          createdAt: itemFollows.createdAt,
        })
        .from(itemFollows)
        .leftJoin(
          portfolios,
          and(eq(itemFollows.kind, 'portfolio'), eq(itemFollows.subjectId, portfolios.id)),
        )
        .where(
          and(
            eq(itemFollows.userId, userId),
            or(ne(itemFollows.kind, 'portfolio'), isNull(portfolios.vaultId)),
          ),
        )
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

    /**
     * Purge every follow of every subject one owner holds — account teardown's
     * counterpart of `clearForSubject` (#1724). Like the comment/reaction rows,
     * `item_follows` keys to its subject polymorphically, so only the departing
     * user's OWN bookmarks cascade with the `users` row; the bookmarks other
     * users hold on the vanished items would linger forever. One statement over
     * an id subquery per kind, so subject count does not drive query count.
     */
    async clearForOwner(ownerId: string): Promise<void> {
      await db.delete(itemFollows).where(
        ownedSubjectsPredicate(db, ownerId, {
          kind: itemFollows.kind,
          subjectId: itemFollows.subjectId,
        }),
      );
    },
  };
}

export type ItemFollowsRepository = ReturnType<typeof createItemFollowsRepository>;

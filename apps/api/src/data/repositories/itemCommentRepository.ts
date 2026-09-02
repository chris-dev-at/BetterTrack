import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { ShareKind } from '@bettertrack/contracts';

import type { Database } from '../db';
import { itemComments, users } from '../schema';

/**
 * Comment SQL (§13.5 V5-P8). All `item_comments` reads/writes live here; the
 * authorization (a comment is visible to exactly the item's audience, delete-own,
 * item-owner moderates all) lives in the comment service, which resolves it
 * through the ONE audience-enforcement layer. `subject_id` is polymorphic (no
 * FK), so a comment thread is keyed by (kind, subject_id) exactly like an
 * audience row. Deleted comments are tombstoned, never row-deleted, and every
 * read filters them out.
 */

/** One live comment joined to its author's public-safe identity. */
export interface CommentRow {
  id: string;
  authorId: string;
  authorUsername: string;
  authorProfileIcon: string | null;
  body: string;
  createdAt: Date;
}

/** A comment's identity for the delete/react authorization decision. */
export interface CommentSubjectRef {
  id: string;
  kind: ShareKind;
  subjectId: string;
  authorId: string;
  deletedAt: Date | null;
}

/** One bounded thread read: page size, optional cursor, optional actor snapshot. */
export interface CommentPageOptions {
  limit: number;
  /** Id of the oldest comment of the previous page; its key is resolved in SQL. */
  before?: string;
  authorIds?: readonly string[];
}

export function createItemCommentRepository(db: Database) {
  return {
    /** Insert one comment; returns its id + created timestamp. */
    async create(
      kind: ShareKind,
      subjectId: string,
      authorId: string,
      body: string,
    ): Promise<{ id: string; createdAt: Date }> {
      const [row] = await db
        .insert(itemComments)
        .values({ kind, subjectId, authorId, body })
        .returning({ id: itemComments.id, createdAt: itemComments.createdAt });
      return row!;
    },

    /**
     * ONE bounded page of LIVE comments on an item, NEWEST-first, joined to the
     * author identity — a thread is never read whole (§13.5 V5-P8 anti-bloat +
     * scale). `before` is the ID of the oldest row of the previous page and its
     * ordering key is resolved IN SQL, so paging walks backwards on the composite
     * (created_at, id) key at the database's own microsecond precision. Carrying
     * the timestamp in the cursor instead would truncate it to milliseconds on
     * the JS `Date` round trip and silently drop every row sitting between the
     * truncated value and the boundary row's real key. `authorIds` is the
     * transition-locked participant snapshot; an author who was not admitted by
     * that snapshot is never enriched here. The caller reverses the page when it
     * wants oldest-first render order.
     *
     * The cursor row is looked up within this same thread and WITHOUT the
     * tombstone filter (a soft-deleted boundary row must still anchor the walk).
     * A cursor naming no such row resolves to NULL, which makes the comparison
     * NULL and yields an empty page — fail-closed, never a silent full read.
     */
    async listForItem(
      kind: ShareKind,
      subjectId: string,
      options: CommentPageOptions,
    ): Promise<CommentRow[]> {
      const { limit, before, authorIds } = options;
      if (authorIds?.length === 0 || limit <= 0) return [];
      const cursorKey =
        before === undefined
          ? undefined
          : db
              .select({ createdAt: itemComments.createdAt, id: itemComments.id })
              .from(itemComments)
              .where(
                and(
                  eq(itemComments.id, before),
                  eq(itemComments.kind, kind),
                  eq(itemComments.subjectId, subjectId),
                ),
              );
      return db
        .select({
          id: itemComments.id,
          authorId: itemComments.authorId,
          authorUsername: users.username,
          authorProfileIcon: users.profileIcon,
          body: itemComments.body,
          createdAt: itemComments.createdAt,
        })
        .from(itemComments)
        .innerJoin(users, eq(users.id, itemComments.authorId))
        .where(
          and(
            eq(itemComments.kind, kind),
            eq(itemComments.subjectId, subjectId),
            isNull(itemComments.deletedAt),
            authorIds ? inArray(itemComments.authorId, [...authorIds]) : undefined,
            cursorKey
              ? // drizzle parenthesizes an embedded query builder itself, giving
                // Postgres its `row_constructor < (subquery)` comparison form.
                sql`(${itemComments.createdAt}, ${itemComments.id}) < ${cursorKey}`
              : undefined,
          ),
        )
        .orderBy(desc(itemComments.createdAt), desc(itemComments.id))
        .limit(limit);
    },

    /**
     * The DISTINCT live authors of one item's thread — ids only, no content.
     * Thread reads use this non-content discovery query to acquire optional
     * author/reaction locks before loading a body or profile identity. Distinct
     * by author, so it is bounded by the item's audience rather than by how many
     * comments the thread has accumulated.
     */
    async listParticipantsForItem(kind: ShareKind, subjectId: string): Promise<string[]> {
      const rows = await db
        .selectDistinct({ authorId: itemComments.authorId })
        .from(itemComments)
        .where(
          and(
            eq(itemComments.kind, kind),
            eq(itemComments.subjectId, subjectId),
            isNull(itemComments.deletedAt),
          ),
        );
      return rows.map((row) => row.authorId);
    },

    /**
     * Count of LIVE comments on one item — the collapsed-count UI and the paged
     * thread's `commentCount` both read it, so neither has to load bodies.
     * `authorIds` applies the SAME participant snapshot the page read uses, so a
     * count can never disclose a comment the page itself filters out.
     */
    async countForItem(
      kind: ShareKind,
      subjectId: string,
      authorIds?: readonly string[],
    ): Promise<number> {
      if (authorIds?.length === 0) return 0;
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(itemComments)
        .where(
          and(
            eq(itemComments.kind, kind),
            eq(itemComments.subjectId, subjectId),
            isNull(itemComments.deletedAt),
            authorIds ? inArray(itemComments.authorId, [...authorIds]) : undefined,
          ),
        );
      return row?.n ?? 0;
    },

    /** Resolve a comment's identity (kind/subject/author + tombstone), or undefined. */
    async getById(commentId: string): Promise<CommentSubjectRef | undefined> {
      const [row] = await db
        .select({
          id: itemComments.id,
          kind: itemComments.kind,
          subjectId: itemComments.subjectId,
          authorId: itemComments.authorId,
          deletedAt: itemComments.deletedAt,
        })
        .from(itemComments)
        .where(eq(itemComments.id, commentId));
      return row;
    },

    /**
     * Soft-delete one LIVE comment, stamping who removed it. Returns whether a
     * row transitioned (a second delete is a no-op → false). The caller has
     * already proven the deleter may moderate (author or item owner).
     */
    async softDelete(commentId: string, deletedBy: string): Promise<boolean> {
      const rows = await db
        .update(itemComments)
        .set({ deletedAt: new Date(), deletedBy })
        .where(and(eq(itemComments.id, commentId), isNull(itemComments.deletedAt)))
        .returning({ id: itemComments.id });
      return rows.length > 0;
    },
  };
}

export type ItemCommentRepository = ReturnType<typeof createItemCommentRepository>;

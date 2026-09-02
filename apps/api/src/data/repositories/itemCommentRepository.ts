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

/** The oldest comment of the page just read — where the next older page starts. */
export interface CommentPageCursor {
  createdAt: Date;
  id: string;
}

/** One bounded thread read: page size, optional cursor, optional actor snapshot. */
export interface CommentPageOptions {
  limit: number;
  before?: CommentPageCursor;
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
     * scale). `before` names the oldest row of the previous page, so paging walks
     * backwards through the conversation on the composite (created_at, id) key —
     * stable even when two comments share a timestamp. `authorIds` is the
     * transition-locked participant snapshot; an author who was not admitted by
     * that snapshot is never enriched here. The caller reverses the page when it
     * wants oldest-first render order.
     */
    async listForItem(
      kind: ShareKind,
      subjectId: string,
      options: CommentPageOptions,
    ): Promise<CommentRow[]> {
      const { limit, before, authorIds } = options;
      if (authorIds?.length === 0 || limit <= 0) return [];
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
            before
              ? sql`(${itemComments.createdAt}, ${itemComments.id}) < (${before.createdAt.toISOString()}::timestamptz, ${before.id}::uuid)`
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

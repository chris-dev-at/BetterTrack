import { and, asc, eq, isNull, sql } from 'drizzle-orm';

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

    /** Every LIVE comment on one item, oldest-first, joined to the author identity. */
    async listForItem(kind: ShareKind, subjectId: string): Promise<CommentRow[]> {
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
          ),
        )
        .orderBy(asc(itemComments.createdAt));
    },

    /** Count of LIVE comments on one item (drives the collapsed-count UI). */
    async countForItem(kind: ShareKind, subjectId: string): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(itemComments)
        .where(
          and(
            eq(itemComments.kind, kind),
            eq(itemComments.subjectId, subjectId),
            isNull(itemComments.deletedAt),
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

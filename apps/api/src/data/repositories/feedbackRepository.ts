import { and, count, desc, eq, gt, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import {
  FEEDBACK_OPEN_SUBMISSION_LIMIT,
  type AdminFeedbackListQuery,
  type CreateFeedbackRequest,
  type FeedbackMessageAuthorSide,
  type UpdateFeedbackStatusRequest,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  feedback,
  feedbackMessages,
  users,
  type FeedbackMessageRow,
  type FeedbackRow,
  type NewFeedbackRow,
  type UserRow,
} from '../schema';

export interface AdminFeedbackRow extends FeedbackRow {
  submitter: Pick<UserRow, 'id' | 'username' | 'email'>;
}

export interface MyFeedbackRow extends FeedbackRow {
  unreadReplyCount: number;
}

export interface FeedbackThreadPage {
  thread: { id: string; unreadCount: number };
  rows: FeedbackMessageRow[];
  nextCursor: string | null;
}

export interface FeedbackArchiveMutation {
  row: FeedbackRow;
  /** False only when the requested archive state was already stored. */
  changed: boolean;
}

/**
 * Thread read outcomes. `not_found` covers both a missing submission and one
 * owned by another user — ownership is part of the parent SELECT, so the two are
 * indistinguishable. `invalid_cursor` is only ever reachable *after* that gate,
 * so answering it distinctly cannot reveal anything about a foreign thread.
 */
export type FeedbackThreadLookup =
  | { status: 'ok'; page: FeedbackThreadPage }
  | { status: 'not_found' }
  | { status: 'invalid_cursor' };

/** Persistence seam shared by client capture and the owner-only triage queue. */
export interface FeedbackRepository {
  /** Returns null when the caller already has the maximum number of open rows. */
  create(userId: string, input: CreateFeedbackRequest): Promise<FeedbackRow | null>;
  /** Caller ownership is part of the query and cannot be widened by HTTP input. */
  listMine(userId: string): Promise<MyFeedbackRow[]>;
  /** Idempotent caller-owned tombstone; returns null for absent or foreign rows. */
  deleteMine(userId: string, id: string, at: Date): Promise<FeedbackRow | null>;
  /** Every submitter method scopes the parent row by both id and owner in SQL. */
  getThreadForSubmitter(
    userId: string,
    id: string,
    params: { cursor?: string; limit: number },
  ): Promise<FeedbackThreadLookup>;
  getThreadForAdmin(
    id: string,
    params: { cursor?: string; limit: number },
  ): Promise<FeedbackThreadLookup>;
  createMessageForSubmitter(
    userId: string,
    id: string,
    body: string,
  ): Promise<FeedbackMessageRow | null>;
  createMessageForAdmin(
    adminUserId: string,
    id: string,
    body: string,
  ): Promise<FeedbackMessageRow | null>;
  markReadForSubmitter(userId: string, id: string): Promise<boolean>;
  markReadForAdmin(id: string): Promise<boolean>;
  listForAdmin(
    params: AdminFeedbackListQuery,
  ): Promise<{ rows: AdminFeedbackRow[]; total: number }>;
  setStatus(id: string, input: UpdateFeedbackStatusRequest, at: Date): Promise<FeedbackRow | null>;
  /** Idempotently set the admin-only workspace archive state for any submission. */
  setArchived(id: string, archived: boolean, at: Date): Promise<FeedbackArchiveMutation | null>;
}

export function createFeedbackRepository(db: Database): FeedbackRepository {
  /**
   * Submitter-rail parent scoping. Ownership is only half of it: a submission the
   * owner has tombstoned (#1400) has left their rail entirely, so it must read as
   * missing on the thread endpoints too rather than merely dropping out of
   * `/feedback/mine` — otherwise a submitter could still read and answer a
   * conversation they deleted, in replies they would never see again. The admin
   * rail passes no user id and so keeps seeing tombstoned rows, which is exactly
   * the audit trail the tombstone exists to preserve.
   */
  function submitterScope(submitterUserId?: string): SQL | undefined {
    return submitterUserId
      ? and(eq(feedback.userId, submitterUserId), isNull(feedback.deletedByUserAt))
      : undefined;
  }

  /**
   * Resolve a viewer-relative thread head and page. Submitter ownership, when
   * supplied, is part of the parent SELECT; a missing and another user's id are
   * therefore indistinguishable before any message row is read.
   */
  async function getThread(
    id: string,
    viewerSide: FeedbackMessageAuthorSide,
    params: { cursor?: string; limit: number },
    submitterUserId?: string,
  ): Promise<FeedbackThreadLookup> {
    const lastReadAtColumn =
      viewerSide === 'submitter' ? feedback.submitterLastReadAt : feedback.adminLastReadAt;
    // Unread is "rows from the other side", not chat's "rows I did not author".
    // For the submitter the two coincide — only the owner can author a
    // `submitter` row. For staff they differ: admin B does not see admin A's
    // reply as unread. That follows from the single shared `adminLastReadAt`
    // marker the issue prescribes (A marking read advances B's marker too), so
    // per-admin unread is not expressible on this schema by construction, and
    // is a non-event on a single-owner install.
    const otherSide: FeedbackMessageAuthorSide = viewerSide === 'submitter' ? 'admin' : 'submitter';

    const [thread] = await db
      .select({ id: feedback.id, lastReadAt: lastReadAtColumn })
      .from(feedback)
      .where(and(eq(feedback.id, id), submitterScope(submitterUserId)))
      .limit(1);
    if (!thread) return { status: 'not_found' };

    // Page and unread count must share one ordering key. Unread is derived from
    // a `created_at` marker, so the page is keyset-ordered by `created_at` with
    // the UUIDv7 `id` as tiebreak — a row written with an explicit `createdAt`
    // (a backfill, an import, a fixture) then cannot land in a page position
    // that contradicts its own unread classification. The wire cursor stays the
    // message id, so its stamp is resolved here, scoped to this thread.
    const [cursorRow] = params.cursor
      ? await db
          .select({ id: feedbackMessages.id, createdAt: feedbackMessages.createdAt })
          .from(feedbackMessages)
          .where(and(eq(feedbackMessages.feedbackId, id), eq(feedbackMessages.id, params.cursor)))
          .limit(1)
      : [];
    // A cursor naming no row in THIS thread is a client error, not an empty
    // constraint: ignoring it would hand back page one under a `nextCursor` that
    // points at the end of page one again, looping the caller forever instead of
    // telling them the cursor is wrong.
    if (params.cursor && !cursorRow) return { status: 'invalid_cursor' };
    const beforeCursor = cursorRow
      ? or(
          lt(feedbackMessages.createdAt, cursorRow.createdAt),
          and(
            eq(feedbackMessages.createdAt, cursorRow.createdAt),
            lt(feedbackMessages.id, cursorRow.id),
          ),
        )
      : undefined;

    const [unreadRows, rows] = await Promise.all([
      db
        .select({ value: count() })
        .from(feedbackMessages)
        .where(
          and(
            eq(feedbackMessages.feedbackId, id),
            eq(feedbackMessages.authorSide, otherSide),
            thread.lastReadAt ? gt(feedbackMessages.createdAt, thread.lastReadAt) : undefined,
          ),
        ),
      db
        .select()
        .from(feedbackMessages)
        .where(and(eq(feedbackMessages.feedbackId, id), beforeCursor))
        .orderBy(desc(feedbackMessages.createdAt), desc(feedbackMessages.id))
        .limit(params.limit + 1),
    ]);
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    return {
      status: 'ok',
      page: {
        thread: { id: thread.id, unreadCount: unreadRows[0]?.value ?? 0 },
        rows: page,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      },
    };
  }

  /** Insert only after resolving the parent through the appropriate ownership query. */
  async function createMessage(
    authorUserId: string,
    id: string,
    authorSide: FeedbackMessageAuthorSide,
    body: string,
    submitterUserId?: string,
  ): Promise<FeedbackMessageRow | null> {
    return db.transaction(async (tx) => {
      const [thread] = await tx
        .select({ id: feedback.id })
        .from(feedback)
        .where(and(eq(feedback.id, id), submitterScope(submitterUserId)))
        .limit(1);
      if (!thread) return null;

      const [row] = await tx
        .insert(feedbackMessages)
        .values({ feedbackId: id, authorSide, authorUserId, body })
        .returning();
      if (!row) throw new Error('Feedback message vanished after insert');
      return row;
    });
  }

  return {
    async create(userId, input) {
      return db.transaction(async (tx) => {
        // The stable parent row is the per-user serialization point. A second
        // create cannot count until the first transaction has committed its
        // insert, so two requests at 19 open rows cannot both become row 20.
        const [owner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!owner) throw new Error('Cannot create feedback for a missing user');

        const [open] = await tx
          .select({ value: count() })
          .from(feedback)
          .where(
            and(
              eq(feedback.userId, userId),
              isNull(feedback.deletedByUserAt),
              sql`${feedback.status} not in ('declined', 'shipped')`,
            ),
          );
        if ((open?.value ?? 0) >= FEEDBACK_OPEN_SUBMISSION_LIMIT) return null;

        const values: NewFeedbackRow = {
          userId,
          category: input.category,
          subject: input.subject ?? null,
          message: input.message,
          context: (input.context ?? null) as NewFeedbackRow['context'],
        };
        const [row] = await tx.insert(feedback).values(values).returning();
        if (!row) throw new Error('Feedback vanished after insert');
        return row;
      });
    },

    async listMine(userId) {
      const rows = await db
        .select()
        .from(feedback)
        .where(and(eq(feedback.userId, userId), isNull(feedback.deletedByUserAt)))
        .orderBy(desc(feedback.createdAt), desc(feedback.id));
      if (rows.length === 0) return [];

      const unreadRows = await db
        .select({ feedbackId: feedbackMessages.feedbackId, value: count() })
        .from(feedbackMessages)
        .innerJoin(feedback, eq(feedback.id, feedbackMessages.feedbackId))
        .where(
          and(
            eq(feedback.userId, userId),
            eq(feedbackMessages.authorSide, 'admin'),
            or(
              isNull(feedback.submitterLastReadAt),
              gt(feedbackMessages.createdAt, feedback.submitterLastReadAt),
            ),
          ),
        )
        .groupBy(feedbackMessages.feedbackId);
      const unreadByFeedback = new Map(
        unreadRows.map((row) => [row.feedbackId, row.value] as const),
      );
      return rows.map((row) => ({
        ...row,
        unreadReplyCount: unreadByFeedback.get(row.id) ?? 0,
      }));
    },

    async getThreadForSubmitter(userId, id, params) {
      return getThread(id, 'submitter', params, userId);
    },

    async getThreadForAdmin(id, params) {
      return getThread(id, 'admin', params);
    },

    async createMessageForSubmitter(userId, id, body) {
      return createMessage(userId, id, 'submitter', body, userId);
    },

    async createMessageForAdmin(adminUserId, id, body) {
      return createMessage(adminUserId, id, 'admin', body);
    },

    async markReadForSubmitter(userId, id) {
      const rows = await db
        .update(feedback)
        .set({ submitterLastReadAt: sql`now()` })
        .where(and(eq(feedback.id, id), submitterScope(userId)))
        .returning({ id: feedback.id });
      return rows.length > 0;
    },

    async markReadForAdmin(id) {
      const rows = await db
        .update(feedback)
        .set({ adminLastReadAt: sql`now()` })
        .where(eq(feedback.id, id))
        .returning({ id: feedback.id });
      return rows.length > 0;
    },

    async deleteMine(userId, id, at) {
      // Both tombstone stamps ride raw SQL fragments (COALESCE + CASE keep the
      // repeat idempotent), which puts them OUTSIDE the column's drizzle type
      // mapping: the `Date` reaches postgres-js unencoded and its Bind writer
      // throws `ERR_INVALID_ARG_TYPE` on a non-string, so every DELETE answered
      // 500 in production while PGlite — which serialises a `Date` happily —
      // kept the whole suite green. Explicit ISO string + ::timestamptz cast,
      // exactly as #437's notification-archive COALESCE already does.
      const atIso = at.toISOString();
      const [row] = await db
        .update(feedback)
        .set({
          deletedByUserAt: sql<Date>`coalesce(${feedback.deletedByUserAt}, ${atIso}::timestamptz)`,
          updatedAt: sql<Date>`case
            when ${feedback.deletedByUserAt} is null then ${atIso}::timestamptz
            else ${feedback.updatedAt}
          end`,
        })
        .where(and(eq(feedback.id, id), eq(feedback.userId, userId)))
        .returning();
      return row ?? null;
    },

    async listForAdmin(params) {
      const conditions: SQL[] = [];
      if (params.category) conditions.push(eq(feedback.category, params.category));
      conditions.push(
        params.archived ? isNotNull(feedback.archivedAt) : isNull(feedback.archivedAt),
      );
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const priorityOrder = sql<number>`case ${feedback.category}
        when 'feature' then 0
        when 'bug' then 1
        when 'other' then 2
        when 'help' then 3
        when 'improvement' then 4
        else 5
      end`;

      const rows = await db
        .select({
          id: feedback.id,
          userId: feedback.userId,
          category: feedback.category,
          subject: feedback.subject,
          message: feedback.message,
          context: feedback.context,
          status: feedback.status,
          lastStatusChangeAt: feedback.lastStatusChangeAt,
          declinedReason: feedback.declinedReason,
          shippedVersion: feedback.shippedVersion,
          submitterLastReadAt: feedback.submitterLastReadAt,
          adminLastReadAt: feedback.adminLastReadAt,
          deletedByUserAt: feedback.deletedByUserAt,
          archivedAt: feedback.archivedAt,
          createdAt: feedback.createdAt,
          updatedAt: feedback.updatedAt,
          submitterId: users.id,
          submitterUsername: users.username,
          submitterEmail: users.email,
        })
        .from(feedback)
        .innerJoin(users, eq(feedback.userId, users.id))
        .where(where)
        .orderBy(
          ...(params.sort === 'category'
            ? [priorityOrder, desc(feedback.createdAt), desc(feedback.id)]
            : [desc(feedback.createdAt), desc(feedback.id)]),
        )
        .limit(params.limit)
        .offset((params.page - 1) * params.limit);

      const [totalRow] = await db.select({ value: count() }).from(feedback).where(where);
      return {
        rows: rows.map(({ submitterId, submitterUsername, submitterEmail, ...row }) => ({
          ...row,
          submitter: {
            id: submitterId,
            username: submitterUsername,
            email: submitterEmail,
          },
        })),
        total: totalRow?.value ?? 0,
      };
    },

    async setStatus(id, input, at) {
      const [row] = await db
        .update(feedback)
        .set({
          status: input.status,
          lastStatusChangeAt: at,
          declinedReason: input.status === 'declined' ? (input.declinedReason ?? null) : null,
          shippedVersion: input.status === 'shipped' ? (input.shippedVersion ?? null) : null,
          updatedAt: at,
        })
        .where(eq(feedback.id, id))
        .returning();
      return row ?? null;
    },

    async setArchived(id, archived, at) {
      return db.transaction(async (tx) => {
        // The row lock makes a repeated archive/unarchive a genuine no-op: it
        // preserves both timestamps and the audit trail instead of merely
        // converging the final state after two writes race each other.
        const [current] = await tx.select().from(feedback).where(eq(feedback.id, id)).for('update');
        if (!current) return null;

        if ((current.archivedAt !== null) === archived) {
          return { row: current, changed: false };
        }

        const [row] = await tx
          .update(feedback)
          .set({ archivedAt: archived ? at : null, updatedAt: at })
          .where(eq(feedback.id, id))
          .returning();
        if (!row) throw new Error('Feedback vanished during archive mutation');
        return { row, changed: true };
      });
    },
  };
}

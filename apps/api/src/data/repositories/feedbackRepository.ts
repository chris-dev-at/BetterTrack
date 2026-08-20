import { and, count, desc, eq, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import type {
  AdminFeedbackListQuery,
  CreateFeedbackRequest,
  FeedbackMessageAuthorSide,
  UpdateFeedbackStatusRequest,
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

/** Persistence seam shared by client capture and the owner-only triage queue. */
export interface FeedbackRepository {
  create(userId: string, input: CreateFeedbackRequest): Promise<FeedbackRow>;
  /** Caller ownership is part of the query and cannot be widened by HTTP input. */
  listMine(userId: string): Promise<MyFeedbackRow[]>;
  /** Every submitter method scopes the parent row by both id and owner in SQL. */
  getThreadForSubmitter(
    userId: string,
    id: string,
    params: { cursor?: string; limit: number },
  ): Promise<FeedbackThreadPage | null>;
  getThreadForAdmin(
    id: string,
    params: { cursor?: string; limit: number },
  ): Promise<FeedbackThreadPage | null>;
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
}

export function createFeedbackRepository(db: Database): FeedbackRepository {
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
  ): Promise<FeedbackThreadPage | null> {
    const lastReadAtColumn =
      viewerSide === 'submitter' ? feedback.submitterLastReadAt : feedback.adminLastReadAt;
    const otherSide: FeedbackMessageAuthorSide = viewerSide === 'submitter' ? 'admin' : 'submitter';

    const [thread] = await db
      .select({ id: feedback.id, lastReadAt: lastReadAtColumn })
      .from(feedback)
      .where(
        and(
          eq(feedback.id, id),
          submitterUserId ? eq(feedback.userId, submitterUserId) : undefined,
        ),
      )
      .limit(1);
    if (!thread) return null;

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
        .where(
          and(
            eq(feedbackMessages.feedbackId, id),
            params.cursor ? lt(feedbackMessages.id, params.cursor) : undefined,
          ),
        )
        .orderBy(desc(feedbackMessages.id))
        .limit(params.limit + 1),
    ]);
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    return {
      thread: { id: thread.id, unreadCount: unreadRows[0]?.value ?? 0 },
      rows: page,
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
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
        .where(
          and(
            eq(feedback.id, id),
            submitterUserId ? eq(feedback.userId, submitterUserId) : undefined,
          ),
        )
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
      const values: NewFeedbackRow = {
        userId,
        category: input.category,
        subject: input.subject ?? null,
        message: input.message,
        context: (input.context ?? null) as NewFeedbackRow['context'],
      };
      const [row] = await db.insert(feedback).values(values).returning();
      if (!row) throw new Error('Feedback vanished after insert');
      return row;
    },

    async listMine(userId) {
      const rows = await db
        .select()
        .from(feedback)
        .where(eq(feedback.userId, userId))
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
        .where(and(eq(feedback.id, id), eq(feedback.userId, userId)))
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

    async listForAdmin(params) {
      const conditions: SQL[] = [];
      if (params.category) conditions.push(eq(feedback.category, params.category));
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const priorityOrder = sql<number>`case ${feedback.category}
        when 'feature' then 0
        when 'bug' then 1
        else 2
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
  };
}

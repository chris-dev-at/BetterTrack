import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';

import type {
  AdminFeedbackListQuery,
  CreateFeedbackRequest,
  FeedbackStatus,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import { feedback, users, type FeedbackRow, type NewFeedbackRow, type UserRow } from '../schema';

export interface AdminFeedbackRow extends FeedbackRow {
  submitter: Pick<UserRow, 'id' | 'username' | 'email'>;
}

/** Persistence seam shared by client capture and the owner-only triage queue. */
export interface FeedbackRepository {
  create(userId: string, input: CreateFeedbackRequest): Promise<FeedbackRow>;
  listForAdmin(
    params: AdminFeedbackListQuery,
  ): Promise<{ rows: AdminFeedbackRow[]; total: number }>;
  setStatus(id: string, status: FeedbackStatus, at: Date): Promise<FeedbackRow | null>;
}

export function createFeedbackRepository(db: Database): FeedbackRepository {
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

    async setStatus(id, status, at) {
      const [row] = await db
        .update(feedback)
        .set({ status, updatedAt: at })
        .where(eq(feedback.id, id))
        .returning();
      return row ?? null;
    },
  };
}

import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import {
  FEEDBACK_OPEN_SUBMISSION_LIMIT,
  type AdminFeedbackListQuery,
  type CreateFeedbackRequest,
  type UpdateFeedbackStatusRequest,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import { feedback, users, type FeedbackRow, type NewFeedbackRow, type UserRow } from '../schema';

export interface AdminFeedbackRow extends FeedbackRow {
  submitter: Pick<UserRow, 'id' | 'username' | 'email'>;
}

/** Persistence seam shared by client capture and the owner-only triage queue. */
export interface FeedbackRepository {
  /** Returns null when the caller already has the maximum number of open rows. */
  create(userId: string, input: CreateFeedbackRequest): Promise<FeedbackRow | null>;
  /** Caller ownership is part of the query and cannot be widened by HTTP input. */
  listMine(userId: string): Promise<FeedbackRow[]>;
  /** Idempotent caller-owned tombstone; returns null for absent or foreign rows. */
  deleteMine(userId: string, id: string, at: Date): Promise<FeedbackRow | null>;
  listForAdmin(
    params: AdminFeedbackListQuery,
  ): Promise<{ rows: AdminFeedbackRow[]; total: number }>;
  setStatus(id: string, input: UpdateFeedbackStatusRequest, at: Date): Promise<FeedbackRow | null>;
}

export function createFeedbackRepository(db: Database): FeedbackRepository {
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
      return db
        .select()
        .from(feedback)
        .where(and(eq(feedback.userId, userId), isNull(feedback.deletedByUserAt)))
        .orderBy(desc(feedback.createdAt), desc(feedback.id));
    },

    async deleteMine(userId, id, at) {
      const [row] = await db
        .update(feedback)
        .set({
          deletedByUserAt: sql<Date>`coalesce(${feedback.deletedByUserAt}, ${at})`,
          updatedAt: sql<Date>`case
            when ${feedback.deletedByUserAt} is null then ${at}
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
          deletedByUserAt: feedback.deletedByUserAt,
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

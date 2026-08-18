import type { CreateFeedbackRequest } from '@bettertrack/contracts';

import type { Database } from '../db';
import { feedback, type FeedbackRow, type NewFeedbackRow } from '../schema';

/** The create-only persistence seam for authenticated user feedback. */
export interface FeedbackRepository {
  create(userId: string, input: CreateFeedbackRequest): Promise<FeedbackRow>;
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
  };
}

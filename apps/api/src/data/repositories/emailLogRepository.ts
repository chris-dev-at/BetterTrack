import { desc, eq, lt, and } from 'drizzle-orm';

import type { Database } from '../db';
import { emailLog, type EmailLogRow } from '../schema';

/**
 * Email send-log persistence (PROJECTPLAN.md §6.10). One row per send attempt —
 * never a body or secret, only the recipient, template, subject, terminal
 * status and (on failure) a coarse `error_code`. Admins read the log globally
 * and per user (§6.12); both reads are newest-first keyset pages by UUIDv7 id.
 */

export interface InsertEmailLogInput {
  userId?: string | null;
  recipient: string;
  template: string;
  subject: string;
  status: 'sent' | 'failed' | 'suppressed';
  errorCode?: string | null;
}

export interface EmailLogPage {
  entries: EmailLogRow[];
  nextCursor: string | null;
}

export function createEmailLogRepository(db: Database) {
  async function page(params: {
    limit: number;
    cursor?: string;
    userId?: string;
  }): Promise<EmailLogPage> {
    const conditions = [
      params.userId ? eq(emailLog.userId, params.userId) : undefined,
      params.cursor ? lt(emailLog.id, params.cursor) : undefined,
    ].filter(Boolean);

    const rows = await db
      .select()
      .from(emailLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(emailLog.id))
      .limit(params.limit + 1);

    const hasMore = rows.length > params.limit;
    const entries = hasMore ? rows.slice(0, params.limit) : rows;
    return { entries, nextCursor: hasMore ? (entries.at(-1)?.id ?? null) : null };
  }

  return {
    async insert(input: InsertEmailLogInput): Promise<void> {
      await db.insert(emailLog).values({
        userId: input.userId ?? null,
        recipient: input.recipient,
        template: input.template,
        subject: input.subject,
        status: input.status,
        errorCode: input.errorCode ?? null,
      });
    },

    /** Newest-first, keyset paginated by UUIDv7 id. */
    listGlobal: (limit: number, cursor?: string): Promise<EmailLogPage> => page({ limit, cursor }),

    /** Same, scoped to a single user's sends. */
    listForUser: (userId: string, limit: number, cursor?: string): Promise<EmailLogPage> =>
      page({ limit, cursor, userId }),
  };
}

export type EmailLogRepository = ReturnType<typeof createEmailLogRepository>;

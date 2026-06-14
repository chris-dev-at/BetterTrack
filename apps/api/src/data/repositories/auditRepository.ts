import { desc, lt } from 'drizzle-orm';

import type { Database } from '../db';
import { auditLog, type AuditLogRow } from '../schema';

export interface RecordAuditInput {
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  meta?: unknown;
}

export function createAuditRepository(db: Database) {
  return {
    async record(input: RecordAuditInput): Promise<void> {
      await db.insert(auditLog).values({
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        ip: input.ip ?? null,
        meta: input.meta ?? null,
      });
    },

    /** Newest-first, keyset paginated by UUIDv7 id (time-sortable). */
    async list(params: { limit: number; cursor?: string }): Promise<{
      entries: AuditLogRow[];
      nextCursor: string | null;
    }> {
      const rows = await db
        .select()
        .from(auditLog)
        .where(params.cursor ? lt(auditLog.id, params.cursor) : undefined)
        .orderBy(desc(auditLog.id))
        .limit(params.limit + 1);

      const hasMore = rows.length > params.limit;
      const entries = hasMore ? rows.slice(0, params.limit) : rows;
      return { entries, nextCursor: hasMore ? (entries.at(-1)?.id ?? null) : null };
    },
  };
}

export type AuditRepository = ReturnType<typeof createAuditRepository>;

import { and, desc, eq, lt } from 'drizzle-orm';

import type { Database } from '../db';
import { apiKeyRequestLog, type ApiKeyRequestLogRow } from '../schema';

/**
 * Bounded per-key request-log audit trail (§13.5 V5-P10, issue 2/2). One row per
 * bearer request (method, mount-relative path, response status). The path is
 * PII-scrubbed by the caller before it reaches here. The log is bounded by the
 * retention-cleanup cron that prunes by age via {@link deleteOlderThan}.
 */
export interface RecordApiKeyRequestInput {
  keyId: string;
  userId: string;
  method: string;
  path: string;
  status: number;
}

export function createApiKeyRequestLogRepository(db: Database) {
  return {
    async record(input: RecordApiKeyRequestInput): Promise<void> {
      await db.insert(apiKeyRequestLog).values({
        keyId: input.keyId,
        userId: input.userId,
        method: input.method,
        path: input.path,
        status: input.status,
      });
    },

    /** A key's most recent request-log lines, newest first, bounded by `limit`. */
    async listForKey(keyId: string, limit: number): Promise<ApiKeyRequestLogRow[]> {
      return db
        .select()
        .from(apiKeyRequestLog)
        .where(eq(apiKeyRequestLog.keyId, keyId))
        .orderBy(desc(apiKeyRequestLog.createdAt))
        .limit(limit);
    },

    /** For the admin audit view scoped to one owner (defence in depth). */
    async listForKeyOwned(
      keyId: string,
      userId: string,
      limit: number,
    ): Promise<ApiKeyRequestLogRow[]> {
      return db
        .select()
        .from(apiKeyRequestLog)
        .where(and(eq(apiKeyRequestLog.keyId, keyId), eq(apiKeyRequestLog.userId, userId)))
        .orderBy(desc(apiKeyRequestLog.createdAt))
        .limit(limit);
    },

    /** Prune log rows older than `cutoff`; returns the number deleted. */
    async deleteOlderThan(cutoff: Date): Promise<number> {
      const deleted = await db
        .delete(apiKeyRequestLog)
        .where(lt(apiKeyRequestLog.createdAt, cutoff))
        .returning({ id: apiKeyRequestLog.id });
      return deleted.length;
    },
  };
}

export type ApiKeyRequestLogRepository = ReturnType<typeof createApiKeyRequestLogRepository>;

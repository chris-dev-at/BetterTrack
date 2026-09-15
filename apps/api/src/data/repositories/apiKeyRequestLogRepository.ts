import { and, asc, desc, eq, inArray, isNotNull, lt } from 'drizzle-orm';

import type { Database } from '../db';
import { apiKeyRequestLog, portfolios, type ApiKeyRequestLogRow } from '../schema';
import { withFreshLockedPrivacyModes } from './paranoidEnforcementRepository';
import {
  attributePortfolioRequestPath,
  resolvePortfolioRequestAttribution,
} from './portfolioRequestAttribution';

/**
 * Bounded per-key request-log audit trail (§13.5 V5-P10, issue 2/2). One row per
 * bearer request (method, mount-relative path, response status). The path is
 * PII-scrubbed by the caller before it reaches here. The log is bounded by the
 * retention-cleanup cron that prunes by age via {@link deleteOlderThan}; rows
 * for paranoid accounts are deliberately never written.
 */
export interface RecordApiKeyRequestInput {
  keyId: string;
  userId: string;
  method: string;
  path: string;
  status: number;
  /** Ephemeral portfolio attribution; checked under the account transition lock. */
  targetPortfolioId?: string | null;
  /** Per-asset market paths with no target are unsafe when any portfolio is vaulted. */
  suppressIfAnyVault?: boolean;
}

export function createApiKeyRequestLogRepository(db: Database, lockDb: Database) {
  return {
    async record(input: RecordApiKeyRequestInput): Promise<void> {
      const candidate = await resolvePortfolioRequestAttribution(
        db,
        input.path,
        input.targetPortfolioId,
      );
      const lockedUserIds = [input.userId];
      if (candidate.ownerId && candidate.ownerId !== input.userId) {
        lockedUserIds.push(candidate.ownerId);
      }
      // Hold the account privacy lock through the insert. A request that began
      // while the account was normal may finish while paranoid enable owns the
      // row lock: if this write wins, enable waits and purges it; if enable wins,
      // this re-read observes `paranoid` and suppresses the operational row.
      // That keeps the purge-classified table genuinely empty for paranoid
      // accounts instead of weakening the classification to mean "safe rows".
      await withFreshLockedPrivacyModes(lockDb, lockedUserIds, async (modes) => {
        if (lockedUserIds.some((userId) => modes.get(userId) !== 'normal')) return;

        const attribution = await resolvePortfolioRequestAttribution(
          db,
          input.path,
          input.targetPortfolioId,
        );
        // A recognized child-resource path that no longer resolves is exactly
        // the stale-after-E4 case. Do not retain the now-secret resource id.
        if (attribution.recognized && !attribution.nonPortfolio && !attribution.portfolioId) return;
        // If attribution changed to an account we did not lock, retrying here
        // would open a lock-order race. Suppression is the safe audit behavior.
        if (attribution.ownerId && !lockedUserIds.includes(attribution.ownerId)) return;
        if (
          candidate.ownerId &&
          (attribution.ownerId !== candidate.ownerId ||
            attribution.portfolioId !== candidate.portfolioId)
        ) {
          return;
        }
        if (attribution.vaultId) return;
        if (input.suppressIfAnyVault) {
          const [vaulted] = await db
            .select({ id: portfolios.id })
            .from(portfolios)
            .where(and(eq(portfolios.userId, input.userId), isNotNull(portfolios.vaultId)))
            .limit(1);
          if (vaulted) return;
        }
        await db.insert(apiKeyRequestLog).values({
          keyId: input.keyId,
          userId: input.userId,
          method: input.method,
          path: attribution.portfolioId
            ? attributePortfolioRequestPath(input.path, attribution.portfolioId)
            : input.path,
          status: input.status,
        });
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

    /**
     * Delete at most `limit` oldest rows before `cutoff`; returns how many went.
     * The scheduled retention sweep repeats this bounded statement until it
     * returns fewer than `limit`, avoiding one unbounded full-table delete —
     * this is the highest-volume operational table in the app (one row per
     * bearer request), so an unbounded DELETE here is a long lock-holding
     * transaction that may never converge.
     */
    async deleteOlderThan(cutoff: Date, limit: number): Promise<number> {
      const candidates = db
        .select({ id: apiKeyRequestLog.id })
        .from(apiKeyRequestLog)
        .where(lt(apiKeyRequestLog.createdAt, cutoff))
        .orderBy(asc(apiKeyRequestLog.createdAt), asc(apiKeyRequestLog.id))
        .limit(limit);
      const deleted = await db
        .delete(apiKeyRequestLog)
        .where(inArray(apiKeyRequestLog.id, candidates))
        .returning({ id: apiKeyRequestLog.id });
      return deleted.length;
    },
  };
}

export type ApiKeyRequestLogRepository = ReturnType<typeof createApiKeyRequestLogRepository>;

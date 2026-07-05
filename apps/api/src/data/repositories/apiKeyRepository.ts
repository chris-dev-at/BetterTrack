import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db';
import { apiKeys, users, type ApiKeyRow, type UserRow } from '../schema';

/**
 * Personal API key persistence (PROJECTPLAN.md §6.13, §14, V2-P12). Only the
 * SHA-256 `tokenHash` is ever stored — the raw token is shown once at creation
 * and never persisted. Keys are revoke-only: `revoke` stamps `revokedAt`; there
 * is deliberately no expiry (see the `api_keys` table comment in schema.ts).
 */
export interface CreateApiKeyInput {
  userId: string;
  name: string;
  tokenHash: string;
  scopes: string[];
}

export function createApiKeyRepository(db: Database) {
  return {
    async create(input: CreateApiKeyInput): Promise<ApiKeyRow> {
      const [row] = await db
        .insert(apiKeys)
        .values({
          userId: input.userId,
          name: input.name,
          tokenHash: input.tokenHash,
          scopes: input.scopes,
        })
        .returning();
      if (!row) throw new Error('Failed to insert API key');
      return row;
    },

    /** A user's active (non-revoked) keys, newest first. */
    async listActiveForUser(userId: string): Promise<ApiKeyRow[]> {
      return db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
        .orderBy(desc(apiKeys.createdAt));
    },

    /**
     * Resolve an active key by its token hash, joined to its owning user — the
     * bearer-auth lookup. Returns nothing for a revoked key (→ 401) or unknown
     * hash. The owning user row is returned so the middleware can attach the
     * same `AuthUser` a session would.
     */
    async findActiveByTokenHash(
      tokenHash: string,
    ): Promise<{ key: ApiKeyRow; user: UserRow } | undefined> {
      const [row] = await db
        .select({ key: apiKeys, user: users })
        .from(apiKeys)
        .innerJoin(users, eq(apiKeys.userId, users.id))
        .where(and(eq(apiKeys.tokenHash, tokenHash), isNull(apiKeys.revokedAt)))
        .limit(1);
      return row;
    },

    /**
     * Revoke a key the caller owns. Returns the revoked row, or undefined when
     * the id isn't the caller's or is already revoked — so the service can 404
     * without leaking another user's key ids.
     */
    async revoke(userId: string, id: string): Promise<ApiKeyRow | undefined> {
      const [row] = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
        .returning();
      return row;
    },

    /** Stamp `lastUsedAt` (throttled by the service, not written per request). */
    async touchLastUsed(id: string, at: Date): Promise<void> {
      await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id));
    },
  };
}

export type ApiKeyRepository = ReturnType<typeof createApiKeyRepository>;

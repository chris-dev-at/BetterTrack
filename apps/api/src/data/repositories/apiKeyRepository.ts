import { and, count, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db';
import {
  apiKeys,
  apiKeyTiers,
  users,
  type ApiKeyRow,
  type ApiKeyTierRow,
  type UserRow,
} from '../schema';

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

    /**
     * Insert a key only while its owner is still at `securityGeneration` — the
     * generation of the session creating it. The owner row is read `FOR SHARE`,
     * so the insert serializes against a credential change on that row (which
     * bumps the generation in an `UPDATE`): either this insert commits first and
     * the change's own key revocation, committed with the bump, sees the key, or
     * the change commits first and this read sees the new generation and inserts
     * nothing. Returns `undefined` when the generation no longer matches.
     */
    async createAtGeneration(
      input: CreateApiKeyInput,
      securityGeneration: number,
    ): Promise<ApiKeyRow | undefined> {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ securityGeneration: users.securityGeneration })
          .from(users)
          .where(eq(users.id, input.userId))
          .limit(1)
          .for('share');
        if (!owner || owner.securityGeneration !== securityGeneration) return undefined;
        const [row] = await tx
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
      });
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
    ): Promise<{ key: ApiKeyRow; user: UserRow; tier: ApiKeyTierRow | null } | undefined> {
      const [row] = await db
        .select({ key: apiKeys, user: users, tier: apiKeyTiers })
        .from(apiKeys)
        .innerJoin(users, eq(apiKeys.userId, users.id))
        .leftJoin(apiKeyTiers, eq(apiKeys.tierId, apiKeyTiers.id))
        .where(and(eq(apiKeys.tokenHash, tokenHash), isNull(apiKeys.revokedAt)))
        .limit(1);
      return row;
    },

    /**
     * One bounded page of keys across all users for the admin governance
     * surface, newest first, joined to its tier name (V5-P2, #1814 — this used
     * to be every row the table had ever held).
     *
     * Revoked keys are excluded unless `includeRevoked` asks for them: nothing
     * prunes them, so they dominate the table on a long-lived instance, and the
     * audit view still reaches a recently-retired key through the filter.
     *
     * The `id` tiebreak is what makes the window correct — without it two keys
     * minted in the same millisecond can swap places between page 1 and page 2
     * and one of them is never shown.
     */
    async listPageForAdmin(params: {
      limit: number;
      offset: number;
      includeRevoked: boolean;
    }): Promise<{ rows: (ApiKeyRow & { tierName: string | null })[]; total: number }> {
      const where = params.includeRevoked ? undefined : isNull(apiKeys.revokedAt);
      const rows = await db
        .select({ key: apiKeys, tierName: apiKeyTiers.name })
        .from(apiKeys)
        .leftJoin(apiKeyTiers, eq(apiKeys.tierId, apiKeyTiers.id))
        .where(where)
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
        .limit(params.limit)
        .offset(params.offset);
      const [totalRow] = await db.select({ value: count() }).from(apiKeys).where(where);
      return {
        rows: rows.map((r) => ({ ...r.key, tierName: r.tierName ?? null })),
        total: totalRow?.value ?? 0,
      };
    },

    async getById(id: string): Promise<ApiKeyRow | undefined> {
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
      return row;
    },

    /**
     * One admin-shaped row (key + joined tier name) — the single-row analogue of
     * {@link listPageForAdmin}, used by `assignTier` to rehydrate the changed key
     * without an O(N) scan over the full key table.
     */
    async findByIdWithTier(
      id: string,
    ): Promise<(ApiKeyRow & { tierName: string | null }) | undefined> {
      const [row] = await db
        .select({ key: apiKeys, tierName: apiKeyTiers.name })
        .from(apiKeys)
        .leftJoin(apiKeyTiers, eq(apiKeys.tierId, apiKeyTiers.id))
        .where(eq(apiKeys.id, id))
        .limit(1);
      return row ? { ...row.key, tierName: row.tierName ?? null } : undefined;
    },

    /**
     * Active (non-revoked) key ids resolving to `tierId` — or, for `null`, the
     * keys that inherit whatever tier is currently the default. Bounded by
     * `limit` so an administrative tier edit can never fan out an unbounded
     * limiter reset; a revoked key can no longer make a request, so its stale
     * limiter state is irrelevant (#1730).
     */
    async listActiveIdsByTier(tierId: string | null, limit: number): Promise<string[]> {
      const rows = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(
          and(
            tierId === null ? isNull(apiKeys.tierId) : eq(apiKeys.tierId, tierId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .orderBy(desc(apiKeys.createdAt))
        .limit(limit);
      return rows.map((row) => row.id);
    },

    /** Admin assigns (or clears → default) a key's tier. Returns the updated row. */
    async setTier(id: string, tierId: string | null): Promise<ApiKeyRow | undefined> {
      const [row] = await db.update(apiKeys).set({ tierId }).where(eq(apiKeys.id, id)).returning();
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

    /**
     * Revoke every still-active personal key of one user (administrative
     * suspension, administrator password reset). Returns the ids it revoked in
     * THIS call — an already-revoked key is never returned again, so a retry
     * audits nothing twice.
     *
     * `inSameCommit`, when given, runs inside one transaction with the revoke
     * (the per-key audit rows of a credential event): both commit or neither
     * does, so a revoked key never lacks its row.
     */
    async revokeAllForUser(
      userId: string,
      inSameCommit?: (tx: Database, revokedIds: string[]) => Promise<void>,
    ): Promise<string[]> {
      const revoke = async (executor: Database): Promise<string[]> => {
        const rows = await executor
          .update(apiKeys)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
          .returning({ id: apiKeys.id });
        return rows.map((row) => row.id);
      };
      if (!inSameCommit) return revoke(db);
      return db.transaction(async (tx) => {
        const transaction = tx as unknown as Database;
        const revokedIds = await revoke(transaction);
        await inSameCommit(transaction, revokedIds);
        return revokedIds;
      });
    },

    /** Stamp `lastUsedAt` (throttled by the service, not written per request). */
    async touchLastUsed(id: string, at: Date): Promise<void> {
      await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id));
    },
  };
}

export type ApiKeyRepository = ReturnType<typeof createApiKeyRepository>;

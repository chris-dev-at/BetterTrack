import { and, count, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { registrationTokens, type RegistrationTokenRow } from '../schema';

export interface CreateRegistrationTokenInput {
  tokenHash: string;
  label: string | null;
  maxUses: number;
  createdBy: string;
  expiresAt: Date | null;
}

/**
 * Registration-access-token SQL (PROJECTPLAN.md §6.12, §13.4 V4-P4a). All lives
 * here per §4.3. Only the token *hash* is ever stored.
 */
export function createRegistrationTokenRepository(db: Database) {
  return {
    async create(input: CreateRegistrationTokenInput): Promise<RegistrationTokenRow> {
      const [row] = await db
        .insert(registrationTokens)
        .values({
          tokenHash: input.tokenHash,
          label: input.label,
          maxUses: input.maxUses,
          createdBy: input.createdBy,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error('Failed to insert registration token');
      return row;
    },

    async findByTokenHash(tokenHash: string): Promise<RegistrationTokenRow | undefined> {
      const [row] = await db
        .select()
        .from(registrationTokens)
        .where(eq(registrationTokens.tokenHash, tokenHash))
        .limit(1);
      return row;
    },

    async findById(id: string): Promise<RegistrationTokenRow | undefined> {
      const [row] = await db
        .select()
        .from(registrationTokens)
        .where(eq(registrationTokens.id, id))
        .limit(1);
      return row;
    },

    /**
     * One bounded page of registration access tokens, newest first (V5-P2,
     * #1814 — this used to return every token ever minted; exhausted and
     * revoked ones are never pruned). The `id` tiebreak keeps the window stable
     * across pages.
     */
    async listPage(params: {
      limit: number;
      offset: number;
    }): Promise<{ rows: RegistrationTokenRow[]; total: number }> {
      const rows = await db
        .select()
        .from(registrationTokens)
        .orderBy(desc(registrationTokens.createdAt), desc(registrationTokens.id))
        .limit(params.limit)
        .offset(params.offset);
      const [totalRow] = await db.select({ value: count() }).from(registrationTokens);
      return { rows, total: totalRow?.value ?? 0 };
    },

    async revoke(id: string, when: Date): Promise<void> {
      await db
        .update(registrationTokens)
        .set({ revokedAt: when })
        .where(eq(registrationTokens.id, id));
    },

    /**
     * Atomically claim one use of a token: increment `use_count` iff the token is
     * still valid (not revoked, not expired, under its cap). Returns true when a
     * use was claimed, false when the token was invalid at claim time — the
     * `WHERE` is the single source of truth so two concurrent registrations can
     * never exceed `max_uses`.
     */
    async consumeUse(id: string, now: Date): Promise<boolean> {
      const [row] = await db
        .update(registrationTokens)
        .set({ useCount: sql`${registrationTokens.useCount} + 1` })
        .where(
          and(
            eq(registrationTokens.id, id),
            isNull(registrationTokens.revokedAt),
            lt(registrationTokens.useCount, registrationTokens.maxUses),
            or(isNull(registrationTokens.expiresAt), gt(registrationTokens.expiresAt, now)),
          ),
        )
        .returning({ id: registrationTokens.id });
      return Boolean(row);
    },
  };
}

export type RegistrationTokenRepository = ReturnType<typeof createRegistrationTokenRepository>;

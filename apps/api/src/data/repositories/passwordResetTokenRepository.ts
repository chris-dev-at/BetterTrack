import { eq } from 'drizzle-orm';

import type { Database } from '../db';
import { passwordResetTokens, type PasswordResetTokenRow } from '../schema';

/**
 * Self-service password-reset token persistence (PROJECTPLAN.md §6.1, §14). Only
 * the SHA-256 `tokenHash` is ever stored — the raw token lives in the emailed
 * link. Tokens are single-use (`markUsed`) and revoked wholesale for a user on
 * issue of a new one and on any password change (`deleteForUser`).
 */
export interface CreatePasswordResetTokenInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export function createPasswordResetTokenRepository(db: Database) {
  return {
    async create(input: CreatePasswordResetTokenInput): Promise<PasswordResetTokenRow> {
      const [row] = await db
        .insert(passwordResetTokens)
        .values({
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error('Failed to insert password reset token');
      return row;
    },

    async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRow | undefined> {
      const [row] = await db
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, tokenHash))
        .limit(1);
      return row;
    },

    async markUsed(id: string, when: Date): Promise<void> {
      await db
        .update(passwordResetTokens)
        .set({ usedAt: when })
        .where(eq(passwordResetTokens.id, id));
    },

    /** Drop every outstanding token for a user — revoke-on-use and on password change. */
    async deleteForUser(userId: string): Promise<void> {
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
    },
  };
}

export type PasswordResetTokenRepository = ReturnType<typeof createPasswordResetTokenRepository>;

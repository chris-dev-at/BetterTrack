import { and, eq, gt, isNull } from 'drizzle-orm';

import type { Database } from '../db';
import { passwordResetTokens, users, type PasswordResetTokenRow } from '../schema';

/**
 * Self-service password-reset token persistence (PROJECTPLAN.md §6.1, §14). Only
 * the SHA-256 `tokenHash` is ever stored — the raw token lives in the emailed
 * link. Tokens are single-use (`consume`) and revoked wholesale for a user on
 * issue of a new one and on any password change (`deleteForUser`).
 */
export interface CreatePasswordResetTokenInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export function createPasswordResetTokenRepository(db: Database) {
  return {
    /**
     * Replace the user's outstanding reset token under a lock on the owning
     * account. Locking the stable user row makes concurrent first-time issues
     * serialize even when there is no prior token row to lock.
     */
    async issue(input: CreatePasswordResetTokenInput): Promise<PasswordResetTokenRow> {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.userId))
          .for('update');
        if (!owner) throw new Error('Cannot issue a password reset token for a missing user');

        await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, input.userId));
        const [row] = await tx
          .insert(passwordResetTokens)
          .values({
            userId: input.userId,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
          })
          .returning();
        if (!row) throw new Error('Failed to insert password reset token');
        return row;
      });
    },

    async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRow | undefined> {
      const [row] = await db
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, tokenHash))
        .limit(1);
      return row;
    },

    /**
     * The sole reset-completion gate: exactly one caller may transition a live
     * token from unused to used. Expiry is checked in the same statement.
     */
    async consume(id: string, when: Date): Promise<boolean> {
      const [row] = await db
        .update(passwordResetTokens)
        .set({ usedAt: when })
        .where(
          and(
            eq(passwordResetTokens.id, id),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, when),
          ),
        )
        .returning({ id: passwordResetTokens.id });
      return Boolean(row);
    },

    /** Drop every outstanding token for a user — revoke-on-use and on password change. */
    async deleteForUser(userId: string): Promise<void> {
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
    },
  };
}

export type PasswordResetTokenRepository = ReturnType<typeof createPasswordResetTokenRepository>;

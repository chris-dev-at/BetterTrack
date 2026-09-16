import { and, eq, gt, isNull, sql } from 'drizzle-orm';

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

// Two-key advisory locks occupy a namespace separate from the one-key
// portfolio-ledger locks. The second key is hashtext(normalized email).
const PASSWORD_RESET_ISSUE_LOCK_CLASS = 0x4254;
const PASSWORD_RESET_PROBE_USER_ID = '00000000-0000-0000-0000-000000000000';

export function createPasswordResetTokenRepository(db: Database) {
  return {
    /**
     * Replace the user's outstanding reset token, or run the indistinguishable
     * no-account branch. The per-address advisory lock equalizes concurrent
     * probes; the stable user-row lock still coordinates a real issue with
     * account mutations when no prior token row exists.
     *
     * `onIssued` runs on THIS transaction's executor, after the insert and
     * before commit, and exists for exactly one caller: the known branch's
     * success audit (§16 2026-09-16). Its contract is deliberately narrow,
     * because the callback runs while the transaction still holds the
     * per-address advisory lock and its pooled connection:
     *
     * - BOUNDED work only — a single statement on the `executor` it is handed.
     *   It must never reach back to the pool (`db.…`), never await a network
     *   call and never take another lock. Anything unbounded in here is
     *   unbounded *inside the lock*, which is the one thing this repository
     *   exists to keep predictable.
     * - A throwing callback rolls the token insert back with it. That is the
     *   intended atomicity, not an accident: the audit log must not be able to
     *   claim a reset link was issued when none was, nor miss one that was.
     *
     * Both halves are pinned by `passwordResetIssueSeam.test.ts`, and there is
     * exactly one call site (`authService.requestPasswordReset`).
     */
    async issueOrEqualize(
      input: CreatePasswordResetTokenInput | null,
      serializationKey: string,
      onIssued?: (executor: Database) => Promise<void>,
    ): Promise<PasswordResetTokenRow | null> {
      return db.transaction(async (tx) => {
        // Both known and unknown addresses take the same per-address lock, so a
        // burst of concurrent probes queues identically on both branches. The
        // known branch still inserts/audits/sends; its residual write cost stays
        // behind the service's response floor rather than this serialization.
        //
        // The known branch's extra in-lock cost is one INSERT (the token) plus
        // `onIssued`'s one INSERT (the audit row). That difference is amplified
        // by the lock queue, but the queue is bounded: a transaction waiting
        // here holds its pooled connection, so no more than `max` waiters can
        // ever exist. The wait for a connection the known branch would take
        // AFTER commit has no such ceiling — it is bounded only by request
        // concurrency, which the caller chooses. See §16 2026-09-16.
        await tx.execute(
          sql`select pg_advisory_xact_lock(${PASSWORD_RESET_ISSUE_LOCK_CLASS}, hashtext(${serializationKey}))`,
        );

        // Keep the probe branch on the same query path without touching a real
        // account. The impossible UUID makes the SELECT + DELETE harmless no-ops.
        const userId = input?.userId ?? PASSWORD_RESET_PROBE_USER_ID;
        const [owner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');

        await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
        if (!input) return null;
        if (!owner) throw new Error('Cannot issue a password reset token for a missing user');

        const [row] = await tx
          .insert(passwordResetTokens)
          .values({
            userId: input.userId,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
          })
          .returning();
        if (!row) throw new Error('Failed to insert password reset token');
        await onIssued?.(tx);
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

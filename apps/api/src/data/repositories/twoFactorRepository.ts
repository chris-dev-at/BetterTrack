import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { twoFactorRecoveryCodes, users } from '../schema';

/**
 * Two-factor state persistence (PROJECTPLAN.md §6.1, §13.2 V2-P5). The TOTP
 * secret + enabled flag live on `users` (the caller stores the secret already
 * ENCRYPTED — this layer never sees plaintext); the single-use recovery codes
 * live in their own child table, stored only as SHA-256 hashes. Disabling wipes
 * the secret and every recovery code together, so 2FA can never be left in a
 * half-off state.
 */
export interface TwoFactorState {
  /** Encrypted TOTP secret envelope, or null when the TOTP method isn't enrolled. */
  secret: string | null;
  /** The authenticator-app (TOTP) method flag. */
  enabled: boolean;
  confirmedAt: Date | null;
  /** The standalone email-code method flag (#298). */
  emailEnabled: boolean;
}

export function createTwoFactorRepository(db: Database) {
  return {
    /** Read the caller's 2FA columns off `users`. */
    async getState(userId: string): Promise<TwoFactorState | undefined> {
      const [row] = await db
        .select({
          secret: users.twoFactorSecret,
          enabled: users.twoFactorEnabled,
          confirmedAt: users.twoFactorConfirmedAt,
          emailEnabled: users.twoFactorEmailEnabled,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row;
    },

    /** Store a provisional (not-yet-enabled) encrypted secret, clearing any prior confirm. */
    async setProvisionalSecret(userId: string, encryptedSecret: string): Promise<void> {
      await db
        .update(users)
        .set({
          twoFactorSecret: encryptedSecret,
          twoFactorEnabled: false,
          twoFactorConfirmedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    },

    /** Flip the TOTP method on and stamp the confirm time. */
    async enable(userId: string, when: Date): Promise<void> {
      await db
        .update(users)
        .set({ twoFactorEnabled: true, twoFactorConfirmedAt: when, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    /** Turn the standalone email-code method on or off (#298). */
    async setEmailEnabled(userId: string, enabled: boolean): Promise<void> {
      await db
        .update(users)
        .set({ twoFactorEmailEnabled: enabled, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    /**
     * Wipe just the TOTP secret + flag (the authenticator method), leaving the
     * email method and recovery codes untouched. The service decides separately
     * whether any method remains and whether to drop the recovery codes.
     */
    async clearTotpSecret(userId: string): Promise<void> {
      await db
        .update(users)
        .set({
          twoFactorSecret: null,
          twoFactorEnabled: false,
          twoFactorConfirmedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    },

    /** Drop every recovery code for the user — run when the last method goes off. */
    async clearRecoveryCodes(userId: string): Promise<void> {
      await db.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, userId));
    },

    /** Replace the whole recovery-code set with a fresh batch of hashes. */
    async replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void> {
      await db.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, userId));
      if (codeHashes.length === 0) return;
      await db
        .insert(twoFactorRecoveryCodes)
        .values(codeHashes.map((codeHash) => ({ userId, codeHash })));
    },

    /**
     * Consume a recovery code single-use: mark the matching *unused* row used and
     * report whether one was found. The `usedAt IS NULL` guard makes replay a
     * no-op even under a race — a second attempt updates zero rows.
     */
    async consumeRecoveryCode(userId: string, codeHash: string, when: Date): Promise<boolean> {
      const updated = await db
        .update(twoFactorRecoveryCodes)
        .set({ usedAt: when })
        .where(
          and(
            eq(twoFactorRecoveryCodes.userId, userId),
            eq(twoFactorRecoveryCodes.codeHash, codeHash),
            isNull(twoFactorRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: twoFactorRecoveryCodes.id });
      return updated.length > 0;
    },

    /** How many recovery codes are still unused for the user. */
    async countUnusedRecoveryCodes(userId: string): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(twoFactorRecoveryCodes)
        .where(
          and(eq(twoFactorRecoveryCodes.userId, userId), isNull(twoFactorRecoveryCodes.usedAt)),
        );
      return row?.n ?? 0;
    },
  };
}

export type TwoFactorRepository = ReturnType<typeof createTwoFactorRepository>;

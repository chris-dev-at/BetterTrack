import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';

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
  /**
   * Admin-login email-OTP target (#400): the separately-set "2FA email" an
   * admin-kind account receives its login code on. NULL for every user-kind
   * account (they code to the account email) and for an admin who has not turned
   * the email method on.
   */
  twoFactorEmail: string | null;
}

export interface TwoFactorSecretEnvelope {
  userId: string;
  envelope: string;
}

export function createTwoFactorRepository(db: Database) {
  const securityFence = (userId: string, expectedSecurityGeneration?: number) =>
    expectedSecurityGeneration === undefined
      ? eq(users.id, userId)
      : and(eq(users.id, userId), eq(users.securityGeneration, expectedSecurityGeneration));

  return {
    /** Read the caller's 2FA columns off `users`. */
    async getState(userId: string): Promise<TwoFactorState | undefined> {
      const [row] = await db
        .select({
          secret: users.twoFactorSecret,
          enabled: users.twoFactorEnabled,
          confirmedAt: users.twoFactorConfirmedAt,
          emailEnabled: users.twoFactorEmailEnabled,
          twoFactorEmail: users.twoFactorEmail,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row;
    },

    /** Store a provisional (not-yet-enabled) encrypted secret, clearing any prior confirm. */
    async setProvisionalSecret(
      userId: string,
      encryptedSecret: string,
      expectedSecurityGeneration?: number,
    ): Promise<boolean> {
      const updated = await db
        .update(users)
        .set({
          twoFactorSecret: encryptedSecret,
          twoFactorEnabled: false,
          twoFactorConfirmedAt: null,
          updatedAt: new Date(),
        })
        // A provisional secret grants no authority and does not increment the
        // generation, but an in-flight stale bootstrap request still may not
        // repopulate it after a factor reset.
        .where(securityFence(userId, expectedSecurityGeneration))
        .returning({ id: users.id });
      return updated.length === 1;
    },

    /**
     * Stable cursor page for the online record-encryption command. Only the
     * ciphertext and row identity leave the repository.
     */
    async listSecretEnvelopes(
      afterUserId: string | null,
      limit: number,
    ): Promise<TwoFactorSecretEnvelope[]> {
      const rows = await db
        .select({ userId: users.id, envelope: users.twoFactorSecret })
        .from(users)
        .where(
          afterUserId
            ? and(isNotNull(users.twoFactorSecret), gt(users.id, afterUserId))
            : isNotNull(users.twoFactorSecret),
        )
        .orderBy(asc(users.id))
        .limit(limit);
      return rows.map((row) => ({ userId: row.userId, envelope: row.envelope! }));
    },

    /**
     * Compare-and-swap an encrypted secret. A concurrent enrollment wins and
     * returns false; the migration never overwrites a value it did not inspect.
     */
    async replaceSecretEnvelope(
      userId: string,
      expectedEnvelope: string,
      replacementEnvelope: string,
    ): Promise<boolean> {
      const replaced = await db
        .update(users)
        .set({ twoFactorSecret: replacementEnvelope, updatedAt: new Date() })
        .where(and(eq(users.id, userId), eq(users.twoFactorSecret, expectedEnvelope)))
        .returning({ id: users.id });
      return replaced.length === 1;
    },

    /**
     * Cancel only a provisional TOTP secret. No authority changed, so the
     * generation stays fixed; the expected-generation fence still prevents a
     * request admitted before a reset from writing afterward.
     */
    async clearProvisionalSecret(
      userId: string,
      expectedSecurityGeneration?: number,
    ): Promise<boolean> {
      const updated = await db
        .update(users)
        .set({
          twoFactorSecret: null,
          twoFactorEnabled: false,
          twoFactorConfirmedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            securityFence(userId, expectedSecurityGeneration),
            eq(users.twoFactorEnabled, false),
            isNotNull(users.twoFactorSecret),
          ),
        )
        .returning({ id: users.id });
      return updated.length === 1;
    },

    /**
     * Confirm TOTP and, when it is the first factor, install the initial recovery
     * set in the same transaction as the generation increment.
     */
    async confirmTotp(
      userId: string,
      when: Date,
      recoveryCodeHashes: string[] | null,
      expectedSecurityGeneration?: number,
    ): Promise<number | null> {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({
            twoFactorEnabled: true,
            twoFactorConfirmedAt: when,
            securityGeneration: sql`${users.securityGeneration} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              securityFence(userId, expectedSecurityGeneration),
              eq(users.twoFactorEnabled, false),
              isNotNull(users.twoFactorSecret),
            ),
          )
          .returning({ securityGeneration: users.securityGeneration });
        if (!updated) return null;

        if (recoveryCodeHashes !== null) {
          await tx.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, userId));
          if (recoveryCodeHashes.length > 0) {
            await tx
              .insert(twoFactorRecoveryCodes)
              .values(recoveryCodeHashes.map((codeHash) => ({ userId, codeHash })));
          }
        }
        return updated.securityGeneration;
      });
    },

    /** Disable TOTP and optionally clear the shared recovery set atomically. */
    async disableTotp(
      userId: string,
      clearRecoveryCodes: boolean,
      expectedSecurityGeneration?: number,
    ): Promise<number | null> {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({
            twoFactorSecret: null,
            twoFactorEnabled: false,
            twoFactorConfirmedAt: null,
            securityGeneration: sql`${users.securityGeneration} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              securityFence(userId, expectedSecurityGeneration),
              eq(users.twoFactorEnabled, true),
            ),
          )
          .returning({ securityGeneration: users.securityGeneration });
        if (!updated) return null;
        if (clearRecoveryCodes) {
          await tx.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, userId));
        }
        return updated.securityGeneration;
      });
    },

    /**
     * Enable the email factor, optionally storing the admin-only factor address
     * and initial recovery set, in one generation-fenced transaction.
     */
    async confirmEmail(
      userId: string,
      twoFactorEmail: string | undefined,
      recoveryCodeHashes: string[] | null,
      expectedSecurityGeneration?: number,
    ): Promise<number | null> {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({
            twoFactorEmailEnabled: true,
            ...(twoFactorEmail === undefined ? {} : { twoFactorEmail }),
            securityGeneration: sql`${users.securityGeneration} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              securityFence(userId, expectedSecurityGeneration),
              eq(users.twoFactorEmailEnabled, false),
            ),
          )
          .returning({ securityGeneration: users.securityGeneration });
        if (!updated) return null;

        if (recoveryCodeHashes !== null) {
          await tx.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, userId));
          if (recoveryCodeHashes.length > 0) {
            await tx
              .insert(twoFactorRecoveryCodes)
              .values(recoveryCodeHashes.map((codeHash) => ({ userId, codeHash })));
          }
        }
        return updated.securityGeneration;
      });
    },

    /** Disable email and its optional admin address; clear recovery when last. */
    async disableEmail(
      userId: string,
      clearTwoFactorEmail: boolean,
      clearRecoveryCodes: boolean,
      expectedSecurityGeneration?: number,
    ): Promise<number | null> {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({
            twoFactorEmailEnabled: false,
            ...(clearTwoFactorEmail ? { twoFactorEmail: null } : {}),
            securityGeneration: sql`${users.securityGeneration} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              securityFence(userId, expectedSecurityGeneration),
              eq(users.twoFactorEmailEnabled, true),
            ),
          )
          .returning({ securityGeneration: users.securityGeneration });
        if (!updated) return null;
        if (clearRecoveryCodes) {
          await tx.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, userId));
        }
        return updated.securityGeneration;
      });
    },

    /** Replace every recovery code and bump the security generation atomically. */
    async regenerateRecoveryCodes(
      userId: string,
      codeHashes: string[],
      expectedSecurityGeneration?: number,
    ): Promise<number | null> {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({
            securityGeneration: sql`${users.securityGeneration} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              securityFence(userId, expectedSecurityGeneration),
              sql`(${users.twoFactorEnabled} or ${users.twoFactorEmailEnabled})`,
            ),
          )
          .returning({ securityGeneration: users.securityGeneration });
        if (!updated) return null;

        await tx.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, userId));
        if (codeHashes.length > 0) {
          await tx
            .insert(twoFactorRecoveryCodes)
            .values(codeHashes.map((codeHash) => ({ userId, codeHash })));
        }
        return updated.securityGeneration;
      });
    },

    /**
     * Shell break-glass primitive: all factors, their admin email, recovery
     * codes, and the generation move in one PostgreSQL transaction.
     */
    async resetAllFactors(userId: string): Promise<number | null> {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({
            twoFactorSecret: null,
            twoFactorEnabled: false,
            twoFactorConfirmedAt: null,
            twoFactorEmailEnabled: false,
            twoFactorEmail: null,
            securityGeneration: sql`${users.securityGeneration} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId))
          .returning({ securityGeneration: users.securityGeneration });
        if (!updated) return null;
        await tx.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, userId));
        return updated.securityGeneration;
      });
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

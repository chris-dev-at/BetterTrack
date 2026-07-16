import { and, eq } from 'drizzle-orm';

import type { Database } from '../db';
import { externalIdentities, type ExternalIdentityRow } from '../schema';

export interface CreateExternalIdentityInput {
  userId: string;
  provider: string;
  /** The provider's stable user id (OIDC `sub`). */
  subject: string;
  email: string;
  emailVerified: boolean;
}

/**
 * External (federated) sign-in identities SQL (PROJECTPLAN.md §4.3, §13.4 V4-P4b).
 * All identity SQL lives here. Emails are stored lowercased to match the `users`
 * convention. (provider, subject) is globally unique and (provider, user_id) is
 * unique — so the two `find` helpers each resolve at most one row.
 */
export function createIdentityRepository(db: Database) {
  return {
    /** Resolve a provider identity by its stable subject — the sign-in key. */
    async findByProviderSubject(
      provider: string,
      subject: string,
    ): Promise<ExternalIdentityRow | undefined> {
      const [row] = await db
        .select()
        .from(externalIdentities)
        .where(
          and(eq(externalIdentities.provider, provider), eq(externalIdentities.subject, subject)),
        )
        .limit(1);
      return row;
    },

    /** The caller's linked identity for a provider (for the Settings surface). */
    async findByUserProvider(
      userId: string,
      provider: string,
    ): Promise<ExternalIdentityRow | undefined> {
      const [row] = await db
        .select()
        .from(externalIdentities)
        .where(
          and(eq(externalIdentities.userId, userId), eq(externalIdentities.provider, provider)),
        )
        .limit(1);
      return row;
    },

    async create(input: CreateExternalIdentityInput): Promise<ExternalIdentityRow> {
      const [row] = await db
        .insert(externalIdentities)
        .values({
          userId: input.userId,
          provider: input.provider,
          subject: input.subject,
          email: input.email.trim().toLowerCase(),
          emailVerified: input.emailVerified,
        })
        .returning();
      if (!row) throw new Error('Failed to insert external identity');
      return row;
    },

    /** Refresh the email snapshot a provider asserts on a later sign-in. */
    async updateEmail(id: string, email: string, emailVerified: boolean): Promise<void> {
      await db
        .update(externalIdentities)
        .set({ email: email.trim().toLowerCase(), emailVerified, updatedAt: new Date() })
        .where(eq(externalIdentities.id, id));
    },

    /** Unlink: drop the caller's identity for a provider. Returns whether a row went. */
    async deleteByUserProvider(userId: string, provider: string): Promise<boolean> {
      const rows = await db
        .delete(externalIdentities)
        .where(
          and(eq(externalIdentities.userId, userId), eq(externalIdentities.provider, provider)),
        )
        .returning({ id: externalIdentities.id });
      return rows.length > 0;
    },
  };
}

export type IdentityRepository = ReturnType<typeof createIdentityRepository>;

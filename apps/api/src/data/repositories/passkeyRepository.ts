import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { passkeys, type PasskeyRow } from '../schema';

export type { PasskeyRow } from '../schema';

/** A verified WebAuthn credential to persist after a successful registration. */
export interface CreatePasskeyInput {
  userId: string;
  /** The user-chosen label. */
  name: string;
  /** The authenticator's credential id (base64url) — globally unique. */
  credentialId: string;
  /** The COSE public key, base64url-encoded. */
  publicKey: string;
  /** The signature counter reported at registration. */
  counter: number;
  /** Browser-reported transport hints, or `null` when none were given. */
  transports: string[] | null;
}

/**
 * Passkey persistence (PROJECTPLAN.md §13.4 V4-P4). All SQL for the `passkeys`
 * table lives here (§ data layer). Mutations that address a specific passkey are
 * scoped by `userId` as well as `id`, so a caller can only ever touch their own
 * credentials; lookups by `credentialId` are global because a login assertion
 * arrives with no session and must resolve the owning account from the credential.
 */
export interface PasskeyRepository {
  /** The user's passkeys, newest first (the Settings manager order). */
  listForUser(userId: string): Promise<PasskeyRow[]>;
  /** Resolve a credential by its authenticator id (login lookup — no session). */
  findByCredentialId(credentialId: string): Promise<PasskeyRow | undefined>;
  /** One of the caller's own passkeys, or undefined when it isn't theirs. */
  findByIdForUser(userId: string, id: string): Promise<PasskeyRow | undefined>;
  /** How many passkeys the user has registered. */
  countForUser(userId: string): Promise<number>;
  /** Persist a freshly-verified credential; returns the stored row. */
  create(input: CreatePasskeyInput): Promise<PasskeyRow>;
  /** Rename one of the caller's passkeys; false when no such row is theirs. */
  rename(userId: string, id: string, name: string): Promise<boolean>;
  /** Delete one of the caller's passkeys; false when no such row is theirs. */
  deleteForUser(userId: string, id: string): Promise<boolean>;
  /** Advance the signature counter + stamp last-used after a successful login. */
  markUsed(id: string, counter: number, at: Date): Promise<void>;
}

export function createPasskeyRepository(db: Database): PasskeyRepository {
  return {
    async listForUser(userId) {
      return db
        .select()
        .from(passkeys)
        .where(eq(passkeys.userId, userId))
        .orderBy(desc(passkeys.createdAt));
    },

    async findByCredentialId(credentialId) {
      const [row] = await db
        .select()
        .from(passkeys)
        .where(eq(passkeys.credentialId, credentialId))
        .limit(1);
      return row;
    },

    async findByIdForUser(userId, id) {
      const [row] = await db
        .select()
        .from(passkeys)
        .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
        .limit(1);
      return row;
    },

    async countForUser(userId) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(passkeys)
        .where(eq(passkeys.userId, userId));
      return row?.n ?? 0;
    },

    async create(input) {
      const [row] = await db
        .insert(passkeys)
        .values({
          userId: input.userId,
          name: input.name,
          credentialId: input.credentialId,
          publicKey: input.publicKey,
          counter: input.counter,
          transports: input.transports,
        })
        .returning();
      return row!;
    },

    async rename(userId, id, name) {
      const rows = await db
        .update(passkeys)
        .set({ name })
        .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
        .returning({ id: passkeys.id });
      return rows.length > 0;
    },

    async deleteForUser(userId, id) {
      const rows = await db
        .delete(passkeys)
        .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
        .returning({ id: passkeys.id });
      return rows.length > 0;
    },

    async markUsed(id, counter, at) {
      await db.update(passkeys).set({ counter, lastUsedAt: at }).where(eq(passkeys.id, id));
    },
  };
}

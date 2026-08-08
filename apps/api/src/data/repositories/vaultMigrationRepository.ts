import { VAULT_MIGRATION_CLAIM_TTL_MS } from '@bettertrack/contracts';
import { and, eq, gt, isNull, or, lt } from 'drizzle-orm';

import type { Database } from '../db';
import { paranoidVaults, vaults } from '../schema';

/**
 * Server-coordinated v1 → v2 migration (`docs/VAULTS_V2_DESIGN.md` r2 §11).
 *
 * The legacy account vault row carries the whole protocol state, which is what
 * makes it a real coordination point rather than an advisory one: the claim and
 * the flip are compare-and-swap `UPDATE … WHERE` statements, so two clients
 * racing produce exactly one winner without an application-level lock.
 *
 * Ordering of the three states, and what each guarantees:
 *  - unclaimed             → any client may claim.
 *  - claimed (nonce, TTL)  → only that nonce may renew or flip; others read the
 *                            claim and wait, with v1 still authoritative.
 *  - migrated (migratedTo) → terminal. v1 becomes a read-only tombstone; the
 *                            named v2 vault is authoritative. Never reversible.
 *
 * A crashed half-migration is invisible to other clients precisely because the
 * flip never happened: the claim simply expires and the next claimant re-lists
 * the v2 documents and continues. That is why the v2 document identities are
 * deterministic — every write on resume is idempotent.
 */

export interface VaultMigrationStateRow {
  legacyPresent: boolean;
  migratingBy: string | null;
  claimExpiresAt: Date | null;
  migratedTo: string | null;
}

export type VaultMigrationClaimResult =
  | { status: 'ok'; state: VaultMigrationStateRow }
  /** Another live claim holds the row (or the migration already flipped). */
  | { status: 'claimed'; state: VaultMigrationStateRow }
  | { status: 'not_found' };

export type VaultMigrationFlipResult =
  | { status: 'ok'; state: VaultMigrationStateRow }
  /** No live claim for this nonce — the caller must re-claim and re-verify. */
  | { status: 'incomplete'; state: VaultMigrationStateRow }
  | { status: 'not_found' }
  /** The named v2 vault does not belong to this account. */
  | { status: 'vault_not_found' };

export interface VaultMigrationRepository {
  getState(userId: string): Promise<VaultMigrationStateRow>;
  claim(userId: string, clientNonce: string, now?: Date): Promise<VaultMigrationClaimResult>;
  renew(userId: string, clientNonce: string, now?: Date): Promise<VaultMigrationClaimResult>;
  flip(
    userId: string,
    clientNonce: string,
    vaultId: string,
    now?: Date,
  ): Promise<VaultMigrationFlipResult>;
}

const ABSENT: VaultMigrationStateRow = {
  legacyPresent: false,
  migratingBy: null,
  claimExpiresAt: null,
  migratedTo: null,
};

function toState(row: {
  migratingBy: string | null;
  migrationExpiresAt: Date | null;
  migratedTo: string | null;
}): VaultMigrationStateRow {
  return {
    legacyPresent: true,
    migratingBy: row.migratingBy,
    claimExpiresAt: row.migrationExpiresAt,
    migratedTo: row.migratedTo,
  };
}

export function createVaultMigrationRepository(db: Database): VaultMigrationRepository {
  const read = async (tx: Database, userId: string): Promise<VaultMigrationStateRow> => {
    const [row] = await tx
      .select({
        migratingBy: paranoidVaults.migratingBy,
        migrationExpiresAt: paranoidVaults.migrationExpiresAt,
        migratedTo: paranoidVaults.migratedTo,
      })
      .from(paranoidVaults)
      .where(eq(paranoidVaults.userId, userId));
    return row ? toState(row) : ABSENT;
  };

  return {
    async getState(userId) {
      return read(db, userId);
    },

    async claim(userId, clientNonce, now = new Date()) {
      const expiresAt = new Date(now.getTime() + VAULT_MIGRATION_CLAIM_TTL_MS);
      // One CAS statement IS the mutual exclusion: it matches only a row that is
      // unclaimed, expired, or already held by this same nonce (a re-claim after
      // a crash), and that has not flipped. Two racing clients therefore produce
      // exactly one winner with no advisory lock.
      const [row] = await db
        .update(paranoidVaults)
        .set({ migratingBy: clientNonce, migrationExpiresAt: expiresAt, updatedAt: now })
        .where(
          and(
            eq(paranoidVaults.userId, userId),
            isNull(paranoidVaults.migratedTo),
            or(
              isNull(paranoidVaults.migratingBy),
              eq(paranoidVaults.migratingBy, clientNonce),
              isNull(paranoidVaults.migrationExpiresAt),
              lt(paranoidVaults.migrationExpiresAt, now),
            ),
          ),
        )
        .returning({
          migratingBy: paranoidVaults.migratingBy,
          migrationExpiresAt: paranoidVaults.migrationExpiresAt,
          migratedTo: paranoidVaults.migratedTo,
        });
      if (row) return { status: 'ok', state: toState(row) };
      const current = await read(db, userId);
      if (!current.legacyPresent) return { status: 'not_found' };
      return { status: 'claimed', state: current };
    },

    async renew(userId, clientNonce, now = new Date()) {
      const expiresAt = new Date(now.getTime() + VAULT_MIGRATION_CLAIM_TTL_MS);
      // Renew is deliberately stricter than claim: it extends only a claim that
      // is BOTH this nonce's and still live. A holder that let its TTL lapse must
      // go back through `claim`, where it can lose to a client that took over.
      const [row] = await db
        .update(paranoidVaults)
        .set({ migrationExpiresAt: expiresAt, updatedAt: now })
        .where(
          and(
            eq(paranoidVaults.userId, userId),
            isNull(paranoidVaults.migratedTo),
            eq(paranoidVaults.migratingBy, clientNonce),
            gt(paranoidVaults.migrationExpiresAt, now),
          ),
        )
        .returning({
          migratingBy: paranoidVaults.migratingBy,
          migrationExpiresAt: paranoidVaults.migrationExpiresAt,
          migratedTo: paranoidVaults.migratedTo,
        });
      if (row) return { status: 'ok', state: toState(row) };
      const current = await read(db, userId);
      if (!current.legacyPresent) return { status: 'not_found' };
      return { status: 'claimed', state: current };
    },

    async flip(userId, clientNonce, vaultId, now = new Date()) {
      return db.transaction(async (tx) => {
        // The successor must be a real v2 vault of THIS account, checked inside
        // the same transaction as the flip. Pointing the tombstone at a foreign
        // or absent vault would make the account's data unreachable forever.
        const [vault] = await tx
          .select({ id: vaults.id })
          .from(vaults)
          .where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)));
        if (!vault) return { status: 'vault_not_found' as const };
        const [row] = await tx
          .update(paranoidVaults)
          .set({
            migratedTo: vaultId,
            migratingBy: null,
            migrationExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(paranoidVaults.userId, userId),
              isNull(paranoidVaults.migratedTo),
              eq(paranoidVaults.migratingBy, clientNonce),
              gt(paranoidVaults.migrationExpiresAt, now),
            ),
          )
          .returning({
            migratingBy: paranoidVaults.migratingBy,
            migrationExpiresAt: paranoidVaults.migrationExpiresAt,
            migratedTo: paranoidVaults.migratedTo,
          });
        if (row) return { status: 'ok' as const, state: toState(row) };
        const current = await read(tx, userId);
        if (!current.legacyPresent) return { status: 'not_found' as const };
        // Already flipped by this same client: acknowledge idempotently rather
        // than sending a resumed migration back through the whole protocol.
        if (current.migratedTo === vaultId) return { status: 'ok' as const, state: current };
        return { status: 'incomplete' as const, state: current };
      });
    },
  };
}

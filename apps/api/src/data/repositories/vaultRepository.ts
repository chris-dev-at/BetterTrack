import { and, asc, count, eq } from 'drizzle-orm';

import type { VaultConfig, VaultMediaList } from '@bettertrack/contracts';

import type { Database } from '../db';
import { driveConnections, portfolios, users, vaultRetirements, vaults } from '../schema';

export type VaultCreateResult =
  | { status: 'ok'; vault: VaultConfig }
  | { status: 'name_taken' }
  | { status: 'drive_not_found' }
  | { status: 'reserved_medium' };

export type VaultPatchResult =
  | { status: 'ok'; vault: VaultConfig }
  | { status: 'not_found' }
  | { status: 'name_taken' };

export type VaultDeleteResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'referenced' }
  | { status: 'retirement_pending' };

export interface VaultDeleteLockedAuth {
  passwordHash: string;
  twoFactorSecret: string | null;
  twoFactorEnabled: boolean;
  twoFactorEmailEnabled: boolean;
}

export interface VaultRepository {
  list(userId: string): Promise<VaultConfig[]>;
  find(userId: string, vaultId: string): Promise<VaultConfig | null>;
  create(input: {
    userId: string;
    name: string;
    media: VaultMediaList;
    driveConnectionId: string | null;
    headerDocId: string;
    commonDocId: string;
    keyFingerprint: string;
    retirementProofPublicKey: string;
  }): Promise<VaultCreateResult>;
  patch(userId: string, vaultId: string, name: string): Promise<VaultPatchResult>;
  delete(input: {
    userId: string;
    vaultId: string;
    verifyStepUp: (auth: VaultDeleteLockedAuth, tx: Database) => Promise<void>;
  }): Promise<VaultDeleteResult>;
}

function configOf(row: typeof vaults.$inferSelect): VaultConfig {
  return {
    id: row.id,
    name: row.name,
    media: row.media as VaultMediaList,
    driveConnectionId: row.driveConnectionId,
    headerDocId: row.headerDocId,
    commonDocId: row.commonDocId,
    keyFingerprint: row.keyFingerprint,
    retirementProofPublicKey: row.retirementProofPublicKey,
    retirementGeneration: row.retirementGeneration,
    mediaAttestedAt: row.mediaAttestedAt?.toISOString() ?? null,
    mediaAttestedDriveConnectionId: row.mediaAttestedDriveConnectionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

function isPortfolioVaultForeignKey(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
  };
  if (candidate?.code !== '23503') return false;
  const constraint =
    (typeof candidate.constraint === 'string' && candidate.constraint) ||
    (typeof candidate.constraint_name === 'string' && candidate.constraint_name) ||
    '';
  return (
    constraint === 'portfolios_vault_id_vaults_id_fk' ||
    (typeof candidate.message === 'string' &&
      candidate.message.includes('portfolios_vault_id_vaults_id_fk'))
  );
}

function isVaultDriveForeignKey(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
  };
  if (candidate?.code !== '23503') return false;
  const constraint =
    (typeof candidate.constraint === 'string' && candidate.constraint) ||
    (typeof candidate.constraint_name === 'string' && candidate.constraint_name) ||
    '';
  return (
    constraint === 'vaults_drive_connection_id_drive_connections_id_fk' ||
    (typeof candidate.message === 'string' &&
      candidate.message.includes('vaults_drive_connection_id_drive_connections_id_fk'))
  );
}

/** Config persistence for the per-vault model. Every lookup is owner-scoped. */
export function createVaultRepository(db: Database): VaultRepository {
  return {
    async list(userId) {
      const rows = await db
        .select()
        .from(vaults)
        .where(eq(vaults.userId, userId))
        .orderBy(asc(vaults.createdAt), asc(vaults.id));
      return rows.map(configOf);
    },

    async find(userId, vaultId) {
      const [row] = await db
        .select()
        .from(vaults)
        .where(and(eq(vaults.userId, userId), eq(vaults.id, vaultId)))
        .limit(1);
      return row ? configOf(row) : null;
    },

    async create(input) {
      if (input.media.includes('local')) return { status: 'reserved_medium' };
      try {
        return await db.transaction(async (tx) => {
          if (input.driveConnectionId) {
            const [connection] = await tx
              .select({ id: driveConnections.id })
              .from(driveConnections)
              .where(
                and(
                  eq(driveConnections.id, input.driveConnectionId),
                  eq(driveConnections.userId, input.userId),
                ),
              )
              .limit(1);
            if (!connection) return { status: 'drive_not_found' as const };
          }
          const now = new Date();
          const [row] = await tx
            .insert(vaults)
            .values({
              userId: input.userId,
              name: input.name,
              media: input.media,
              driveConnectionId: input.driveConnectionId,
              headerDocId: input.headerDocId,
              commonDocId: input.commonDocId,
              keyFingerprint: input.keyFingerprint,
              retirementProofPublicKey: input.retirementProofPublicKey,
              // Creation provisions the selected homes. A later media edge is
              // what earns an attestation stamp after a complete round trip.
              mediaAttestedAt: null,
              mediaAttestedDriveConnectionId: null,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (!row) throw new Error('vault insert returned no row');
          return { status: 'ok' as const, vault: configOf(row) };
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { status: 'name_taken' };
        // The Drive binding is DEFERRABLE INITIALLY DEFERRED. A connection
        // removed after the owner-scoped check therefore fails at transaction
        // commit; keep that race on the same stable 409 path as an early miss.
        if (isVaultDriveForeignKey(error)) return { status: 'drive_not_found' };
        throw error;
      }
    },

    async patch(userId, vaultId, name) {
      try {
        const [row] = await db
          .update(vaults)
          .set({ name, updatedAt: new Date() })
          .where(and(eq(vaults.userId, userId), eq(vaults.id, vaultId)))
          .returning();
        return row ? { status: 'ok', vault: configOf(row) } : { status: 'not_found' };
      } catch (error) {
        if (isUniqueViolation(error)) return { status: 'name_taken' };
        throw error;
      }
    },

    async delete(input) {
      try {
        return await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Database;
          // Lock order is account then vault everywhere a credential gates a
          // destructive vault write. The factor/password columns are therefore
          // the exact state the commit is authorized against (§15).
          const [owner] = await tx
            .select({
              passwordHash: users.passwordHash,
              twoFactorSecret: users.twoFactorSecret,
              twoFactorEnabled: users.twoFactorEnabled,
              twoFactorEmailEnabled: users.twoFactorEmailEnabled,
            })
            .from(users)
            .where(eq(users.id, input.userId))
            .for('update');
          if (!owner) return { status: 'not_found' as const };

          const [vault] = await tx
            .select({ id: vaults.id })
            .from(vaults)
            .where(and(eq(vaults.id, input.vaultId), eq(vaults.userId, input.userId)))
            .for('update');
          if (!vault) return { status: 'not_found' as const };

          const [retirement] = await tx
            .select({ vaultId: vaultRetirements.vaultId })
            .from(vaultRetirements)
            .where(eq(vaultRetirements.vaultId, input.vaultId))
            .for('update');

          const [members] = await tx
            .select({ value: count() })
            .from(portfolios)
            .where(eq(portfolios.vaultId, input.vaultId));

          // Resolve blockers under the same locks, but do not disclose either
          // result until §15 step-up succeeds. This keeps account:security
          // bearers from probing deletion state with an unverified credential.
          await input.verifyStepUp(owner, tx);
          if (retirement) return { status: 'retirement_pending' as const };
          if (Number(members?.value ?? 0) > 0) return { status: 'referenced' as const };
          await tx
            .delete(vaults)
            .where(and(eq(vaults.id, input.vaultId), eq(vaults.userId, input.userId)));
          return { status: 'ok' as const };
        });
      } catch (error) {
        // The portfolios FK is DEFERRABLE INITIALLY DEFERRED. A concurrent
        // reference can therefore surface only when `db.transaction()` commits,
        // after its callback returned. Map that boundary explicitly to the same
        // stable 409 as the in-transaction count instead of leaking a 500.
        if (isPortfolioVaultForeignKey(error)) return { status: 'referenced' };
        throw error;
      }
    },
  };
}

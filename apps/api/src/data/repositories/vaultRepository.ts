import { and, asc, count, eq, inArray } from 'drizzle-orm';

import type { VaultConfig, VaultMediaList } from '@bettertrack/contracts';

import type { Database } from '../db';
import { driverError, isDriverErrorCode } from '../driverError';
import {
  driveConnections,
  portfolioVaultTransitionStates,
  portfolios,
  users,
  vaultRetirements,
  vaults,
} from '../schema';
import { isLiveCaptureBinding } from './portfolioVaultTransitionRepository';

export type VaultCreateResult =
  | { status: 'ok'; vault: VaultConfig }
  | { status: 'name_taken' }
  | { status: 'drive_not_found' }
  | { status: 'portfolio_binding_mismatch' }
  | { status: 'reserved_medium' };

export type VaultPatchResult =
  | { status: 'ok'; vault: VaultConfig }
  | { status: 'not_found' }
  | { status: 'name_taken' };

export type VaultDeleteResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'referenced' }
  | { status: 'retirement_pending' }
  /** #1610: a live portfolio capture has staged its move-in into this vault. */
  | { status: 'move_in_pending'; portfolioIds: string[] };

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
    /** Capture-window clock, sampled only after every row lock is held. */
    now?: () => Date;
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
  return isDriverErrorCode(error, '23505');
}

function isPortfolioVaultForeignKey(error: unknown): boolean {
  const candidate = driverError(error) as {
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
  const candidate = driverError(error) as {
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
          // R1 reserves both singleton addresses for config docs. Reject a
          // collision with any portfolio UUID in this owner's namespace before
          // creating the vault; otherwise that portfolio could never join the
          // vault without making its required full-doc roster ambiguous.
          const [portfolioCollision] = await tx
            .select({ id: portfolios.id })
            .from(portfolios)
            .where(
              and(
                eq(portfolios.userId, input.userId),
                inArray(portfolios.id, [input.headerDocId, input.commonDocId]),
              ),
            )
            .limit(1);
          if (portfolioCollision) return { status: 'portfolio_binding_mismatch' as const };

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
          // The account row is the first lock everywhere a credential gates a
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

          // R5 review round 1: spend and audit step-up before even resolving
          // whether this owner has the supplied vault id. In particular, an
          // account:security bearer cannot use an invalid credential to probe
          // vault existence or any later deletion gate.
          await input.verifyStepUp(owner, tx);

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

          // #1610: `capture_vault_id` has no FK by design (the transition
          // receipts must outlive a vault), so nothing in the schema stops this
          // delete from orphaning a capture binding. Every writer that can bind
          // a capture to this vault (staging CAS, Drive candidate staging) or
          // move an existing binding (renewal, move-in commit) holds this vault
          // row, which is locked above, so this owner-scoped discovery read is
          // the complete set. Lock order stays E1's: account -> vault ->
          // portfolio -> transition state. Another account's row is never read
          // here; it cannot block or be rewritten by this owner's delete.
          const discovered = await tx
            .select({ portfolioId: portfolioVaultTransitionStates.portfolioId })
            .from(portfolioVaultTransitionStates)
            .where(
              and(
                eq(portfolioVaultTransitionStates.userId, input.userId),
                eq(portfolioVaultTransitionStates.captureVaultId, input.vaultId),
              ),
            );
          const boundPortfolioIds = discovered.map(({ portfolioId }) => portfolioId).sort();
          let bound: Array<typeof portfolioVaultTransitionStates.$inferSelect> = [];
          if (boundPortfolioIds.length > 0) {
            await tx
              .select({ id: portfolios.id })
              .from(portfolios)
              .where(
                and(eq(portfolios.userId, input.userId), inArray(portfolios.id, boundPortfolioIds)),
              )
              .orderBy(asc(portfolios.id))
              .for('update');
            bound = await tx
              .select()
              .from(portfolioVaultTransitionStates)
              .where(
                and(
                  eq(portfolioVaultTransitionStates.userId, input.userId),
                  eq(portfolioVaultTransitionStates.captureVaultId, input.vaultId),
                  inArray(portfolioVaultTransitionStates.portfolioId, boundPortfolioIds),
                ),
              )
              .orderBy(asc(portfolioVaultTransitionStates.portfolioId))
              .for('update');
          }
          const lockedAt = (input.now ?? (() => new Date()))();
          const inFlight = bound
            .filter((state) => isLiveCaptureBinding(state, lockedAt))
            .map(({ portfolioId }) => portfolioId);

          // Resolve and disclose blockers only after §15 step-up succeeds.
          if (retirement) return { status: 'retirement_pending' as const };
          if (Number(members?.value ?? 0) > 0) return { status: 'referenced' as const };
          // Fail closed while a move-in can still consume this vault: deleting
          // it would cascade the staged document out from under that capture.
          if (inFlight.length > 0) {
            return { status: 'move_in_pending' as const, portfolioIds: inFlight };
          }
          // Every remaining binding is expired and therefore inert (no reader
          // admits it). Drop it in the same commit as the vault, so no pointer
          // to a deleted vault ever survives. The prospective documents
          // themselves cascade with the vault row; the lapsed revision/window
          // pair is left as it is (only the dangling pointer goes).
          if (bound.length > 0) {
            await tx
              .update(portfolioVaultTransitionStates)
              .set({
                captureVaultId: null,
                captureMediaAttestedAt: null,
                captureMediaAttestedDriveConnectionId: null,
                updatedAt: lockedAt,
              })
              .where(
                and(
                  eq(portfolioVaultTransitionStates.userId, input.userId),
                  eq(portfolioVaultTransitionStates.captureVaultId, input.vaultId),
                  inArray(
                    portfolioVaultTransitionStates.portfolioId,
                    bound.map(({ portfolioId }) => portfolioId),
                  ),
                ),
              );
          }
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

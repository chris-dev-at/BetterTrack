import { and, asc, eq } from 'drizzle-orm';

import type { CreateDriveConnectionRequest, DriveConnection } from '@bettertrack/contracts';

import type { Database } from '../db';
import { driverError } from '../driverError';
import { driveConnections, vaults } from '../schema';

export interface DetachedVault {
  id: string;
  /** Media set left on the vault once `drive` was removed; audited by the caller. */
  media: string[];
}

export type DriveConnectionDeleteResult =
  | { status: 'ok'; detachedVaults: DetachedVault[] }
  | { status: 'not_found' }
  | { status: 'bound'; vaults: { id: string; name: string }[] }
  | { status: 'last_medium'; vaults: { id: string; name: string }[] };

/**
 * The registry upsert is create-or-refresh: re-consenting an already registered
 * Google account lands on the same `(user_id, google_sub)` row. `created`
 * separates the two so the audit trail does not claim a second registration
 * that never happened.
 */
export interface DriveConnectionUpsert {
  connection: DriveConnection;
  created: boolean;
}

export interface DriveConnectionRepository {
  list(userId: string): Promise<DriveConnection[]>;
  create(
    userId: string,
    identity: CreateDriveConnectionRequest,
    verifiedAt: Date,
  ): Promise<DriveConnectionUpsert>;
  touch(userId: string, connectionId: string, verifiedAt: Date): Promise<DriveConnection | null>;
  delete(
    userId: string,
    connectionId: string,
    acknowledgeBound: boolean,
    now: Date,
  ): Promise<DriveConnectionDeleteResult>;
}

function dto(row: typeof driveConnections.$inferSelect): DriveConnection {
  return {
    id: row.id,
    googleSub: row.googleSub,
    email: row.email,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt.toISOString(),
  };
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

/**
 * The Drive registry is identity/config only. Every id-addressed query carries
 * both columns of the ownership boundary `(user_id, id)` here in the data
 * layer; routes and services never receive an unscoped repository primitive.
 */
export function createDriveConnectionRepository(db: Database): DriveConnectionRepository {
  return {
    async list(userId) {
      const rows = await db
        .select()
        .from(driveConnections)
        .where(eq(driveConnections.userId, userId))
        .orderBy(asc(driveConnections.createdAt), asc(driveConnections.id));
      return rows.map(dto);
    },

    async create(userId, identity, verifiedAt) {
      const [row] = await db
        .insert(driveConnections)
        .values({
          userId,
          googleSub: identity.googleSub,
          email: identity.email,
          displayName: identity.displayName,
          // Stamped explicitly (rather than left to the column default) so the
          // returned row tells an insert from a conflict update: the update arm
          // never touches `created_at`.
          createdAt: verifiedAt,
          lastVerifiedAt: verifiedAt,
        })
        .onConflictDoUpdate({
          target: [driveConnections.userId, driveConnections.googleSub],
          set: {
            email: identity.email,
            displayName: identity.displayName,
            lastVerifiedAt: verifiedAt,
          },
        })
        .returning();
      if (!row) throw new Error('Drive connection upsert returned no row.');
      return { connection: dto(row), created: row.createdAt.getTime() === verifiedAt.getTime() };
    },

    async touch(userId, connectionId, verifiedAt) {
      const [row] = await db
        .update(driveConnections)
        .set({ lastVerifiedAt: verifiedAt })
        .where(and(eq(driveConnections.userId, userId), eq(driveConnections.id, connectionId)))
        .returning();
      return row ? dto(row) : null;
    },

    async delete(userId, connectionId, acknowledgeBound, now) {
      try {
        return await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Database;
          const [connection] = await tx
            .select({ id: driveConnections.id })
            .from(driveConnections)
            .where(and(eq(driveConnections.userId, userId), eq(driveConnections.id, connectionId)))
            .for('update')
            .limit(1);
          if (!connection) return { status: 'not_found' as const };

          const bound = await tx
            .select({
              id: vaults.id,
              name: vaults.name,
              media: vaults.media,
              mediaAttestedAt: vaults.mediaAttestedAt,
            })
            .from(vaults)
            .where(and(eq(vaults.userId, userId), eq(vaults.driveConnectionId, connectionId)))
            .orderBy(asc(vaults.name), asc(vaults.id))
            .for('update');
          // A Drive-only vault is NOT detachable, acknowledgement or not: the
          // media set would become empty, which `vaults_media_state` rejects
          // outright, and the vault's only copy of every doc lives in the Drive
          // this row addresses — "leave the files in Drive" would leave them
          // unreachable, not preserved. Logged as a deliberate narrowing of the
          // #1415 acceptance line in PROJECTPLAN §16 (2026-08-21).
          //
          // `media` alone is NOT the test. It is the owner's DECLARED selection,
          // written at creation before a single byte exists: a vault created
          // `['server','drive']` carries `media_attested_at = null` and zero
          // `vault_blobs` rows until the first R3 full-doc-set attestation, so
          // trusting the label would detach it while the acknowledgement copy
          // promises "keeps each verified server copy exactly as it is" — of a
          // server copy that is not there. `media_attested_at` is the server's
          // own record that the full doc set was verified across the media, and
          // `vaults_media_attestation_state` ties that stamp to this very Drive
          // binding, so a non-null stamp on a server-selected vault is exactly
          // "a verified server copy exists". Anything else is last-medium.
          //
          // Order matters for honesty, not for safety: `last_medium` does not
          // depend on the acknowledgement, so deciding it first spares such an
          // owner the detour of accepting a loss of reach that was never on offer
          // (they would otherwise see BOUND, acknowledge it, and only then meet
          // the refusal that held all along).
          const lastMedium = bound.filter(
            ({ media, mediaAttestedAt }) => !media.includes('server') || mediaAttestedAt === null,
          );
          if (lastMedium.length > 0) {
            return {
              status: 'last_medium' as const,
              vaults: lastMedium.map(({ id, name }) => ({ id, name })),
            };
          }

          if (bound.length > 0 && !acknowledgeBound) {
            return {
              status: 'bound' as const,
              vaults: bound.map(({ id, name }) => ({ id, name })),
            };
          }

          // Explicit loss-of-reach acknowledgement is meaningful only for a
          // replicated vault: keep its verified server copy active, detach Drive
          // config, and leave the user's Drive files untouched. The attestation
          // stamps go with it: `mediaAttestedAt` covered a media set that includes
          // the Drive copy this row no longer reaches, so it is void — the next
          // operation that needs a proof takes a fresh client attestation rather
          // than inheriting one made about a medium that is gone.
          const detachedVaults: DetachedVault[] = [];
          for (const vault of bound) {
            const media = vault.media.filter((medium) => medium !== 'drive');
            await tx
              .update(vaults)
              .set({
                media,
                driveConnectionId: null,
                mediaAttestedAt: null,
                mediaAttestedDriveConnectionId: null,
                updatedAt: now,
              })
              .where(and(eq(vaults.userId, userId), eq(vaults.id, vault.id)));
            detachedVaults.push({ id: vault.id, media });
          }

          const [deleted] = await tx
            .delete(driveConnections)
            .where(and(eq(driveConnections.userId, userId), eq(driveConnections.id, connectionId)))
            .returning({ id: driveConnections.id });
          return deleted
            ? { status: 'ok' as const, detachedVaults }
            : { status: 'not_found' as const };
        });
      } catch (error) {
        // The vault binding is DEFERRABLE INITIALLY DEFERRED. A vault created
        // after this transaction's bound-row scan can therefore reject the
        // disconnect only when `db.transaction()` commits. Keep that overlap
        // in the existing stable 409 family instead of leaking a raw 500.
        if (isVaultDriveForeignKey(error)) return { status: 'bound', vaults: [] };
        throw error;
      }
    },
  };
}

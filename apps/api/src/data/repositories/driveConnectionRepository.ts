import { and, asc, eq } from 'drizzle-orm';

import type { CreateDriveConnectionRequest, DriveConnection } from '@bettertrack/contracts';

import type { Database } from '../db';
import { driveConnections, vaults } from '../schema';

export type DriveConnectionDeleteResult =
  | { status: 'ok'; detachedVaultIds: string[] }
  | { status: 'not_found' }
  | { status: 'bound'; vaults: { id: string; name: string }[] }
  | { status: 'last_medium'; vaults: { id: string; name: string }[] };

export interface DriveConnectionRepository {
  list(userId: string): Promise<DriveConnection[]>;
  create(
    userId: string,
    identity: CreateDriveConnectionRequest,
    verifiedAt: Date,
  ): Promise<DriveConnection>;
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
      return dto(row);
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
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const [connection] = await tx
          .select({ id: driveConnections.id })
          .from(driveConnections)
          .where(and(eq(driveConnections.userId, userId), eq(driveConnections.id, connectionId)))
          .for('update')
          .limit(1);
        if (!connection) return { status: 'not_found' as const };

        const bound = await tx
          .select({ id: vaults.id, name: vaults.name, media: vaults.media })
          .from(vaults)
          .where(and(eq(vaults.userId, userId), eq(vaults.driveConnectionId, connectionId)))
          .orderBy(asc(vaults.name), asc(vaults.id))
          .for('update');
        const summaries = bound.map(({ id, name }) => ({ id, name }));
        if (bound.length > 0 && !acknowledgeBound) {
          return { status: 'bound' as const, vaults: summaries };
        }

        const lastMedium = bound.filter(({ media }) => !media.includes('server'));
        if (lastMedium.length > 0) {
          return {
            status: 'last_medium' as const,
            vaults: lastMedium.map(({ id, name }) => ({ id, name })),
          };
        }

        // Explicit loss-of-reach acknowledgement is meaningful only for a
        // replicated vault: keep its verified server copy active, detach Drive
        // config, and leave the user's Drive files untouched.
        for (const vault of bound) {
          await tx
            .update(vaults)
            .set({
              media: vault.media.filter((medium) => medium !== 'drive'),
              driveConnectionId: null,
              mediaAttestedAt: null,
              mediaAttestedDriveConnectionId: null,
              updatedAt: now,
            })
            .where(and(eq(vaults.userId, userId), eq(vaults.id, vault.id)));
        }

        const [deleted] = await tx
          .delete(driveConnections)
          .where(and(eq(driveConnections.userId, userId), eq(driveConnections.id, connectionId)))
          .returning({ id: driveConnections.id });
        return deleted
          ? { status: 'ok' as const, detachedVaultIds: bound.map(({ id }) => id) }
          : { status: 'not_found' as const };
      });
    },
  };
}

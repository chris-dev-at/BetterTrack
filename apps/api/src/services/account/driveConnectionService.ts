import type { CreateDriveConnectionRequest, DriveConnection } from '@bettertrack/contracts';

import type {
  DriveConnectionDeleteResult,
  DriveConnectionRepository,
} from '../../data/repositories/driveConnectionRepository';
import { AuditAction, type AuditService } from '../audit/auditService';

export interface DriveConnectionService {
  list(userId: string): Promise<DriveConnection[]>;
  create(
    userId: string,
    identity: CreateDriveConnectionRequest,
    ip?: string | null,
  ): Promise<DriveConnection>;
  touch(userId: string, connectionId: string): Promise<DriveConnection | null>;
  delete(
    userId: string,
    connectionId: string,
    acknowledgeBound: boolean,
    ip?: string | null,
  ): Promise<DriveConnectionDeleteResult>;
}

/**
 * Registry lifecycle. Connect and disconnect are audited like every other
 * account-config change, and a disconnect that drops `drive` from a vault's
 * media records the same `vault.media_changed` entry the explicit
 * `PATCH /vaults/:id/media` route writes — a medium never disappears silently.
 * A verification touch is not audited: it is a read-shaped liveness ping the
 * panel fires on every open.
 */
export function createDriveConnectionService(
  repository: DriveConnectionRepository,
  audit: AuditService,
  now: () => Date = () => new Date(),
): DriveConnectionService {
  return {
    list: (userId) => repository.list(userId),

    async create(userId, identity, ip) {
      const connection = await repository.create(userId, identity, now());
      await audit.record({
        actorId: userId,
        action: AuditAction.DriveConnectionCreated,
        targetType: 'drive_connection',
        targetId: connection.id,
        ip,
        meta: { googleSub: connection.googleSub },
      });
      return connection;
    },

    touch: (userId, connectionId) => repository.touch(userId, connectionId, now()),

    async delete(userId, connectionId, acknowledgeBound, ip) {
      const result = await repository.delete(userId, connectionId, acknowledgeBound, now());
      if (result.status !== 'ok') return result;
      await audit.record({
        actorId: userId,
        action: AuditAction.DriveConnectionDeleted,
        targetType: 'drive_connection',
        targetId: connectionId,
        ip,
        meta: { detachedVaults: result.detachedVaults.length },
      });
      for (const vault of result.detachedVaults) {
        await audit.record({
          actorId: userId,
          action: AuditAction.VaultMediaChanged,
          targetType: 'vault',
          targetId: vault.id,
          ip,
          meta: { media: vault.media, via: 'drive_connection_disconnect' },
        });
      }
      return result;
    },
  };
}

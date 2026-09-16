import type {
  CreateDriveConnectionRequest,
  DriveConnection,
  VaultStepUpCredential,
} from '@bettertrack/contracts';

import type {
  DriveConnectionDeleteResult,
  DriveConnectionRepository,
  DriveConnectionUpsert,
} from '../../data/repositories/driveConnectionRepository';
import { AuditAction, type AuditService } from '../audit/auditService';
import type { VaultDeleteReauth } from './paranoidDiscardReauth';

export interface DriveConnectionService {
  list(userId: string): Promise<DriveConnection[]>;
  create(
    userId: string,
    identity: CreateDriveConnectionRequest,
    ip?: string | null,
  ): Promise<DriveConnectionUpsert>;
  touch(userId: string, connectionId: string): Promise<DriveConnection | null>;
  delete(input: {
    userId: string;
    connectionId: string;
    acknowledgeBound: boolean;
    ip?: string | null;
    /**
     * Present exactly when `acknowledgeBound` is — the route's contract pairs
     * them. `undefined` here therefore means "no loss asserted"; the repository
     * never reaches its §15 gate in that case, and a direct service call that
     * asserts loss without one fails closed in the verifier.
     */
    stepUp?: VaultStepUpCredential;
  }): Promise<DriveConnectionDeleteResult>;
}

/**
 * Registry lifecycle. Connect (created vs refreshed) and disconnect are audited
 * like every other account-config change, and a disconnect that drops `drive` from a vault's
 * media records the same `vault.media_changed` entry the explicit
 * `PATCH /vaults/:id/media` route writes — a medium never disappears silently.
 * A verification touch is not audited: it is a read-shaped liveness ping the
 * panel fires on every open.
 */
export function createDriveConnectionService(
  repository: DriveConnectionRepository,
  audit: AuditService,
  /**
   * The §15 step-up verifier, shared with vault deletion and both portfolio
   * moves. A required dependency rather than an optional one: a composition
   * that forgets it must not typecheck, because the failure mode is a riding
   * session dropping a vault's second copy with one DELETE (#1632).
   */
  reauth: VaultDeleteReauth,
  now: () => Date = () => new Date(),
): DriveConnectionService {
  return {
    list: (userId) => repository.list(userId),

    async create(userId, identity, ip) {
      const upsert = await repository.create(userId, identity, now());
      await audit.record({
        actorId: userId,
        // Re-consenting a known account upserts onto the same connection id; a
        // second `created` entry would claim a registration that never happened.
        action: upsert.created
          ? AuditAction.DriveConnectionCreated
          : AuditAction.DriveConnectionRefreshed,
        targetType: 'drive_connection',
        targetId: upsert.connection.id,
        ip,
        meta: { googleSub: upsert.connection.googleSub },
      });
      return upsert;
    },

    touch: (userId, connectionId) => repository.touch(userId, connectionId, now()),

    async delete({ userId, connectionId, acknowledgeBound, ip, stepUp }) {
      let result: DriveConnectionDeleteResult;
      try {
        result = await repository.delete({
          userId,
          connectionId,
          acknowledgeBound,
          now: now(),
          verifyStepUp: (auth, tx) =>
            reauth.verifyDriveConnectionDisconnect({
              userId,
              connectionId,
              // Fail closed if a direct caller bypassed the route contract.
              body: stepUp ?? {},
              ip,
              auth,
              db: tx,
            }),
        });
      } catch (error) {
        // The audit row is written only after the transaction has rolled back,
        // so a failed credential never rides a committed write.
        await reauth.recordDriveConnectionDisconnectFailure(error);
        throw error;
      }
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

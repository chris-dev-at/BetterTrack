import { unlink } from 'node:fs/promises';

import {
  paranoidDisableRequestSchema,
  paranoidEnableRequestSchema,
  PARANOID_TRANSITION_ERROR_CODES,
  type ParanoidDisableRequest,
  type ParanoidDisableResponse,
  type ParanoidEnableRequest,
  type ParanoidEnableResponse,
  type ParanoidRehydrationPostCommitPlan,
} from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import {
  createParanoidTransitionTransactionRepository,
  getParanoidAdminMetadata,
  serverVaultMatches,
  withParanoidTransitionTransaction,
  type ParanoidAdminMetadata,
} from '../../data/repositories/paranoidTransitionRepository';
import type { AuditService } from '../audit/auditService';
import { AuditAction } from '../audit/auditService';
import {
  ParanoidRehydrationError,
  type ParanoidRehydrationService,
} from './paranoidRehydrationService';

export type ParanoidEnableStage = 'locked' | 'sharingRevoked' | 'vaultPurged' | 'modeEnabled';

export class ParanoidTransitionError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'ALREADY_ENABLED'
      | 'NOT_ENABLED'
      | 'MEDIA_NOT_READY'
      | 'MIRRORCHAIN_ACTIVE'
      | 'IMPORT_IN_FLIGHT'
      | 'EXPORT_IN_FLIGHT'
      | 'TRANSITION_CONFLICT'
      | 'INVALID_REHYDRATION',
    message: string,
  ) {
    super(message);
    this.name = 'ParanoidTransitionError';
  }
}

export interface ParanoidTransitionServiceDeps {
  db: Database;
  rehydration: ParanoidRehydrationService;
  audit: AuditService;
  now?: () => Date;
  /** Post-commit invalidation/rebuild seam. It must never be invoked inside either transaction. */
  runPostCommit?: (userId: string, plan: ParanoidRehydrationPostCommitPlan) => void | Promise<void>;
  /** Test-only failure injection proving enable's database transaction rolls back. */
  afterEnableStage?: (stage: ParanoidEnableStage) => void | Promise<void>;
  /** Test seam for the synchronous pre-enable retirement of cleartext export ZIPs. */
  retireExportFile?: (filePath: string) => Promise<void>;
}

export interface ParanoidTransitionService {
  enable(userId: string, request: ParanoidEnableRequest): Promise<ParanoidEnableResponse>;
  disable(userId: string, request: ParanoidDisableRequest): Promise<ParanoidDisableResponse>;
  /** Non-sensitive admin-only mode/media/blob metadata; never returns blob bytes. */
  adminMetadata(userId: string): Promise<ParanoidAdminMetadata | null>;
}

function sameMedia(left: readonly string[] | null, right: readonly string[]): boolean {
  return (
    left !== null &&
    left.length === right.length &&
    [...left].sort().every((medium, index) => medium === [...right].sort()[index])
  );
}

function mapRehydrationError(error: unknown): never {
  if (!(error instanceof ParanoidRehydrationError)) throw error;
  switch (error.code) {
    case 'ACCOUNT_NOT_FOUND':
      throw new ParanoidTransitionError('ACCOUNT_NOT_FOUND', error.message);
    case 'NOT_PARANOID':
      throw new ParanoidTransitionError('NOT_ENABLED', error.message);
    case 'REHYDRATION_CONFLICT':
      throw new ParanoidTransitionError('TRANSITION_CONFLICT', error.message);
    case 'INVALID_REFERENCE':
    case 'INVALID_CASH_LEDGER':
      throw new ParanoidTransitionError('INVALID_REHYDRATION', error.message);
    case 'INJECTED_FAILURE':
      throw error;
  }
}

export const PARANOID_TRANSITION_HTTP_ERRORS = {
  ACCOUNT_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  ALREADY_ENABLED: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.alreadyEnabled },
  NOT_ENABLED: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.notEnabled },
  MEDIA_NOT_READY: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.mediaNotReady },
  MIRRORCHAIN_ACTIVE: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.mirrorchainActive },
  IMPORT_IN_FLIGHT: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.importInFlight },
  EXPORT_IN_FLIGHT: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.exportInFlight },
  TRANSITION_CONFLICT: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.transitionConflict },
  INVALID_REHYDRATION: {
    status: 400,
    code: PARANOID_TRANSITION_ERROR_CODES.invalidRehydration,
  },
} as const;

export function createParanoidTransitionService(
  deps: ParanoidTransitionServiceDeps,
): ParanoidTransitionService {
  const now = deps.now ?? (() => new Date());
  const stage = async (value: ParanoidEnableStage) => deps.afterEnableStage?.(value);
  const retireExportFile =
    deps.retireExportFile ??
    (async (filePath: string) => {
      try {
        await unlink(filePath);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          return;
        }
        throw error;
      }
    });

  return {
    adminMetadata: (userId) => getParanoidAdminMetadata(deps.db, userId),

    async enable(userId, request) {
      const parsed = paranoidEnableRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new ParanoidTransitionError(
          'MEDIA_NOT_READY',
          'Paranoid media evidence is malformed.',
        );
      }
      const input = parsed.data;
      const completedAt = now();

      const result = await withParanoidTransitionTransaction(deps.db, async (tx) => {
        const transition = createParanoidTransitionTransactionRepository(tx);
        const state = await transition.lockState(userId);
        if (!state) {
          throw new ParanoidTransitionError('ACCOUNT_NOT_FOUND', 'Account does not exist.');
        }
        await stage('locked');

        if (state.privacyMode === 'paranoid') {
          const matchingDrive =
            !input.mediaSet.includes('drive') ||
            state.driveAttestedVersion === input.driveAttestation?.vaultVersion;
          const matchingServer =
            !input.mediaSet.includes('server') || serverVaultMatches(state, input.vaultVersion);
          if (sameMedia(state.mediaSet, input.mediaSet) && matchingDrive && matchingServer) {
            return {
              mode: 'paranoid' as const,
              mediaSet: input.mediaSet,
              vaultVersion: input.vaultVersion,
              completedAt: completedAt.toISOString(),
              idempotent: true,
            };
          }
          throw new ParanoidTransitionError(
            'TRANSITION_CONFLICT',
            'The account is already paranoid with different media evidence.',
          );
        }

        // Preconditions are checked under the account lock and before the first
        // destructive statement.
        if (state.activeMirrorchain) {
          throw new ParanoidTransitionError(
            'MIRRORCHAIN_ACTIVE',
            'Leave every active Mirrorchain with a fork before enabling paranoid mode.',
          );
        }
        if (state.pendingImport) {
          throw new ParanoidTransitionError(
            'IMPORT_IN_FLIGHT',
            'Finish or discard the pending import before enabling paranoid mode.',
          );
        }
        if (state.pendingExport) {
          throw new ParanoidTransitionError(
            'EXPORT_IN_FLIGHT',
            'Wait for the account export to finish before enabling paranoid mode.',
          );
        }
        if (input.mediaSet.includes('server') && !serverVaultMatches(state, input.vaultVersion)) {
          throw new ParanoidTransitionError(
            'MEDIA_NOT_READY',
            'The server vault does not contain the attested version.',
          );
        }

        // A completed normal-account export is a cleartext ZIP outside the
        // database. Unlink it while the account lock is held, then invalidate
        // its token rows in this same transaction. The mode flip cannot commit
        // with a downloadable or on-disk predecessor artifact.
        try {
          for (const artifact of state.cleartextExports) {
            await retireExportFile(artifact.filePath);
          }
        } catch {
          throw new ParanoidTransitionError(
            'TRANSITION_CONFLICT',
            'An existing account export could not be retired safely.',
          );
        }
        await transition.retireCleartextExports(
          userId,
          state.cleartextExports.map((artifact) => artifact.id),
        );

        await transition.revokeSharing(userId);
        await stage('sharingRevoked');
        await transition.purgeVaultRows(userId);
        await stage('vaultPurged');
        await transition.completeEnable({
          userId,
          mediaSet: input.mediaSet,
          driveAttestedVersion: input.driveAttestation?.vaultVersion ?? null,
          keepServerCiphertext: input.mediaSet.includes('server'),
          completedAt,
        });
        await stage('modeEnabled');

        return {
          mode: 'paranoid' as const,
          mediaSet: input.mediaSet,
          vaultVersion: input.vaultVersion,
          completedAt: completedAt.toISOString(),
          idempotent: false,
        };
      });

      await deps.audit.record({
        actorId: userId,
        action: AuditAction.ParanoidEnabled,
        targetType: 'user',
        targetId: userId,
        meta: {
          mediaSet: result.mediaSet,
          vaultVersion: result.vaultVersion,
          idempotent: result.idempotent,
        },
      });
      return result;
    },

    async disable(userId, request) {
      const parsed = paranoidDisableRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new ParanoidTransitionError(
          'INVALID_REHYDRATION',
          'The paranoid rehydration request is malformed.',
        );
      }
      const { confirm: _confirm, ...rehydration } = parsed.data;
      let restored;
      try {
        restored = await deps.rehydration.rehydrate(userId, rehydration);
      } catch (error) {
        mapRehydrationError(error);
      }

      // The rehydration service returns only after its account-locked transaction
      // committed. Derived invalidations therefore cannot leak/replay inside it.
      await deps.runPostCommit?.(userId, restored.postCommit);
      const result: ParanoidDisableResponse = { ...restored, mode: 'normal' };
      await deps.audit.record({
        actorId: userId,
        action: AuditAction.ParanoidDisabled,
        targetType: 'user',
        targetId: userId,
        meta: {
          rehydrationId: result.rehydrationId,
          idempotent: result.idempotent,
        },
      });
      return result;
    },
  };
}

import { lstat, rename, rm } from 'node:fs/promises';

import {
  paranoidDisableRequestSchema,
  paranoidEnableRequestSchema,
  paranoidForkProvenanceResponseSchema,
  paranoidNormalRevisionResponseSchema,
  PARANOID_TRANSITION_ERROR_CODES,
  VAULT_SERVER_CANDIDATE_TTL_MS,
  type ParanoidDisableRequest,
  type ParanoidDisableResponse,
  type ParanoidEnableRequest,
  type ParanoidEnableResponse,
  type ParanoidForkProvenanceResponse,
  type ParanoidNormalRevisionResponse,
  type ParanoidRehydrationPostCommitPlan,
} from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import { createParanoidForkProvenanceRepository } from '../../data/repositories/paranoidRehydrationRepository';
import {
  createParanoidVaultRepository,
  PARANOID_ENABLE_LEGACY_REVISION,
  type ParanoidVaultRepository,
} from '../../data/repositories/paranoidVaultRepository';
import {
  computeNormalDataRevision,
  createParanoidTransitionTransactionRepository,
  finalizeRetiredCleartextExports,
  getParanoidAdminMetadata,
  serverVaultMatches,
  withParanoidTransitionTransaction,
  type ParanoidAdminMetadata,
} from '../../data/repositories/paranoidTransitionRepository';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';
import type { ParanoidDiscardReauth } from './paranoidDiscardReauth';
import {
  ParanoidRehydrationError,
  type ParanoidRehydrationService,
} from './paranoidRehydrationService';

export type ParanoidEnableStage = 'locked' | 'sharingRevoked' | 'vaultPurged' | 'modeEnabled';

/**
 * The closing capture revision refreshes this window immediately before local
 * validation/encryption. Reuse the shipped verified-candidate lifetime so both
 * kinds of unpromoted server ciphertext share one abandonment horizon.
 */
export const PARANOID_ENABLE_STAGING_TTL_MS = VAULT_SERVER_CANDIDATE_TTL_MS;

export class ParanoidTransitionError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'NOT_ENABLED'
      | 'MEDIA_NOT_READY'
      | 'MIRRORCHAIN_ACTIVE'
      | 'IMPORT_IN_FLIGHT'
      | 'EXPORT_IN_FLIGHT'
      | 'TRANSITION_CONFLICT'
      | 'NORMAL_DATA_CHANGED'
      | 'INVALID_REHYDRATION',
    message: string,
  ) {
    super(message);
    this.name = 'ParanoidTransitionError';
  }
}

export interface ParanoidTransitionServiceDeps {
  db: Database;
  /** Shared durable owner-enable window used by normal-revision and vault I/O. */
  vaults?: Pick<ParanoidVaultRepository, 'beginEnableStaging' | 'expireEnableStaging'>;
  /**
   * Dedicated privacy-lock pool handle. Admin metadata reads take their lock
   * here and query on `db`, so an open lock transaction never waits on a
   * connection its own callback needs. Defaults to `db` for the single-pool
   * test harness.
   */
  lockDb?: Database;
  rehydration: ParanoidRehydrationService;
  /**
   * Gate for the irreversible `discard` disable. Required, not optional: a
   * composition that omits it must fail to typecheck rather than silently ship
   * an unauthenticated vault-destruction endpoint.
   */
  discardReauth: ParanoidDiscardReauth;
  audit: AuditService;
  /** Optional so unit harnesses can compose the service without a log sink. */
  logger?: Logger;
  now?: () => Date;
  /** Deterministic invalidation/rebuild seam, invoked only after disable commits. */
  runPostCommit?: (userId: string, plan: ParanoidRehydrationPostCommitPlan) => void | Promise<void>;
  /** Test-only failure injection proving enable's database transaction rolls back. */
  afterEnableStage?: (stage: ParanoidEnableStage) => void | Promise<void>;
  /** Test-only seam for an outcome-ambiguous transaction commit failure. */
  withTransitionTransaction?: <T>(
    db: Database,
    userId: string,
    run: (tx: Database) => Promise<T>,
  ) => Promise<T>;
  /** Test seam for reversible pre-commit retirement of cleartext export ZIPs. */
  prepareExportFile?: (artifact: CleartextExportArtifact) => Promise<PreparedExportFileRetirement>;
  /**
   * Purge user-derived non-database state while the exclusive transition lock is
   * still held. It is safe to repeat and deliberately runs before commit.
   */
  beforeEnableCommit?: (
    userId: string,
    plan: { customAssetIds: readonly string[] },
  ) => void | Promise<void>;
}

export interface CleartextExportArtifact {
  id: string;
  filePath: string;
}

export interface PreparedExportFileRetirement {
  rollback(): Promise<void>;
  commit(): Promise<void>;
}

export interface ParanoidTransitionService {
  enable(userId: string, request: ParanoidEnableRequest): Promise<ParanoidEnableResponse>;
  /**
   * `options.ip` is audit/throttle context for the `discard` re-auth only; the
   * restoring disable ignores it.
   */
  disable(
    userId: string,
    request: ParanoidDisableRequest,
    options?: { ip?: string | null },
  ): Promise<ParanoidDisableResponse>;
  /**
   * The enable wizard's §7.1 capture read: the caller's own severed-fork identity
   * map, while `mirror_rows` still exists. Read-only and lock-free — it takes no
   * transition lock precisely so it can run before the wizard commits to enabling.
   */
  forkProvenance(userId: string): Promise<ParanoidForkProvenanceResponse>;
  /**
   * The capture↔commit CAS token, read BEFORE the wizard's first row read and
   * handed back to {@link ParanoidTransitionService.enable}. The expensive
   * revision derivation stays lock-free; a short account lock then opens or
   * refreshes the owner-only ciphertext-staging window for this capture.
   */
  normalDataRevision(userId: string): Promise<ParanoidNormalRevisionResponse>;
  /** Non-sensitive admin-only mode/media/blob metadata; never returns blob bytes. */
  adminMetadata(userId: string): Promise<ParanoidAdminMetadata | null>;
  /**
   * The same metadata for a whole page of accounts in bounded locked batches.
   * List callers MUST use this instead of fanning {@link adminMetadata} per row.
   */
  adminMetadataMany(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, ParanoidAdminMetadata>>;
}

function sameMedia(left: readonly string[] | null, right: readonly string[]): boolean {
  if (left === null || left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((medium, index) => medium === sortedRight[index]);
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
  NOT_ENABLED: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.notEnabled },
  MEDIA_NOT_READY: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.mediaNotReady },
  MIRRORCHAIN_ACTIVE: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.mirrorchainActive },
  IMPORT_IN_FLIGHT: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.importInFlight },
  EXPORT_IN_FLIGHT: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.exportInFlight },
  TRANSITION_CONFLICT: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.transitionConflict },
  NORMAL_DATA_CHANGED: { status: 409, code: PARANOID_TRANSITION_ERROR_CODES.normalDataChanged },
  INVALID_REHYDRATION: {
    status: 400,
    code: PARANOID_TRANSITION_ERROR_CODES.invalidRehydration,
  },
} as const;

export function createParanoidTransitionService(
  deps: ParanoidTransitionServiceDeps,
): ParanoidTransitionService {
  const now = deps.now ?? (() => new Date());
  const vaults = deps.vaults ?? createParanoidVaultRepository(deps.db);
  const lockDb = deps.lockDb ?? deps.db;
  const stage = async (value: ParanoidEnableStage) => deps.afterEnableStage?.(value);
  const withTransitionTransaction =
    deps.withTransitionTransaction ?? withParanoidTransitionTransaction;
  const prepareExportFile =
    deps.prepareExportFile ??
    (async (artifact: CleartextExportArtifact) => {
      const stagedPath = `${artifact.filePath}.paranoid-retiring-${artifact.id}`;
      const exists = async (path: string): Promise<boolean> => {
        try {
          await lstat(path);
          return true;
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            (error as NodeJS.ErrnoException).code === 'ENOENT'
          ) {
            return false;
          }
          throw error;
        }
      };
      const [sourceExists, stagedExists] = await Promise.all([
        exists(artifact.filePath),
        exists(stagedPath),
      ]);
      if (sourceExists && stagedExists) {
        throw new Error('Both the export archive and its retirement stage exist.');
      }
      if (sourceExists) await rename(artifact.filePath, stagedPath);
      return {
        rollback: async () => {
          if (!(await exists(stagedPath))) return;
          if (await exists(artifact.filePath)) {
            throw new Error('The original export path was recreated during retirement.');
          }
          await rename(stagedPath, artifact.filePath);
        },
        commit: () => rm(stagedPath, { force: true }),
      };
    });

  return {
    adminMetadataMany: (userIds) => getParanoidAdminMetadata(deps.db, lockDb, userIds),

    async adminMetadata(userId) {
      const metadata = await getParanoidAdminMetadata(deps.db, lockDb, [userId]);
      return metadata.get(userId) ?? null;
    },

    async forkProvenance(userId) {
      const provenance = await createParanoidForkProvenanceRepository(
        deps.db,
      ).listRetainedForkProvenance(userId);
      return paranoidForkProvenanceResponseSchema.parse({ provenance });
    },

    async normalDataRevision(userId) {
      /*
       * Derived under one snapshot, so the capture side and the enable side are
       * symmetric. The enable-side derivation runs inside the destructive
       * transaction, behind the account row's FOR UPDATE lock — nothing it hashes
       * can move between its ~20 per-table aggregates. This derivation takes no
       * lock by design (it runs long before the account commits to anything), so
       * a concurrent write could otherwise tear the token across tables: counted
       * in one, missing from the next. REPEATABLE READ pins one snapshot for all
       * of them at a cost that is irrelevant on a once-per-transition read.
       *
       * A torn token could only ever have produced a spurious refusal, never a
       * purge — but a spurious refusal on THIS flow costs the user the whole
       * capture/encrypt/write/verify pass, so it is worth not manufacturing.
       */
      const revision = await deps.db.transaction(
        (tx) => computeNormalDataRevision(tx as unknown as Database, userId),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      const stagedAt = now();
      await vaults.beginEnableStaging({
        userId,
        normalDataRevision: revision,
        now: stagedAt,
        expiresAt: new Date(stagedAt.getTime() + PARANOID_ENABLE_STAGING_TTL_MS),
      });
      return paranoidNormalRevisionResponseSchema.parse({ revision });
    },

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
      // Cleanup commits independently before the destructive transition. If an
      // abandoned window expired, throwing from the enable transaction must not
      // roll its ciphertext deletion back.
      await vaults.expireEnableStaging(userId, completedAt);
      const preparedRetirements: PreparedExportFileRetirement[] = [];
      let retirementArtifacts: CleartextExportArtifact[] = [];
      let restoreRetirementsOnFailure = true;

      const rollbackRetirements = async (): Promise<void> => {
        let rollbackError: unknown;
        for (const retirement of [...preparedRetirements].reverse()) {
          try {
            await retirement.rollback();
          } catch (error) {
            rollbackError ??= error;
          }
        }
        preparedRetirements.length = 0;
        if (rollbackError) throw rollbackError;
      };

      const prepareRetirements = async (
        artifacts: readonly CleartextExportArtifact[],
      ): Promise<void> => {
        for (const artifact of artifacts) {
          preparedRetirements.push(await prepareExportFile(artifact));
        }
      };

      const permanentlyRetirePrepared = async (): Promise<void> => {
        // Once unlink starts, never restore an archive: either filesystem or
        // PostgreSQL can report an outcome-ambiguous failure. The deterministic
        // staging name and retained DB pointer make the next enable retry safe.
        restoreRetirementsOnFailure = false;
        let retirementError: unknown;
        for (const retirement of preparedRetirements) {
          try {
            await retirement.commit();
          } catch (error) {
            retirementError ??= error;
          }
        }
        if (retirementError) {
          throw new ParanoidTransitionError(
            'TRANSITION_CONFLICT',
            'An existing account export could not be retired safely.',
          );
        }
        preparedRetirements.length = 0;
      };

      const purgeDerivedState = async (customAssetIds: readonly string[]): Promise<void> => {
        try {
          await deps.beforeEnableCommit?.(userId, { customAssetIds });
        } catch (error) {
          // Stay fail-closed (the caller sees a 409 and the transaction rolls
          // back) but keep the cause: a Redis or gateway fault here is
          // otherwise a 409 with no trace in the logs or the Problems page.
          deps.logger?.error(
            { err: error, userId },
            'paranoid enable could not retire user-derived server state',
          );
          throw new ParanoidTransitionError(
            'TRANSITION_CONFLICT',
            'User-derived server state could not be retired safely.',
          );
        }
      };

      let result: ParanoidEnableResponse;
      try {
        result = await withTransitionTransaction(deps.db, userId, async (tx) => {
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
            const matchingServer = input.mediaSet.includes('server')
              ? serverVaultMatches(state, input.vaultVersion)
              : state.currentServerVault === null && state.serverVaultHistoryCount === 0;
            if (sameMedia(state.mediaSet, input.mediaSet) && matchingDrive && matchingServer) {
              // No capture CAS on this branch, deliberately. The account is
              // ALREADY paranoid: its vault rows are gone, so the token the
              // original capture carried can never match again and there is
              // nothing left for a stale one to destroy. Checking it here would
              // turn every idempotent retry — the whole point of this branch —
              // into a permanent 409.
              //
              // Finish any prior fail-closed export cleanup before acknowledging
              // an idempotent retry.
              restoreRetirementsOnFailure = false;
              retirementArtifacts = state.cleartextExports;
              try {
                await prepareRetirements(retirementArtifacts);
              } catch {
                throw new ParanoidTransitionError(
                  'TRANSITION_CONFLICT',
                  'A retired account export still needs cleanup.',
                );
              }
              await transition.revokeSharing(userId);
              await transition.purgeVaultRows(userId);
              await purgeDerivedState(state.customAssetIds);
              await transition.completeEnable({
                userId,
                mediaSet: input.mediaSet,
                driveAttestedVersion: input.driveAttestation?.vaultVersion ?? null,
                keepServerCiphertext: input.mediaSet.includes('server'),
                // A retry never re-clears the staged candidate or the retired
                // server recovery set. An established Drive-only account that
                // retired the server medium through PD3a satisfies every guard
                // above (its vault/history rows are empty precisely BECAUSE the
                // ciphertext moved into `paranoid_vault_retired`), so a replay
                // of the original enable would otherwise destroy the retirement
                // proof and the last readable copy — bypassing the signed purge
                // gate and its retention window while answering "nothing
                // changed".
                freshTransition: false,
                completedAt,
              });
              await permanentlyRetirePrepared();
              await finalizeRetiredCleartextExports(
                tx,
                userId,
                retirementArtifacts.map((artifact) => artifact.id),
              );
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

          const stagingCheckedAt = now();
          if (
            state.enableStaging === null ||
            state.enableStaging.expiresAt.getTime() <= stagingCheckedAt.getTime() ||
            (state.enableStaging.normalDataRevision !== input.normalDataRevision &&
              state.enableStaging.normalDataRevision !== PARANOID_ENABLE_LEGACY_REVISION)
          ) {
            throw new ParanoidTransitionError(
              'MEDIA_NOT_READY',
              'The paranoid-enable staging window is absent, expired, or belongs to another capture.',
            );
          }

          // Every precondition is checked under the account lock and before the
          // first destructive statement.
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

          /*
           * The capture↔commit CAS. `lockState` holds the account row FOR
           * UPDATE, so from here to commit no guarded normal-mode write can land
           * (`withLockedPrivacyModes` takes KEY SHARE on the same row). Re-derive
           * the revision INSIDE that window and compare it with the one the
           * client's capture started from: everything it read is provably
           * unchanged, or the transition is refused with nothing destroyed.
           *
           * Without this the wizard's read → encrypt → write → verify window —
           * seconds to minutes, all of it lock-free — silently swallows any
           * concurrent write: a second session's transaction, or the daily
           * standing-order worker booking a period. Those rows are absent from
           * the encrypted document and hard-deleted below, and disable restores
           * from the document ALONE. A refused enable costs a retry; the
           * alternative costs money rows with no surviving copy.
           */
          const observedRevision = await computeNormalDataRevision(tx, userId);
          if (observedRevision !== input.normalDataRevision) {
            throw new ParanoidTransitionError(
              'NORMAL_DATA_CHANGED',
              'The account changed after the encrypted copy was prepared; nothing was deleted.',
            );
          }

          retirementArtifacts = state.cleartextExports;
          try {
            await prepareRetirements(retirementArtifacts);
          } catch {
            await rollbackRetirements();
            throw new ParanoidTransitionError(
              'TRANSITION_CONFLICT',
              'An existing account export could not be retired safely.',
            );
          }

          try {
            await transition.retireCleartextExports(
              userId,
              retirementArtifacts.map((artifact) => artifact.id),
            );
            await transition.revokeSharing(userId);
            await stage('sharingRevoked');
            await transition.purgeVaultRows(userId);
            await stage('vaultPurged');
            await purgeDerivedState(state.customAssetIds);
            await transition.completeEnable({
              userId,
              mediaSet: input.mediaSet,
              driveAttestedVersion: input.driveAttestation?.vaultVersion ?? null,
              keepServerCiphertext: input.mediaSet.includes('server'),
              freshTransition: true,
              completedAt,
            });
            await stage('modeEnabled');

            // The mode update is still uncommitted. Remove staged cleartext first,
            // then clear its durable pointer in this same transaction.
            await permanentlyRetirePrepared();
            await finalizeRetiredCleartextExports(
              tx,
              userId,
              retirementArtifacts.map((artifact) => artifact.id),
            );

            return {
              mode: 'paranoid' as const,
              mediaSet: input.mediaSet,
              vaultVersion: input.vaultVersion,
              completedAt: completedAt.toISOString(),
              idempotent: false,
            };
          } catch (error) {
            if (restoreRetirementsOnFailure) {
              try {
                await rollbackRetirements();
              } catch {
                throw new ParanoidTransitionError(
                  'TRANSITION_CONFLICT',
                  'A cleartext export could not be restored after the transition failed.',
                );
              }
            }
            throw error;
          }
        });
      } catch (error) {
        if (restoreRetirementsOnFailure && preparedRetirements.length > 0) {
          try {
            await rollbackRetirements();
          } catch {
            throw new ParanoidTransitionError(
              'TRANSITION_CONFLICT',
              'A cleartext export could not be restored after the transition failed.',
            );
          }
        }
        throw error;
      }

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

    async disable(userId, request, options) {
      const parsed = paranoidDisableRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new ParanoidTransitionError(
          'INVALID_REHYDRATION',
          'The paranoid rehydration request is malformed.',
        );
      }
      // Re-auth fields are gate material, never restore material.
      const {
        confirm: _confirm,
        confirmUsername: _confirmUsername,
        password: _password,
        code: _code,
        recoveryCode: _recoveryCode,
        ...rehydration
      } = parsed.data;
      if (rehydration.discard === true) {
        await deps.discardReauth.verify({ userId, body: parsed.data, ip: options?.ip });
      }
      let restored;
      try {
        restored = await deps.rehydration.rehydrate(userId, rehydration);
      } catch (error) {
        mapRehydrationError(error);
      }

      // The rehydration service returns only after its account-locked transaction
      // committed. Derived invalidations therefore cannot run or replay inside it.
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
          ...(rehydration.discard === true ? { discard: true } : {}),
        },
      });
      return result;
    },
  };
}

import {
  PORTFOLIO_VAULT_TRANSITION_ERROR_CODES,
  PORTFOLIO_VAULT_LIFECYCLE_GENERATION_MAX,
  VAULT_SERVER_CANDIDATE_TTL_MS,
  portfolioVaultMoveInRequestSchema,
  portfolioVaultMoveInResponseSchema,
  portfolioVaultLifecycleResponseSchema,
  portfolioVaultMoveOutChallengeRequestSchema,
  portfolioVaultMoveOutRequestSchema,
  portfolioVaultMoveOutResponseSchema,
  portfolioVaultRevisionResponseSchema,
  type PortfolioVaultLifecycleResponse,
  type PortfolioVaultMoveInRequest,
  type PortfolioVaultMoveInResponse,
  type PortfolioVaultMoveOutChallengeRequest,
  type PortfolioVaultMoveOutChallengeResponse,
  type PortfolioVaultMoveOutRequest,
  type PortfolioVaultMoveOutResponse,
  type PortfolioVaultRevisionResponse,
} from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import {
  PortfolioVaultRestoreWriteError,
  restorePortfolioVaultGraph,
  type PortfolioVaultRestoreStage,
} from '../../data/repositories/portfolioVaultRestoreRepository';
import {
  beginPortfolioVaultCapture,
  completePendingPortfolioVaultMoveOut,
  computePortfolioDataRevision,
  countPortfolioImportBatches,
  createPortfolioVaultTransitionTransactionRepository,
  listPendingPortfolioVaultMoveOutFinalizations,
  markPendingPortfolioVaultMoveOutFinalizationAttempt,
  readPendingPortfolioVaultMoveOutFinalization,
  readPortfolioVaultLifecycle,
  withPortfolioVaultTransitionTransaction,
} from '../../data/repositories/portfolioVaultTransitionRepository';
import {
  withExclusiveLockedPrivacyMode,
  type LockedPrivacyMode,
} from '../../data/repositories/paranoidEnforcementRepository';
import { AuditAction, type AuditService } from '../audit/auditService';
import { replayRestoredTaxState } from '../tax/replay';
import type { VaultDeleteReauth } from './paranoidDiscardReauth';
import {
  prepareCleartextExportFileRetirement,
  type CleartextExportArtifact,
  type PreparedExportFileRetirement,
} from './paranoidTransitionService';
import {
  ParanoidForkProvenanceError,
  ParanoidRehydrationError,
  validateParanoidRestoreDocument,
} from './paranoidRehydrationService';
import {
  issuePortfolioVaultMoveOutChallenge,
  portfolioVaultRestoreDocumentDigest,
  verifyPortfolioVaultMoveOutChallenge,
  verifyPortfolioVaultMoveOutPhraseProof,
} from './portfolioVaultPhraseProof';

export { portfolioVaultRestoreDocumentDigest } from './portfolioVaultPhraseProof';

/** A revision read opens this bounded window for staging prospective ciphertext. */
export const PORTFOLIO_VAULT_CAPTURE_TTL_MS = VAULT_SERVER_CANDIDATE_TTL_MS;

export type PortfolioVaultMoveInStage = 'verified' | 'purged' | 'receipt';
export type PortfolioVaultMoveOutStage =
  | PortfolioVaultRestoreStage
  | 'documentArchived'
  | 'receipt';

export type PortfolioVaultTransitionFailure =
  | 'NOT_FOUND'
  | 'ALREADY_VAULTED'
  | 'NOT_VAULTED'
  | 'MEDIA_NOT_VERIFIED'
  | 'ACTIVE_MIRRORCHAIN'
  | 'PENDING_IMPORT'
  | 'PENDING_EXPORT'
  | 'CAPTURE_EXPIRED'
  | 'REVISION_STALE'
  | 'DOCUMENT_MISSING'
  | 'DOCUMENT_VERSION_MISMATCH'
  | 'DOCUMENT_SET_STALE'
  | 'TRANSITION_CONFLICT'
  | 'RESTORE_INVALID'
  | 'RESTORE_SOLVENCY'
  | 'RESTORE_PROVENANCE'
  | 'POSSESSION_PROOF_INVALID';

export class PortfolioVaultTransitionError extends Error {
  constructor(
    readonly code: PortfolioVaultTransitionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'PortfolioVaultTransitionError';
  }
}

export const PORTFOLIO_VAULT_TRANSITION_HTTP_ERRORS = {
  NOT_FOUND: { status: 404, code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.notFound },
  ALREADY_VAULTED: {
    status: 409,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.alreadyVaulted,
  },
  NOT_VAULTED: { status: 409, code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.notVaulted },
  MEDIA_NOT_VERIFIED: {
    status: 409,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.mediaNotVerified,
  },
  ACTIVE_MIRRORCHAIN: {
    status: 409,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.activeMirrorchain,
  },
  PENDING_IMPORT: {
    status: 409,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.pendingImport,
  },
  PENDING_EXPORT: {
    status: 409,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.pendingExport,
  },
  CAPTURE_EXPIRED: {
    status: 409,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.captureExpired,
  },
  REVISION_STALE: {
    status: 412,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.revisionStale,
  },
  DOCUMENT_MISSING: {
    status: 409,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.documentMissing,
  },
  DOCUMENT_VERSION_MISMATCH: {
    status: 412,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.documentVersionMismatch,
  },
  DOCUMENT_SET_STALE: {
    status: 412,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.documentSetStale,
  },
  TRANSITION_CONFLICT: {
    status: 409,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.transitionConflict,
  },
  RESTORE_INVALID: {
    status: 400,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.restoreInvalid,
  },
  RESTORE_SOLVENCY: {
    status: 400,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.restoreSolvency,
  },
  RESTORE_PROVENANCE: {
    status: 400,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.restoreProvenance,
  },
  POSSESSION_PROOF_INVALID: {
    status: 412,
    code: PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.possessionProofInvalid,
  },
} as const satisfies Record<PortfolioVaultTransitionFailure, { status: number; code: string }>;

export interface PortfolioVaultTransitionServiceDeps {
  db: Database;
  reauth: VaultDeleteReauth;
  audit: AuditService;
  history: { maxVersions: number; maxAgeMs: number };
  /** HMAC key for short-lived graph-bound move-out challenges. */
  proofSecret: string;
  /** Historical FX conversion used by the ordinary tax-state replay seam. */
  toCashEur: (amount: number, currency: string, day: string) => Promise<number>;
  now?: () => Date;
  /**
   * Retire target-derived process/Redis state while the exclusive account lock
   * is held and before the first database delete. The operation is repeatable:
   * a later transaction refusal may leave only rebuildable caches invalidated.
   */
  beforeMoveInCommit?: (
    userId: string,
    portfolioId: string,
    plan: { customAssetIds: readonly string[] },
  ) =>
    | void
    | PreparedPortfolioDerivedStateRetirement
    | Promise<void | PreparedPortfolioDerivedStateRetirement>;
  /** Test seam for v1's reversible, deterministic cleartext-export retirement. */
  prepareExportFile?: (artifact: CleartextExportArtifact) => Promise<PreparedExportFileRetirement>;
  /** Repeatable cache/provider/snapshot convergence recorded by the durable retry marker. */
  runPostCommit: (
    userId: string,
    portfolioId: string,
    plan: PortfolioVaultMoveOutPostCommitPlan,
  ) => void | Promise<void>;
  /** Repeatable budget/event convergence before the durable retry marker clears. */
  runAfterMoveOutUnlock: (
    userId: string,
    portfolioId: string,
    plan: PortfolioVaultMoveOutPostCommitPlan,
  ) => void | Promise<void>;
  /** Dedicated account-row lock held through durable move-out convergence. */
  withFinalizationLock?: <T>(
    userId: string,
    run: (privacyMode: LockedPrivacyMode) => Promise<T>,
  ) => Promise<T>;
  /** Test-only rollback seam for every destructive move-in stage. */
  afterMoveInStage?: (stage: PortfolioVaultMoveInStage) => void | Promise<void>;
  /** Test-only rollback seam for every restorative move-out stage. */
  afterMoveOutStage?: (stage: PortfolioVaultMoveOutStage) => void | Promise<void>;
  withTransitionTransaction?: typeof withPortfolioVaultTransitionTransaction;
}

/**
 * Rollback hook for a durable external fence installed before the destructive
 * database transaction. Implementations must first re-read committed
 * membership and leave the fence in place after an outcome-ambiguous commit.
 */
export interface PreparedPortfolioDerivedStateRetirement {
  rollback(): Promise<void>;
}

export interface PortfolioVaultMoveOutPostCommitPlan {
  /** Exact live owner-manual restatements whose provider/cache identities changed. */
  customAssetIds: readonly string[];
  /** Stable receipt time, reused by an idempotent retry's invalidation event. */
  completedAt: string;
}

export interface PortfolioVaultMoveOutFinalizer {
  finalize(userId: string, portfolioId: string): Promise<boolean>;
  finalizePending(limit?: number): Promise<{ processed: number; failures: readonly string[] }>;
}

export interface PortfolioVaultMoveOutFinalizerDeps {
  db: Database;
  runPostCommit: PortfolioVaultTransitionServiceDeps['runPostCommit'];
  runAfterMoveOutUnlock: PortfolioVaultTransitionServiceDeps['runAfterMoveOutUnlock'];
  withFinalizationLock?: PortfolioVaultTransitionServiceDeps['withFinalizationLock'];
}

export interface PortfolioVaultTransitionService {
  revision(userId: string, portfolioId: string): Promise<PortfolioVaultRevisionResponse>;
  lifecycle(userId: string, portfolioId: string): Promise<PortfolioVaultLifecycleResponse>;
  moveOutChallenge(
    userId: string,
    portfolioId: string,
    request: PortfolioVaultMoveOutChallengeRequest,
  ): Promise<PortfolioVaultMoveOutChallengeResponse>;
  moveIn(
    userId: string,
    portfolioId: string,
    request: PortfolioVaultMoveInRequest,
    options?: { ip?: string | null },
  ): Promise<PortfolioVaultMoveInResponse>;
  moveOut(
    userId: string,
    portfolioId: string,
    request: PortfolioVaultMoveOutRequest,
    options?: { ip?: string | null },
  ): Promise<PortfolioVaultMoveOutResponse>;
}

function fail(code: PortfolioVaultTransitionFailure, message: string): never {
  throw new PortfolioVaultTransitionError(code, message);
}

function mapRestoreValidationError(error: unknown): never {
  if (!(error instanceof ParanoidRehydrationError)) throw error;
  if (error.code === 'INVALID_CASH_LEDGER') {
    fail('RESTORE_SOLVENCY', error.message);
  }
  if (error instanceof ParanoidForkProvenanceError) {
    fail('RESTORE_PROVENANCE', error.message);
  }
  fail('RESTORE_INVALID', error.message);
}

function mapRestoreWriteError(error: unknown): never {
  if (!(error instanceof PortfolioVaultRestoreWriteError)) throw error;
  if (error.code === 'IMPORT_NOT_HISTORICAL') fail('RESTORE_INVALID', error.message);
  fail('TRANSITION_CONFLICT', error.message);
}

/**
 * Complete a prepared move-out under the same exclusive account lock used by
 * privacy transitions. The plan is read from Postgres after the lock is held,
 * is safe to repeat, and remains pending across every externally visible
 * follow-up. Membership was already cleared atomically with the receipt; a
 * crash here leaves the restored portfolio usable and a worker-visible retry
 * marker for derived state that is safe to recompute.
 */
export function createPortfolioVaultMoveOutFinalizer(
  deps: PortfolioVaultMoveOutFinalizerDeps,
): PortfolioVaultMoveOutFinalizer {
  const withLock =
    deps.withFinalizationLock ??
    (<T>(userId: string, run: (privacyMode: LockedPrivacyMode) => Promise<T>) =>
      withExclusiveLockedPrivacyMode(deps.db, userId, run));

  const finalizeOne = (userId: string, portfolioId: string, sweepLifecycleGeneration?: number) =>
    withLock(userId, async (privacyMode) => {
      if (
        sweepLifecycleGeneration !== undefined &&
        !(await markPendingPortfolioVaultMoveOutFinalizationAttempt(deps.db, {
          userId,
          portfolioId,
          lifecycleGeneration: sweepLifecycleGeneration,
        }))
      ) {
        return false;
      }
      if (privacyMode !== 'normal') {
        throw new Error('portfolio vault move-out finalization requires normal account privacy');
      }
      const pending = await readPendingPortfolioVaultMoveOutFinalization(
        deps.db,
        userId,
        portfolioId,
      );
      if (!pending) return false;
      const plan = {
        customAssetIds: pending.customAssetIds,
        completedAt: pending.completedAt.toISOString(),
      } satisfies PortfolioVaultMoveOutPostCommitPlan;
      // Both phases are deliberately repeated from the beginning on every
      // attempt. A prior callback may have completed externally before its
      // process died; each seam is idempotent and the durable marker stays set.
      await deps.runPostCommit(userId, portfolioId, plan);
      await deps.runAfterMoveOutUnlock(userId, portfolioId, plan);
      if (!(await completePendingPortfolioVaultMoveOut(deps.db, pending))) {
        throw new Error('portfolio vault move-out completion lost its durable plan');
      }
      return true;
    });
  const finalize = (userId: string, portfolioId: string) => finalizeOne(userId, portfolioId);

  return {
    finalize,
    async finalizePending(limit = 25) {
      const candidates = await listPendingPortfolioVaultMoveOutFinalizations(
        deps.db,
        Math.max(1, Math.min(100, Math.trunc(limit))),
      );
      let processed = 0;
      const failures: string[] = [];
      for (const candidate of candidates) {
        try {
          if (
            await finalizeOne(
              candidate.userId,
              candidate.portfolioId,
              candidate.lifecycleGeneration,
            )
          ) {
            processed += 1;
          }
        } catch {
          failures.push(`${candidate.userId}/${candidate.portfolioId}`);
        }
      }
      return { processed, failures };
    },
  };
}

export function createPortfolioVaultTransitionService(
  deps: PortfolioVaultTransitionServiceDeps,
): PortfolioVaultTransitionService {
  const clock = deps.now ?? (() => new Date());
  const transact = deps.withTransitionTransaction ?? withPortfolioVaultTransitionTransaction;
  const moveInStage = async (stage: PortfolioVaultMoveInStage) => deps.afterMoveInStage?.(stage);
  const moveOutStage = async (stage: PortfolioVaultMoveOutStage) => deps.afterMoveOutStage?.(stage);
  const prepareExportFile = deps.prepareExportFile ?? prepareCleartextExportFileRetirement;
  const moveOutFinalizer = createPortfolioVaultMoveOutFinalizer({
    db: deps.db,
    runPostCommit: deps.runPostCommit,
    runAfterMoveOutUnlock: deps.runAfterMoveOutUnlock,
    withFinalizationLock: deps.withFinalizationLock,
  });

  return {
    async revision(userId, portfolioId) {
      // One snapshot prevents a cross-table torn digest. Such a tear could not
      // purge data, but it would make the user repeat a costly capture pass.
      // The import-batch count rides the SAME snapshot: it is the client's
      // refuse-before-loss fact for staging rows this build cannot capture.
      const [revision, importBatchCount] = await deps.db.transaction(
        (tx) =>
          Promise.all([
            computePortfolioDataRevision(tx as unknown as Database, userId, portfolioId),
            countPortfolioImportBatches(tx as unknown as Database, portfolioId),
          ]),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      if (revision === null) fail('NOT_FOUND', 'Portfolio not found.');

      const capturedAt = clock();
      const opened = await beginPortfolioVaultCapture({
        db: deps.db,
        userId,
        portfolioId,
        revision,
        now: capturedAt,
        expiresAt: new Date(capturedAt.getTime() + PORTFOLIO_VAULT_CAPTURE_TTL_MS),
      });
      if (opened === 'not_found') fail('NOT_FOUND', 'Portfolio not found.');
      if (opened === 'already_vaulted') {
        fail('ALREADY_VAULTED', 'The portfolio is already stored in a vault.');
      }
      if (opened === 'finalization_pending') {
        fail('TRANSITION_CONFLICT', 'The preceding portfolio move-out is still finalizing.');
      }
      return portfolioVaultRevisionResponseSchema.parse({
        portfolioDataRevision: revision,
        importBatchCount,
      });
    },

    async lifecycle(userId, portfolioId) {
      const read = await deps.db.transaction(
        (tx) => readPortfolioVaultLifecycle(tx as unknown as Database, userId, portfolioId),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      if (read.status === 'not_found') fail('NOT_FOUND', 'Portfolio not found.');
      if (read.status === 'not_vaulted') {
        fail('NOT_VAULTED', 'The portfolio is not stored in a vault.');
      }
      if (read.status === 'inconsistent') {
        fail('TRANSITION_CONFLICT', 'The portfolio vault transition state is inconsistent.');
      }
      return portfolioVaultLifecycleResponseSchema.parse({
        portfolioId,
        vaultId: read.vaultId,
        lifecycleGeneration: read.lifecycleGeneration,
      });
    },

    async moveIn(userId, portfolioId, request, options) {
      const parsed = portfolioVaultMoveInRequestSchema.safeParse(request);
      if (!parsed.success) {
        fail('TRANSITION_CONFLICT', 'The move-in request is malformed.');
      }
      const input = parsed.data;
      const preparedRetirements: PreparedExportFileRetirement[] = [];
      const preparedDerivedStates: PreparedPortfolioDerivedStateRetirement[] = [];
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
      const permanentlyRetirePrepared = async (): Promise<void> => {
        // Once unlink starts, restoring a subset after an outcome-ambiguous DB
        // COMMIT would recreate a cleartext capability. The retained DB pointer
        // makes a later move-in retry converge from either missing or staged bytes.
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
          fail('TRANSITION_CONFLICT', 'An existing account export could not be retired safely.');
        }
        preparedRetirements.length = 0;
      };
      let result: PortfolioVaultMoveInResponse;
      try {
        result = await transact(deps.db, userId, async (tx) => {
          const repository = createPortfolioVaultTransitionTransactionRepository(tx);
          // This FOR UPDATE is the account privacy lock. Every normal guarded
          // action holds FOR KEY SHARE on the same row. The credential is checked
          // while this lock is held, eliminating password/factor change races.
          const owner = await repository.lockOwner(userId);
          if (!owner) fail('NOT_FOUND', 'Portfolio not found.');

          // Lock order is account -> vault -> portfolio -> transition state.
          // Membership changes never happen before the vault row is locked.
          const vault = await repository.lockVault(userId, input.vaultId);
          const portfolio = await repository.lockPortfolio(userId, portfolioId);
          const state = await repository.lockTransitionState(portfolioId);
          if (!portfolio || !vault) fail('NOT_FOUND', 'Portfolio or vault not found.');
          // Expiry and receipt time are sampled only after every transition
          // lock is held. A request queued behind a long transition must not
          // validate an already-expired capture using its pre-wait timestamp.
          const completedAt = clock();

          // Idempotency identity: (portfolioId, lifecycleGeneration, vaultId,
          // docVersion). A retry after an outcome-ambiguous commit observes only
          // the receipt and stub; it never re-enters the purge path or depends
          // on the cleared CAS token.
          if (portfolio.vaultId !== null) {
            if (
              portfolio.vaultId === input.vaultId &&
              state?.moveInVaultId === input.vaultId &&
              state.moveInDocVersion === input.docVersion &&
              state.moveInCompletedAt !== null
            ) {
              return portfolioVaultMoveInResponseSchema.parse({
                portfolioId,
                vaultId: input.vaultId,
                docVersion: input.docVersion,
                lifecycleGeneration: state.lifecycleGeneration,
                idempotent: true,
              });
            }
            fail('ALREADY_VAULTED', 'The portfolio is already stored in a vault.');
          }

          // A matching durable receipt is read-only and must remain replayable
          // after a one-use recovery code was consumed by an outcome-ambiguous
          // successful commit. Every path that can still mutate or purge goes
          // through the same-lock §15 verifier below.
          await deps.reauth.verifyPortfolioVaultTransition({
            userId,
            portfolioId,
            vaultId: input.vaultId,
            kind: 'move-in',
            body: input.stepUp,
            ip: options?.ip,
            auth: owner,
            db: tx,
          });
          if (
            !state ||
            state.captureRevision === null ||
            state.captureExpiresAt === null ||
            state.captureExpiresAt.getTime() <= completedAt.getTime()
          ) {
            fail('CAPTURE_EXPIRED', 'The portfolio capture expired; capture it again.');
          }
          if (state.captureRevision !== input.portfolioDataRevision) {
            fail('REVISION_STALE', 'The portfolio changed after it was captured.');
          }
          if (state.captureVaultId !== input.vaultId) {
            fail(
              'MEDIA_NOT_VERIFIED',
              'The target vault media were not verified for this capture.',
            );
          }

          const blocker = await repository.blocker(userId, portfolioId);
          if (blocker === 'active_mirrorchain') {
            fail(
              'ACTIVE_MIRRORCHAIN',
              'Leave the active mirrorchain before moving this portfolio.',
            );
          }
          if (blocker === 'pending_import') {
            fail('PENDING_IMPORT', 'Wait for the portfolio import to finish.');
          }
          if (blocker === 'pending_export') {
            fail('PENDING_EXPORT', 'Wait for the account export to finish.');
          }

          const currentRevision = await computePortfolioDataRevision(tx, userId, portfolioId);
          if (currentRevision !== input.portfolioDataRevision) {
            fail('REVISION_STALE', 'The portfolio changed after it was captured.');
          }
          const documents = await repository.verifyMoveInDocuments({
            vault,
            portfolioId,
            docVersion: input.docVersion,
            now: completedAt,
            state,
          });
          if (!documents.mediaReady) {
            fail('MEDIA_NOT_VERIFIED', 'The target vault media are not verified and current.');
          }
          if (documents.portfolioVersion === null) {
            fail('DOCUMENT_MISSING', 'The encrypted portfolio document is missing.');
          }
          if (documents.portfolioVersion !== input.docVersion) {
            fail('DOCUMENT_VERSION_MISMATCH', 'The encrypted portfolio document version changed.');
          }
          if (!documents.exactRoster) {
            fail('DOCUMENT_SET_STALE', 'The encrypted vault document set is incomplete or stale.');
          }
          const lifecycleGeneration = state.lifecycleGeneration + 1;
          if (lifecycleGeneration > PORTFOLIO_VAULT_LIFECYCLE_GENERATION_MAX) {
            fail('TRANSITION_CONFLICT', 'The portfolio vault lifecycle is exhausted.');
          }
          await moveInStage('verified');

          const scope = await repository.capturePurgeScope(userId, portfolioId);
          // BetterTrack exports are account-wide ZIPs without portfolio scope.
          // Every owner row with a live file pointer may therefore contain this
          // target. Hide all of them reversibly only after every refusal gate,
          // while the account lock prevents build/download/cleanup races.
          const cleartextExports = await repository.lockCleartextExports(userId);
          try {
            for (const artifact of cleartextExports) {
              preparedRetirements.push(await prepareExportFile(artifact));
            }
          } catch {
            fail('TRANSITION_CONFLICT', 'An existing account export could not be retired safely.');
          }
          await repository.retireCleartextExports(
            userId,
            cleartextExports.map(({ id }) => id),
          );
          try {
            // Carry v1's non-database purge discipline into the per-portfolio
            // transition. This runs before the first cleartext delete, so a
            // gateway/Redis/provider failure can only invalidate rebuildable
            // derived state; it can never strand a partially purged graph.
            const preparedDerivedState = await deps.beforeMoveInCommit?.(userId, portfolioId, {
              customAssetIds: scope.exclusiveCustomAssetIds,
            });
            if (preparedDerivedState) preparedDerivedStates.push(preparedDerivedState);
          } catch {
            fail(
              'TRANSITION_CONFLICT',
              'Portfolio-derived server state could not be retired safely.',
            );
          }

          // This is the first destructive portfolio statement. From here through
          // the receipt there is no provider/cache I/O: purge, frozen-scope probe,
          // membership, attestation, and receipt are one rollback-safe DB commit.
          await repository.purgePortfolio({
            userId,
            portfolioId,
            vaultId: input.vaultId,
            // The vault label is intentional: the true portfolio name exists
            // only inside ciphertext while the row is locked.
            vaultAlias: vault.name,
            scope,
          });
          await moveInStage('purged');
          await repository.completeMoveIn({
            userId,
            portfolioId,
            vaultId: input.vaultId,
            docVersion: input.docVersion,
            lifecycleGeneration,
            retiredCustomAssetIds: scope.exclusiveCustomAssetIds,
            completedAt,
          });
          await deps.audit.recordInTransaction(tx, {
            actorId: userId,
            action: AuditAction.PortfolioVaultMovedIn,
            targetType: 'portfolio',
            targetId: portfolioId,
            ip: options?.ip,
            meta: {
              vaultId: input.vaultId,
              docVersion: input.docVersion,
              lifecycleGeneration,
            },
          });
          await moveInStage('receipt');
          // The DB body is complete. Permanently remove the already-hidden ZIPs,
          // then clear their durable recovery pointers in this same transaction.
          // A local unlink failure rolls the portfolio transaction back; once an
          // unlink begins, bytes stay fail-closed and a deterministic retry cleans
          // up the pointer instead of ever restoring an uncertain archive.
          await permanentlyRetirePrepared();
          await repository.finalizeRetiredCleartextExports(
            userId,
            cleartextExports.map(({ id }) => id),
          );
          return portfolioVaultMoveInResponseSchema.parse({
            portfolioId,
            vaultId: input.vaultId,
            docVersion: input.docVersion,
            lifecycleGeneration,
            idempotent: false,
          });
        });
      } catch (error) {
        let failure = error;
        for (const preparedDerivedState of preparedDerivedStates) {
          try {
            await preparedDerivedState.rollback();
          } catch {
            failure = new PortfolioVaultTransitionError(
              'TRANSITION_CONFLICT',
              'Portfolio-derived server state could not be restored after refusal.',
            );
          }
        }
        if (restoreRetirementsOnFailure) {
          try {
            await rollbackRetirements();
          } catch {
            failure = new PortfolioVaultTransitionError(
              'TRANSITION_CONFLICT',
              'An existing account export could not be restored after refusal.',
            );
          }
        }
        await deps.reauth.recordPortfolioVaultTransitionFailure(failure);
        throw failure;
      }

      return result;
    },

    async moveOutChallenge(userId, portfolioId, request) {
      const parsed = portfolioVaultMoveOutChallengeRequestSchema.safeParse(request);
      if (!parsed.success) fail('RESTORE_INVALID', 'The move-out challenge request is malformed.');
      const input = parsed.data;
      return transact(deps.db, userId, async (tx) => {
        const repository = createPortfolioVaultTransitionTransactionRepository(tx);
        const owner = await repository.lockOwner(userId);
        if (!owner) fail('NOT_FOUND', 'Portfolio not found.');
        const vault = await repository.lockVault(userId, input.vaultId);
        const portfolio = await repository.lockPortfolio(userId, portfolioId);
        const state = await repository.lockTransitionState(portfolioId);
        if (!portfolio) fail('NOT_FOUND', 'Portfolio not found.');
        const challengedAt = clock();

        const exactReceipt =
          state !== null &&
          state.moveOutCompletedAt !== null &&
          state.moveOutVaultId === input.vaultId &&
          state.lifecycleGeneration === input.lifecycleGeneration &&
          state.moveOutDocumentDigest === input.documentDigest &&
          state.moveOutDocumentSetHash === input.documentSetHash &&
          state.moveOutProofPublicKey !== null &&
          portfolio.vaultId === null;
        if (!exactReceipt) {
          if (state !== null && state.moveOutCompletedAt !== null && portfolio.vaultId === null) {
            fail('TRANSITION_CONFLICT', 'A different move-out is already complete.');
          }
          if (!vault || portfolio.vaultId !== input.vaultId) {
            fail('NOT_FOUND', 'Portfolio or vault not found.');
          }
          if (
            state?.moveInVaultId !== input.vaultId ||
            state.moveInCompletedAt === null ||
            state.lifecycleGeneration !== input.lifecycleGeneration
          ) {
            fail(
              'TRANSITION_CONFLICT',
              'The challenge belongs to a different portfolio vault lifecycle.',
            );
          }
          const documents = await repository.verifyMoveOutDocuments({
            vault,
            portfolioId,
            now: challengedAt,
          });
          if (!documents.mediaReady) {
            fail('MEDIA_NOT_VERIFIED', 'The vault media require a fresh full-set attestation.');
          }
          if (!documents.exactRoster || documents.documentSetHash !== input.documentSetHash) {
            fail('DOCUMENT_SET_STALE', 'The encrypted vault document set is incomplete or stale.');
          }
        }
        return issuePortfolioVaultMoveOutChallenge({
          secret: deps.proofSecret,
          userId,
          portfolioId,
          vaultId: input.vaultId,
          lifecycleGeneration: input.lifecycleGeneration,
          documentDigest: input.documentDigest,
          documentSetHash: input.documentSetHash,
          now: challengedAt,
        });
      });
    },

    async moveOut(userId, portfolioId, request, options) {
      const parsed = portfolioVaultMoveOutRequestSchema.safeParse(request);
      if (!parsed.success) fail('RESTORE_INVALID', 'The move-out request is malformed.');
      const input = parsed.data;
      const documentDigest = portfolioVaultRestoreDocumentDigest(input.document);
      let result: PortfolioVaultMoveOutResponse;
      try {
        result = await transact(deps.db, userId, async (tx) => {
          const repository = createPortfolioVaultTransitionTransactionRepository(tx);
          const owner = await repository.lockOwner(userId);
          if (!owner) fail('NOT_FOUND', 'Portfolio not found.');

          const vault = await repository.lockVault(userId, input.vaultId);
          const portfolio = await repository.lockPortfolio(userId, portfolioId);
          const state = await repository.lockTransitionState(portfolioId);
          if (!portfolio) fail('NOT_FOUND', 'Portfolio not found.');
          // Media freshness, tax replay and the durable receipt share one
          // post-lock clock sample; lock contention cannot extend a proof.
          const completedAt = clock();

          // Idempotency key: (portfolioId, lifecycleGeneration,
          // restoreDocumentDigest, encryptedDocumentSetHash). The generation
          // prevents an old, otherwise valid restore from applying after this
          // portfolio has moved into the same vault again; the set hash prevents
          // an older unlocked client from archiving a newer encrypted graph. The
          // original correlation id is returned even if a retry minted a new one.
          if (state && state.moveOutCompletedAt !== null && state.moveOutId !== null) {
            if (
              state.lifecycleGeneration === input.lifecycleGeneration &&
              state.moveOutVaultId === input.vaultId &&
              state.moveOutDocumentDigest === documentDigest &&
              state.moveOutDocumentSetHash === input.documentSetHash
            ) {
              const membershipMatchesPlan = portfolio.vaultId === null;
              if (!membershipMatchesPlan) {
                fail(
                  'TRANSITION_CONFLICT',
                  'The move-out receipt and portfolio membership are inconsistent.',
                );
              }
              if (
                state.moveOutProofPublicKey === null ||
                !verifyPortfolioVaultMoveOutPhraseProof({
                  retirementProofPublicKey: state.moveOutProofPublicKey,
                  portfolioId,
                  vaultId: input.vaultId,
                  lifecycleGeneration: input.lifecycleGeneration,
                  documentSetHash: input.documentSetHash,
                  document: input.document,
                  vaultProof: input.vaultProof,
                })
              ) {
                fail('POSSESSION_PROOF_INVALID', 'The vault phrase-possession proof is invalid.');
              }
              return portfolioVaultMoveOutResponseSchema.parse({
                portfolioId,
                vaultId: input.vaultId,
                moveOutId: state.moveOutId,
                lifecycleGeneration: input.lifecycleGeneration,
                idempotent: true,
              });
            }
            if (portfolio.vaultId === null || state.moveOutPostCommitPending) {
              fail('TRANSITION_CONFLICT', 'A different move-out is already complete.');
            }
          }
          if (portfolio.vaultId === null) {
            fail('NOT_VAULTED', 'The portfolio is not stored in a vault.');
          }
          if (!vault || portfolio.vaultId !== input.vaultId) {
            fail('NOT_FOUND', 'Portfolio or vault not found.');
          }
          if (state?.moveInVaultId !== input.vaultId || state.moveInCompletedAt === null) {
            fail('TRANSITION_CONFLICT', 'The portfolio vault transition state is inconsistent.');
          }
          if (state.lifecycleGeneration !== input.lifecycleGeneration) {
            fail(
              'TRANSITION_CONFLICT',
              'The move-out request belongs to a different portfolio vault lifecycle.',
            );
          }

          const documents = await repository.verifyMoveOutDocuments({
            vault,
            portfolioId,
            now: completedAt,
          });
          if (!documents.mediaReady) {
            fail('MEDIA_NOT_VERIFIED', 'The vault media require a fresh full-set attestation.');
          }
          if (!documents.exactRoster || documents.documentSetHash !== input.documentSetHash) {
            fail('DOCUMENT_SET_STALE', 'The encrypted vault document set is incomplete or stale.');
          }

          if (
            !verifyPortfolioVaultMoveOutChallenge({
              secret: deps.proofSecret,
              challenge: input.vaultProof.challenge,
              userId,
              portfolioId,
              vaultId: input.vaultId,
              lifecycleGeneration: input.lifecycleGeneration,
              documentDigest,
              documentSetHash: input.documentSetHash,
              now: completedAt,
            }) ||
            !verifyPortfolioVaultMoveOutPhraseProof({
              retirementProofPublicKey: vault.retirementProofPublicKey,
              portfolioId,
              vaultId: input.vaultId,
              lifecycleGeneration: input.lifecycleGeneration,
              documentSetHash: input.documentSetHash,
              document: input.document,
              vaultProof: input.vaultProof,
            })
          ) {
            fail('POSSESSION_PROOF_INVALID', 'The vault phrase-possession proof is invalid.');
          }

          // The in-body credential is what replaces CSRF + same-origin for the
          // bearer path. Cookie and bearer callers pass this identical gate.
          // A matching completed receipt returned above is deliberately exempt:
          // it performs no write and remains resumable after a recovery-code gate.
          await deps.reauth.verifyPortfolioVaultTransition({
            userId,
            portfolioId,
            vaultId: input.vaultId,
            kind: 'move-out',
            body: input.stepUp,
            ip: options?.ip,
            auth: owner,
            db: tx,
          });

          let validated;
          try {
            validated = await validateParanoidRestoreDocument({
              db: tx,
              userId,
              portfolioId,
              document: input.document,
            });
          } catch (error) {
            mapRestoreValidationError(error);
          }

          let restoredCustomAssetIds: readonly string[];
          try {
            const restored = await restorePortfolioVaultGraph({
              tx,
              userId,
              portfolioId,
              vaultId: input.vaultId,
              entities: validated.entities,
              afterCashMovements: () =>
                replayRestoredTaxState(tx, {
                  userId,
                  portfolioIds: [portfolioId],
                  now: completedAt,
                  toEur: deps.toCashEur,
                }).then(() => undefined),
              afterStage: moveOutStage,
            });
            restoredCustomAssetIds = restored.restoredCustomAssetIds;
          } catch (error) {
            mapRestoreWriteError(error);
          }
          const archived = await repository.archiveAndRemovePortfolioDocument({
            vaultId: input.vaultId,
            portfolioId,
            now: completedAt,
            historyMaxVersions: deps.history.maxVersions,
            historyMaxAgeMs: deps.history.maxAgeMs,
          });
          if (archived === 'conflict') {
            fail('TRANSITION_CONFLICT', 'The encrypted portfolio document history conflicts.');
          }
          await moveOutStage('documentArchived');
          await repository.completeMoveOut({
            userId,
            portfolioId,
            vaultId: input.vaultId,
            moveOutId: input.moveOutId,
            lifecycleGeneration: input.lifecycleGeneration,
            documentDigest,
            documentSetHash: input.documentSetHash,
            proofPublicKey: vault.retirementProofPublicKey,
            customAssetIds: restoredCustomAssetIds,
            completedAt,
          });
          await deps.audit.recordInTransaction(tx, {
            actorId: userId,
            action: AuditAction.PortfolioVaultMovedOut,
            targetType: 'portfolio',
            targetId: portfolioId,
            ip: options?.ip,
            meta: {
              vaultId: input.vaultId,
              moveOutId: input.moveOutId,
              lifecycleGeneration: input.lifecycleGeneration,
            },
          });
          await moveOutStage('receipt');
          return portfolioVaultMoveOutResponseSchema.parse({
            portfolioId,
            vaultId: input.vaultId,
            moveOutId: input.moveOutId,
            lifecycleGeneration: input.lifecycleGeneration,
            idempotent: false,
          });
        });
      } catch (error) {
        await deps.reauth.recordPortfolioVaultTransitionFailure(error);
        throw error;
      }

      await moveOutFinalizer.finalize(userId, portfolioId);
      return result;
    },
  };
}

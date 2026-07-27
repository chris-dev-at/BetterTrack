import type {
  VaultDocumentV1,
  VaultEntity,
  VaultEntityKind,
  VaultEnvelopeHeader,
} from '@bettertrack/contracts';

import { decryptVaultDocument, encryptVaultDocument, type VaultKeyMaterial } from './crypto';
import type { DataHome, DataHomeReadResult, DataHomeWriteResult } from './dataHome';
import { VaultCryptoError } from './errors';
import type { LocalDataHome } from './localDataHome';
import { mergeVaultDocuments } from './merge';
import type { VaultQuarantineStore } from './quarantine';

const MAX_CAS_RECONCILIATIONS = 16;
const RETRY_LOCAL_OBSERVATION = Symbol('retry-local-observation');

export interface VaultSyncCandidate {
  home: DataHome;
  envelope: Uint8Array;
  header: VaultEnvelopeHeader;
  document: VaultDocumentV1;
}

export type VaultSyncStatus =
  | 'synced'
  | 'pending-offline'
  | 'unresolved'
  | 'conflict'
  | 'corrupt'
  | 'locked'
  | 'empty';

export interface VaultSyncState {
  status: VaultSyncStatus;
  /** A failed pull or validation never clears an already-readable candidate. */
  active: VaultSyncCandidate | null;
  /** The encrypted local candidate not yet acknowledged by the primary. */
  pending: VaultSyncCandidate | null;
  lastFailure?: string;
}

export interface VaultSyncEngineOptions {
  local: LocalDataHome;
  primary: DataHome;
  vaultKey: VaultKeyMaterial;
  deviceId: string;
  writeId: () => string;
  now?: () => string;
  quarantine: VaultQuarantineStore;
  /**
   * Installed at engine construction so no divergent candidate can be
   * encrypted or published before its domain invariants are reconciled.
   */
  documentReconciler: VaultDocumentReconciler;
  /**
   * Domain reconcilers that admit complete atomic operations must fail closed
   * when a restarted engine can no longer recover their per-call boundaries.
   */
  requiresCompleteMutationProvenance: boolean;
}

export interface VaultMutationContext {
  document: VaultDocumentV1;
  currentVersion: number;
}

export interface VaultMutationEntityDelta {
  kind: VaultEntityKind;
  id: string;
  before: VaultEntity | undefined;
  after: VaultEntity | undefined;
}

/**
 * The complete delta produced by one serialized `mutate` call. Keeping every
 * member here, before the generic merge selects entity winners, lets a domain
 * reconciler admit or reject the original operation as one unit.
 */
export interface VaultAtomicMutation {
  sequence: number;
  changes: VaultMutationEntityDelta[];
}

export interface VaultDocumentReconcileContext {
  /** The locally pending/in-memory branch whose changes are being considered. */
  local: VaultDocumentV1;
  /** The already-observed durable branch that forms the reconciliation baseline. */
  remote: VaultDocumentV1;
  /** Complete local mutation deltas, ordered before entity-winner filtering. */
  mutations: readonly VaultAtomicMutation[];
  deviceId: string;
  reconciledAt: string;
}

export interface VaultDocumentReconcileResult {
  document: VaultDocumentV1;
  /** Rebased groups that still separate every pending operation and compensation. */
  mutations: readonly VaultAtomicMutation[];
}

export type VaultDocumentReconciler = (
  document: VaultDocumentV1,
  context: VaultDocumentReconcileContext,
) => VaultDocumentReconcileResult;

export interface VaultSyncEngine {
  readonly deviceId: string;
  readonly state: VaultSyncState;
  start(): Promise<VaultSyncState>;
  reconnect(): Promise<VaultSyncState>;
  mutate(mutator: (context: VaultMutationContext) => VaultDocumentV1): Promise<VaultSyncState>;
}

interface RemoteObservation {
  known: boolean;
  version: number | null;
}

interface CandidateValidationFailure {
  status: 'corrupt' | 'locked';
  message: string;
}

interface ReadableCandidateResult {
  candidate: VaultSyncCandidate | null;
  validationFailure?: CandidateValidationFailure;
}

/**
 * Local-first, encrypted-document synchronization. CAS tokens always come from
 * the caller's previously read candidates; no write helper performs a discovery
 * read to manufacture its own token.
 */
export function createVaultSyncEngine(options: VaultSyncEngineOptions): VaultSyncEngine {
  const now = options.now ?? (() => new Date().toISOString());
  let state: VaultSyncState = { status: 'empty', active: null, pending: null };
  let localHeadVersion: number | null | undefined;
  let remoteObserved: RemoteObservation = { known: false, version: null };
  let operationTail = Promise.resolve();
  let rollbackPersistenceFailure: string | undefined;
  let mutationSequence = 0;
  let pendingMutations: VaultAtomicMutation[] = [];
  let pendingMutationProvenanceAvailable = false;
  const documentReconciler = options.documentReconciler;

  return {
    get deviceId() {
      return options.deviceId;
    },

    get state() {
      return cloneState(state);
    },

    start() {
      return serialize(reconcile);
    },

    reconnect() {
      return serialize(reconcile);
    },

    mutate(mutator) {
      return serialize(() => mutate(mutator));
    },
  };

  async function reconcile(): Promise<VaultSyncState> {
    if (state.status === 'unresolved') return cloneState(state);

    for (let attempt = 0; attempt < MAX_CAS_RECONCILIATIONS; attempt += 1) {
      const result = await reconcileObservation();
      if (result !== RETRY_LOCAL_OBSERVATION) return result;
    }

    await handleLocalConflict(localHeadVersion ?? null);
    state = {
      ...state,
      status: 'conflict',
      lastFailure: 'The local vault changed too often while selecting a readable candidate.',
    };
    return cloneState(state);
  }

  async function reconcileObservation(): Promise<VaultSyncState | typeof RETRY_LOCAL_OBSERVATION> {
    const [localResult, remoteResult] = await Promise.all([
      options.local.read(),
      options.primary.read(),
    ]);
    localHeadVersion = observedVersion(localResult);
    remoteObserved = observeRemote(remoteResult);

    const localCurrentResult = await readableLocalCurrent(localResult);
    if (localCurrentResult === RETRY_LOCAL_OBSERVATION) return RETRY_LOCAL_OBSERVATION;
    const localCurrent = localCurrentResult.candidate;
    const lastKnownGoodResult: ReadableCandidateResult =
      localCurrent == null
        ? await readableCandidate(await options.local.readLastKnownGood())
        : { candidate: null };
    const persistedLocalReadable = localCurrent ?? lastKnownGoodResult.candidate;
    const retained = await retainActiveCandidate(persistedLocalReadable, state.active);
    const localReadable = retained.candidate;
    const remoteCandidateResult = await readableCandidate(remoteResult);
    const remoteReadable = remoteCandidateResult.candidate;
    const localValidationFailures = [
      localCurrentResult.validationFailure,
      lastKnownGoodResult.validationFailure,
    ].filter((failure): failure is CandidateValidationFailure => failure != null);
    const validationFailures = [
      ...localValidationFailures,
      remoteCandidateResult.validationFailure,
    ].filter((failure): failure is CandidateValidationFailure => failure != null);
    const persistedLocalPending =
      localCurrent != null && localResult.status === 'ok' && localResult.info.pendingRemote === true
        ? localCurrent
        : null;
    const localPending =
      persistedLocalPending ??
      (retained.activeContributed && localReadable != null ? localReadable : null);

    if (remoteReadable != null) {
      return reconcileReadableRemote(
        localReadable,
        localCurrent,
        localPending,
        remoteReadable,
        localResult,
      );
    }

    if (remoteResult.status === 'absent') {
      return reconcileAbsentRemote(
        localReadable,
        localCurrent,
        localPending,
        localResult,
        localValidationFailures,
      );
    }

    const selected = selectHighest(localReadable, state.active);
    if (selected != null) {
      state = {
        status: 'pending-offline',
        active: selected,
        pending: localPending,
        lastFailure: combineMessages(
          resultMessage(remoteResult),
          ...validationFailures.map((failure) => failure.message),
        ),
      };
      return cloneState(state);
    }

    if (validationFailures.length > 0) {
      state = {
        ...state,
        status: validationFailureStatus(validationFailures),
        lastFailure: combineMessages(
          resultMessage(localResult, remoteResult),
          ...validationFailures.map((failure) => failure.message),
        ),
      };
      return cloneState(state);
    }
    if (remoteResult.status === 'corrupt' || localResult.status === 'corrupt') {
      state = {
        ...state,
        status: 'corrupt',
        lastFailure: resultMessage(localResult, remoteResult),
      };
      return cloneState(state);
    }
    if (remoteResult.status === 'transport-failure' || localResult.status === 'transport-failure') {
      state = withFailure(state, `Vault pull failed: ${resultMessage(localResult, remoteResult)}`);
      return cloneState(state);
    }
    state = { status: 'empty', active: null, pending: null };
    return cloneState(state);
  }

  async function mutate(
    mutator: (context: VaultMutationContext) => VaultDocumentV1,
  ): Promise<VaultSyncState> {
    const active = state.active;
    if (active == null || state.status === 'locked') {
      throw new VaultCryptoError('locked', 'A readable unlocked vault is required for a mutation.');
    }
    if (localHeadVersion === undefined) {
      throw new VaultCryptoError(
        'storage-failed',
        'The current local vault version has not been observed.',
      );
    }
    if (state.status === 'corrupt') {
      throw new VaultCryptoError('locked', 'A readable unlocked vault is required for a mutation.');
    }
    if (state.status === 'unresolved') {
      throw new VaultCryptoError(
        'storage-failed',
        'The pending vault changes require explicit conflict resolution.',
      );
    }

    const document = mutator({
      document: active.document,
      currentVersion: active.header.vaultVersion,
    });
    const mutation = captureMutation(active.document, document, mutationSequence);
    const nextVersion =
      Math.max(
        active.header.vaultVersion,
        localHeadVersion ?? 0,
        remoteObserved.known ? (remoteObserved.version ?? 0) : 0,
      ) + 1;
    const candidate = await encryptCandidate(document, nextVersion, active.header);
    if (!(await commitLocal(candidate, localHeadVersion))) {
      if (state.status === 'conflict') return cloneState(state);
      throw new VaultCryptoError(
        'storage-failed',
        state.lastFailure ?? 'Vault mutation could not be committed locally.',
      );
    }

    mutationSequence += 1;
    pendingMutationProvenanceAvailable = true;
    if (mutation.changes.length > 0) {
      pendingMutations = [...pendingMutations, mutation];
    }
    state = { status: 'pending-offline', active: candidate, pending: candidate };
    return remoteObserved.known
      ? pushPending(candidate, remoteObserved.version)
      : cloneState(state);
  }

  async function reconcileReadableRemote(
    localReadable: VaultSyncCandidate | null,
    localCurrent: VaultSyncCandidate | null,
    localPending: VaultSyncCandidate | null,
    remote: VaultSyncCandidate,
    localResult: DataHomeReadResult,
  ): Promise<VaultSyncState> {
    remoteObserved = { known: true, version: remote.header.vaultVersion };

    if (localHeadVersion === undefined) {
      state = {
        status: localResult.status === 'transport-failure' ? 'pending-offline' : 'corrupt',
        active: selectHighest(localReadable, remote),
        pending: localPending,
        lastFailure:
          localResult.status === 'transport-failure'
            ? localResult.failure.message
            : localResult.status === 'corrupt'
              ? localResult.message
              : 'The local vault version could not be read.',
      };
      return cloneState(state);
    }
    const expectedLocalVersion = localHeadVersion;

    if (localReadable == null) {
      return installRemoteOrPromote(remote, localCurrent, expectedLocalVersion);
    }

    if (sameWrite(localReadable, remote)) {
      if (localCurrent != null && sameWrite(localCurrent, remote)) {
        state = { status: 'synced', active: remote, pending: null };
        if (!(await acknowledgeLocal(remote.header.vaultVersion))) return cloneState(state);
        pendingMutations = [];
        pendingMutationProvenanceAvailable = false;
        return cloneState(state);
      }
      return installRemoteOrPromote(remote, localCurrent, expectedLocalVersion);
    }

    if (localPending != null && mustSurfaceUnresolvedProvenance(localPending, remote)) {
      return surfaceUnresolvedProvenance(localPending);
    }

    const reconciledAt = now();
    const merged = mergeVaultDocuments({
      left: localReadable.document,
      leftVersion: localReadable.header.vaultVersion,
      right: remote.document,
      rightVersion: remote.header.vaultVersion,
      forceDivergent: localPending != null,
      deviceId: options.deviceId,
      mergedAt: reconciledAt,
    });

    const highestObserved = Math.max(expectedLocalVersion ?? 0, remote.header.vaultVersion);
    if (!merged.divergent) {
      if (
        merged.vaultVersion === remote.header.vaultVersion &&
        (merged.vaultVersion > localReadable.header.vaultVersion ||
          merged.vaultVersion === localReadable.header.vaultVersion)
      ) {
        return installRemoteOrPromote(remote, localCurrent, expectedLocalVersion);
      }

      if (
        merged.vaultVersion === localReadable.header.vaultVersion &&
        localCurrent != null &&
        sameWrite(localCurrent, localReadable) &&
        merged.vaultVersion > remote.header.vaultVersion &&
        merged.vaultVersion >= highestObserved
      ) {
        state = {
          status: 'pending-offline',
          active: localReadable,
          pending: localReadable,
        };
        if (!(await markPending(localReadable))) return cloneState(state);
        return pushPending(localReadable, remote.header.vaultVersion);
      }
    }

    const version = Math.max(merged.vaultVersion, highestObserved + 1);
    const reconciliation = reconcileMergedDocument(
      merged.document,
      localReadable.document,
      remote.document,
      reconciledAt,
    );
    const candidate = await encryptCandidate(
      reconciliation.document,
      version,
      newestHeader(localReadable, remote),
    );
    if (!(await commitLocal(candidate, expectedLocalVersion))) return cloneState(state);
    pendingMutations = reconciliation.pendingMutations;
    state = { status: 'pending-offline', active: candidate, pending: candidate };
    return pushPending(candidate, remote.header.vaultVersion);
  }

  async function installRemoteOrPromote(
    remote: VaultSyncCandidate,
    localCurrent: VaultSyncCandidate | null,
    expectedLocalVersion: number | null,
  ): Promise<VaultSyncState> {
    state = { status: 'pending-offline', active: remote, pending: null };

    if (localCurrent != null && sameWrite(localCurrent, remote)) {
      if (!(await acknowledgeLocal(remote.header.vaultVersion))) return cloneState(state);
      pendingMutations = [];
      pendingMutationProvenanceAvailable = false;
      state = { status: 'synced', active: remote, pending: null };
      return cloneState(state);
    }

    if (expectedLocalVersion !== null && remote.header.vaultVersion <= expectedLocalVersion) {
      const promoted = await encryptCandidate(
        remote.document,
        expectedLocalVersion + 1,
        remote.header,
      );
      if (!(await commitLocal(promoted, expectedLocalVersion))) return cloneState(state);
      pendingMutationProvenanceAvailable = true;
      state = { status: 'pending-offline', active: promoted, pending: promoted };
      return pushPending(promoted, remote.header.vaultVersion);
    }

    if (!(await commitLocal(remote, expectedLocalVersion))) return cloneState(state);
    if (!(await acknowledgeLocal(remote.header.vaultVersion))) return cloneState(state);
    pendingMutations = [];
    pendingMutationProvenanceAvailable = false;
    state = { status: 'synced', active: remote, pending: null };
    return cloneState(state);
  }

  async function reconcileAbsentRemote(
    localReadable: VaultSyncCandidate | null,
    localCurrent: VaultSyncCandidate | null,
    localPending: VaultSyncCandidate | null,
    localResult: DataHomeReadResult,
    validationFailures: CandidateValidationFailure[],
  ): Promise<VaultSyncState> {
    if (localReadable == null) {
      if (validationFailures.length > 0) {
        state = {
          ...state,
          status: validationFailureStatus(validationFailures),
          lastFailure: combineMessages(
            resultMessage(localResult),
            ...validationFailures.map((failure) => failure.message),
          ),
        };
      } else if (localResult.status === 'corrupt') {
        state = { ...state, status: 'corrupt', lastFailure: localResult.message };
      } else if (localResult.status === 'transport-failure') {
        state = withFailure(state, localResult.failure.message);
      } else {
        state = { status: 'empty', active: null, pending: null };
      }
      return cloneState(state);
    }

    state = {
      status: 'pending-offline',
      active: localReadable,
      pending: localPending,
    };
    if (localHeadVersion === undefined) {
      state = withFailure(state, 'The local vault version could not be read.');
      return cloneState(state);
    }

    let pending = localPending;
    if (localCurrent == null || !sameWrite(localCurrent, localReadable)) {
      const nextVersion = Math.max(localReadable.header.vaultVersion, localHeadVersion ?? 0) + 1;
      pending = await encryptCandidate(localReadable.document, nextVersion, localReadable.header);
      if (!(await commitLocal(pending, localHeadVersion))) return cloneState(state);
    } else if (pending == null) {
      state = { status: 'pending-offline', active: localReadable, pending: localReadable };
      if (!(await markPending(localReadable))) return cloneState(state);
      pending = localReadable;
    }

    state = { status: 'pending-offline', active: pending, pending };
    return pushPending(pending, null);
  }

  async function pushPending(
    initial: VaultSyncCandidate,
    initialExpectedRemote: number | null,
  ): Promise<VaultSyncState> {
    let pending = initial;
    let expectedRemote = initialExpectedRemote;

    for (let attempt = 0; attempt < MAX_CAS_RECONCILIATIONS; attempt += 1) {
      const result = await options.primary.write(pending.envelope, {
        ifVersion: expectedRemote,
      });
      switch (result.status) {
        case 'ok':
          remoteObserved = { known: true, version: pending.header.vaultVersion };
          if (!(await acknowledgeLocal(pending.header.vaultVersion))) return cloneState(state);
          pendingMutations = [];
          pendingMutationProvenanceAvailable = false;
          state = { status: 'synced', active: pending, pending: null };
          return cloneState(state);
        case 'transport-failure':
          state = {
            status: 'pending-offline',
            active: pending,
            pending,
            lastFailure: result.failure.message,
          };
          remoteObserved = { known: false, version: null };
          return cloneState(state);
        case 'corrupt':
          await quarantineCorrupt(result);
          state = {
            status: 'pending-offline',
            active: pending,
            pending,
            lastFailure: result.message,
          };
          remoteObserved = { known: false, version: null };
          return cloneState(state);
        case 'conflict':
          break;
      }

      const remoteResult = await options.primary.read();
      remoteObserved = observeRemote(remoteResult);
      const remoteCandidateResult = await readableCandidate(remoteResult);
      const remote = remoteCandidateResult.candidate;
      if (remote == null) {
        state = {
          status: 'pending-offline',
          active: pending,
          pending,
          lastFailure:
            remoteResult.status === 'absent'
              ? 'The primary disappeared while resolving a CAS conflict.'
              : combineMessages(
                  resultMessage(remoteResult),
                  remoteCandidateResult.validationFailure?.message,
                ),
        };
        return cloneState(state);
      }
      if (sameWrite(pending, remote)) {
        if (!(await acknowledgeLocal(pending.header.vaultVersion))) return cloneState(state);
        pendingMutations = [];
        pendingMutationProvenanceAvailable = false;
        state = { status: 'synced', active: remote, pending: null };
        return cloneState(state);
      }
      if (mustSurfaceUnresolvedProvenance(pending, remote)) {
        return surfaceUnresolvedProvenance(pending);
      }

      const reconciledAt = now();
      const merged = mergeVaultDocuments({
        left: pending.document,
        leftVersion: pending.header.vaultVersion,
        right: remote.document,
        rightVersion: remote.header.vaultVersion,
        forceDivergent: true,
        deviceId: options.deviceId,
        mergedAt: reconciledAt,
      });
      const reconciliation = reconcileMergedDocument(
        merged.document,
        pending.document,
        remote.document,
        reconciledAt,
      );
      const reconciled = await encryptCandidate(
        reconciliation.document,
        merged.vaultVersion,
        newestHeader(pending, remote),
      );
      if (!(await commitLocal(reconciled, localHeadVersion))) return cloneState(state);
      pendingMutations = reconciliation.pendingMutations;
      pending = reconciled;
      expectedRemote = remote.header.vaultVersion;
      state = { status: 'pending-offline', active: pending, pending };
    }

    state = {
      status: 'conflict',
      active: pending,
      pending,
      lastFailure: 'Vault synchronization lost too many consecutive CAS races.',
    };
    return cloneState(state);
  }

  async function commitLocal(
    candidate: VaultSyncCandidate,
    expectedVersion: number | null | undefined,
  ): Promise<boolean> {
    if (expectedVersion === undefined) {
      state = withFailure(state, 'The local CAS version is unknown.');
      return false;
    }
    const written = await options.local.write(candidate.envelope, {
      ifVersion: expectedVersion,
    });
    if (written.status === 'conflict') {
      await handleLocalConflict(written.currentVersion);
      return false;
    }
    if (written.status !== 'ok') {
      if (written.status === 'corrupt') await quarantineCorrupt(written);
      state = withFailure(state, `Local encrypted commit failed: ${outcomeMessage(written)}`);
      return false;
    }
    localHeadVersion = candidate.header.vaultVersion;

    const marked = await options.local.markLastKnownGood(candidate.envelope, {
      ifVersion: candidate.header.vaultVersion,
    });
    if (marked.status === 'conflict') {
      await handleLocalConflict(marked.currentVersion);
      return false;
    }
    if (marked.status === 'corrupt') {
      await quarantineCorrupt(marked);
      state = withFailure(state, marked.message);
      return false;
    }
    if (marked.status === 'transport-failure') {
      // The new encrypted current candidate is already durable and the previous
      // last-known-good bytes remain intact. Keep it pending rather than retrying
      // the money mutation.
      rollbackPersistenceFailure = marked.failure.message;
    } else {
      rollbackPersistenceFailure = undefined;
    }
    return true;
  }

  async function markPending(candidate: VaultSyncCandidate): Promise<boolean> {
    const result = await options.local.setPendingRemote(true, {
      ifVersion: candidate.header.vaultVersion,
    });
    if (result.status === 'conflict') {
      await handleLocalConflict(result.currentVersion);
      return false;
    }
    if (result.status !== 'ok') {
      if (result.status === 'corrupt') await quarantineCorrupt(result);
      state = withFailure(state, outcomeMessage(result));
      return false;
    }
    return true;
  }

  async function acknowledgeLocal(version: number): Promise<boolean> {
    const result = await options.local.setPendingRemote(false, { ifVersion: version });
    if (result.status === 'conflict') {
      await handleLocalConflict(result.currentVersion);
      return false;
    }
    if (result.status !== 'ok') {
      if (result.status === 'corrupt') await quarantineCorrupt(result);
      state = withFailure(state, outcomeMessage(result));
      return false;
    }
    return true;
  }

  async function handleLocalConflict(currentVersion: number | null): Promise<void> {
    const freshResult = await options.local.read();
    localHeadVersion = observedVersion(freshResult);
    const freshCandidateResult = await readableCandidate(freshResult);
    const fresh = freshCandidateResult.candidate;
    pendingMutations = [];
    pendingMutationProvenanceAvailable = false;
    state = {
      status: 'conflict',
      active: fresh ?? state.active,
      pending:
        fresh != null && freshResult.status === 'ok' && freshResult.info.pendingRemote === true
          ? fresh
          : null,
      lastFailure: combineMessages(
        `Local vault CAS conflict; current version is ${currentVersion ?? 'unknown'}.`,
        freshCandidateResult.validationFailure?.message,
      ),
    };
  }

  async function readableLocalCurrent(
    result: DataHomeReadResult,
  ): Promise<ReadableCandidateResult | typeof RETRY_LOCAL_OBSERVATION> {
    const candidateResult = await readableCandidate(result);
    if (candidateResult.candidate == null || result.status !== 'ok') return candidateResult;

    const marked = await options.local.markLastKnownGood(result.envelope, {
      ifVersion: result.info.version,
    });
    if (marked.status === 'conflict') return RETRY_LOCAL_OBSERVATION;
    if (marked.status === 'corrupt') {
      await quarantineCorrupt(marked);
      rollbackPersistenceFailure = marked.message;
    } else if (marked.status === 'transport-failure') {
      rollbackPersistenceFailure = marked.failure.message;
    } else {
      rollbackPersistenceFailure = undefined;
    }
    return candidateResult;
  }

  async function retainActiveCandidate(
    persisted: VaultSyncCandidate | null,
    active: VaultSyncCandidate | null,
  ): Promise<{ candidate: VaultSyncCandidate | null; activeContributed: boolean }> {
    if (active == null) return { candidate: persisted, activeContributed: false };
    if (persisted == null) return { candidate: active, activeContributed: true };
    if (sameWrite(persisted, active)) {
      return { candidate: persisted, activeContributed: false };
    }

    const reconciledAt = now();
    const merged = mergeVaultDocuments({
      left: persisted.document,
      leftVersion: persisted.header.vaultVersion,
      right: active.document,
      rightVersion: active.header.vaultVersion,
      deviceId: options.deviceId,
      mergedAt: reconciledAt,
    });
    if (!merged.divergent) {
      if (persisted.header.vaultVersion > active.header.vaultVersion) {
        pendingMutations = [];
        pendingMutationProvenanceAvailable = false;
        return { candidate: persisted, activeContributed: false };
      }
      if (active.header.vaultVersion > persisted.header.vaultVersion) {
        return { candidate: active, activeContributed: true };
      }
      return { candidate: selectHighest(persisted, active), activeContributed: false };
    }

    const reconciliation = reconcileMergedDocument(
      merged.document,
      active.document,
      persisted.document,
      reconciledAt,
    );
    pendingMutations = reconciliation.pendingMutations;
    return {
      candidate: await encryptCandidate(
        reconciliation.document,
        merged.vaultVersion,
        newestHeader(persisted, active),
      ),
      activeContributed: true,
    };
  }

  function reconcileMergedDocument(
    document: VaultDocumentV1,
    local: VaultDocumentV1,
    remote: VaultDocumentV1,
    reconciledAt: string,
  ): { document: VaultDocumentV1; pendingMutations: VaultAtomicMutation[] } {
    const reconciliation = documentReconciler(document, {
      local,
      remote,
      mutations: pendingMutations,
      deviceId: options.deviceId,
      reconciledAt,
    });
    return {
      document: reconciliation.document,
      pendingMutations: reconciliation.mutations.map(cloneMutation),
    };
  }

  function mustSurfaceUnresolvedProvenance(
    local: VaultSyncCandidate,
    remote: VaultSyncCandidate,
  ): boolean {
    return (
      options.requiresCompleteMutationProvenance &&
      !pendingMutationProvenanceAvailable &&
      !sameJsonValue(local.document.entities, remote.document.entities)
    );
  }

  function surfaceUnresolvedProvenance(local: VaultSyncCandidate): VaultSyncState {
    state = {
      status: 'unresolved',
      active: local,
      pending: local,
      lastFailure:
        'Original atomic mutation provenance is unavailable; explicit conflict resolution is required.',
    };
    return cloneState(state);
  }

  async function readableCandidate(result: DataHomeReadResult): Promise<ReadableCandidateResult> {
    switch (result.status) {
      case 'absent':
      case 'transport-failure':
        return { candidate: null };
      case 'corrupt':
        await quarantineCorrupt(result);
        return {
          candidate: null,
          validationFailure: { status: 'corrupt', message: result.message },
        };
      case 'ok':
        try {
          const decrypted = await decryptVaultDocument(result.envelope, options.vaultKey);
          return {
            candidate: {
              home: result.medium === 'local' ? options.local : options.primary,
              envelope: result.envelope.slice(),
              header: decrypted.header,
              document: decrypted.document,
            },
          };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Vault could not be decrypted.';
          await options.quarantine.put({
            medium: result.medium,
            envelope: result.envelope,
            version: result.info.version,
            updatedAt: result.info.updatedAt,
            capturedAt: now(),
            status:
              cause instanceof VaultCryptoError && cause.code === 'update-required'
                ? 'unsupported'
                : 'unreadable',
            reason: message,
          });
          return {
            candidate: null,
            validationFailure: {
              status:
                cause instanceof VaultCryptoError &&
                (cause.code === 'authentication-failed' ||
                  cause.code === 'custody-failed' ||
                  cause.code === 'locked')
                  ? 'locked'
                  : 'corrupt',
              message,
            },
          };
        }
    }
  }

  function serialize(operation: () => Promise<VaultSyncState>): Promise<VaultSyncState> {
    const result = operationTail.then(async () => {
      rollbackPersistenceFailure = undefined;
      const operationState = await operation();
      if (rollbackPersistenceFailure == null) return operationState;
      state = {
        ...operationState,
        status: operationState.status === 'synced' ? 'pending-offline' : operationState.status,
        lastFailure: combineMessages(
          operationState.lastFailure,
          `Could not preserve the encrypted rollback snapshot: ${rollbackPersistenceFailure}`,
        ),
      };
      return cloneState(state);
    });
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function quarantineCorrupt(
    result: Extract<DataHomeReadResult | DataHomeWriteResult, { status: 'corrupt' }>,
  ): Promise<void> {
    if (result.envelope == null) return;
    await options.quarantine.put({
      medium: result.medium,
      envelope: result.envelope,
      version: result.version,
      updatedAt: result.updatedAt,
      capturedAt: now(),
      status: result.reason === 'unsupported-version' ? 'unsupported' : 'corrupt',
      reason: result.message,
    });
  }

  async function encryptCandidate(
    document: VaultDocumentV1,
    vaultVersion: number,
    baseHeader: VaultEnvelopeHeader,
  ): Promise<VaultSyncCandidate> {
    const encrypted = await encryptVaultDocument({
      document,
      vaultKey: options.vaultKey,
      header: {
        keyId: baseHeader.keyId,
        wrappedKeys: baseHeader.wrappedKeys,
        vaultVersion,
        deviceId: options.deviceId,
        writeId: options.writeId(),
        writtenAt: now(),
      },
    });
    return {
      home: options.local,
      envelope: encrypted.envelope,
      header: encrypted.header,
      document,
    };
  }
}

function captureMutation(
  before: VaultDocumentV1,
  after: VaultDocumentV1,
  sequence: number,
): VaultAtomicMutation {
  const changes: VaultMutationEntityDelta[] = [];
  const kinds = new Set<VaultEntityKind>([
    ...(Object.keys(before.entities) as VaultEntityKind[]),
    ...(Object.keys(after.entities) as VaultEntityKind[]),
  ]);

  for (const kind of [...kinds].sort()) {
    const beforeById = new Map((before.entities[kind] ?? []).map((entity) => [entity.id, entity]));
    const afterById = new Map((after.entities[kind] ?? []).map((entity) => [entity.id, entity]));
    const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
    for (const id of [...ids].sort()) {
      const previous = beforeById.get(id);
      const next = afterById.get(id);
      if (sameJsonValue(previous, next)) continue;
      changes.push({ kind, id, before: previous, after: next });
    }
  }

  return { sequence, changes };
}

function cloneMutation(mutation: VaultAtomicMutation): VaultAtomicMutation {
  return {
    sequence: mutation.sequence,
    changes: mutation.changes.map((change) => ({ ...change })),
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function observedVersion(result: DataHomeReadResult): number | null | undefined {
  switch (result.status) {
    case 'ok':
      return result.info.version;
    case 'absent':
      return null;
    case 'corrupt':
      return result.version ?? undefined;
    case 'transport-failure':
      return undefined;
  }
}

function observeRemote(result: DataHomeReadResult): RemoteObservation {
  switch (result.status) {
    case 'ok':
      return { known: true, version: result.info.version };
    case 'absent':
      return { known: true, version: null };
    case 'corrupt':
    case 'transport-failure':
      return { known: false, version: null };
  }
}

function selectHighest(
  left: VaultSyncCandidate | null,
  right: VaultSyncCandidate | null,
): VaultSyncCandidate | null {
  if (left == null) return right;
  if (right == null) return left;
  if (left.header.vaultVersion !== right.header.vaultVersion) {
    return left.header.vaultVersion > right.header.vaultVersion ? left : right;
  }
  return left.header.writeId >= right.header.writeId ? left : right;
}

function newestHeader(left: VaultSyncCandidate, right: VaultSyncCandidate): VaultEnvelopeHeader {
  if (left.header.vaultVersion !== right.header.vaultVersion) {
    return left.header.vaultVersion > right.header.vaultVersion ? left.header : right.header;
  }
  return left.header.writeId >= right.header.writeId ? left.header : right.header;
}

function sameWrite(left: VaultSyncCandidate, right: VaultSyncCandidate): boolean {
  return (
    left.header.vaultVersion === right.header.vaultVersion &&
    left.header.writeId === right.header.writeId
  );
}

function validationFailureStatus(
  failures: CandidateValidationFailure[],
): CandidateValidationFailure['status'] {
  return failures.some((failure) => failure.status === 'corrupt') ? 'corrupt' : 'locked';
}

function combineMessages(...messages: (string | undefined)[]): string {
  return [
    ...new Set(
      messages
        .map((message) => message?.trim())
        .filter((message) => message != null && message !== ''),
    ),
  ].join(' ');
}

function cloneState(value: VaultSyncState): VaultSyncState {
  return { ...value };
}

function withFailure(value: VaultSyncState, lastFailure: string): VaultSyncState {
  return {
    ...value,
    status: value.active == null ? 'corrupt' : 'pending-offline',
    lastFailure,
  };
}

function resultMessage(...results: DataHomeReadResult[]): string {
  return results
    .filter(
      (
        result,
      ): result is Extract<DataHomeReadResult, { status: 'corrupt' | 'transport-failure' }> =>
        result.status === 'corrupt' || result.status === 'transport-failure',
    )
    .map((result) => (result.status === 'corrupt' ? result.message : result.failure.message))
    .join(' ');
}

function outcomeMessage(result: Exclude<DataHomeWriteResult, { status: 'ok' }>): string {
  switch (result.status) {
    case 'conflict':
      return 'CAS conflict.';
    case 'corrupt':
      return result.message;
    case 'transport-failure':
      return result.failure.message;
  }
}

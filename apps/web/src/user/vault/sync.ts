import type { VaultDocumentV1, VaultEnvelopeHeader } from '@bettertrack/contracts';

import { decryptVaultDocument, encryptVaultDocument, type VaultKeyMaterial } from './crypto';
import type { DataHome, DataHomeReadResult, DataHomeWriteResult } from './dataHome';
import { VaultCryptoError } from './errors';
import type { LocalDataHome } from './localDataHome';
import { mergeVaultDocuments } from './merge';
import type { VaultQuarantineStore } from './quarantine';

export interface VaultSyncCandidate {
  home: DataHome;
  envelope: Uint8Array;
  header: VaultEnvelopeHeader;
  document: VaultDocumentV1;
}

export type VaultSyncStatus =
  | 'synced'
  | 'pending-offline'
  | 'conflict'
  | 'corrupt'
  | 'locked'
  | 'empty';

export interface VaultSyncState {
  status: VaultSyncStatus;
  /** The active readable state is never cleared after a failed pull/decrypt. */
  active: VaultSyncCandidate | null;
  /** A locally committed encrypted blob that still needs remote persistence. */
  pending: VaultSyncCandidate | null;
  lastFailure?: string;
}

export interface VaultSyncEngineOptions {
  local: LocalDataHome;
  /** The primary remote medium — PD5 has server only; Drive joins in PD6. */
  primary: DataHome;
  vaultKey: VaultKeyMaterial;
  deviceId: string;
  writeId: () => string;
  now?: () => string;
  quarantine: VaultQuarantineStore;
}

export interface VaultMutationContext {
  document: VaultDocumentV1;
  currentVersion: number;
}

export interface VaultSyncEngine {
  readonly state: VaultSyncState;
  start(): Promise<VaultSyncState>;
  reconnect(): Promise<VaultSyncState>;
  mutate(mutator: (context: VaultMutationContext) => VaultDocumentV1): Promise<VaultSyncState>;
}

/**
 * §4 local-first coordinator. It treats every uncertain network outcome as
 * pending, pulls before retrying, and never force-overwrites a remote blob.
 */
export function createVaultSyncEngine(options: VaultSyncEngineOptions): VaultSyncEngine {
  const now = options.now ?? (() => new Date().toISOString());
  let state: VaultSyncState = { status: 'empty', active: null, pending: null };

  return {
    get state() {
      return cloneState(state);
    },

    async start() {
      return reconcile();
    },

    async reconnect() {
      return reconcile();
    },

    async mutate(mutator) {
      const active = state.active;
      if (active == null || state.status === 'corrupt' || state.status === 'locked') {
        throw new VaultCryptoError(
          'locked',
          'A readable unlocked vault is required for a mutation.',
        );
      }
      const document = mutator({
        document: active.document,
        currentVersion: active.header.vaultVersion,
      });
      const candidate = await encryptCandidate(
        document,
        active.header.vaultVersion + 1,
        active.header,
      );
      if (!(await commitLocal(candidate))) return cloneState(state);

      state = { status: 'pending-offline', active: candidate, pending: candidate };
      return pushPending();
    },
  };

  async function reconcile(): Promise<VaultSyncState> {
    const [localResult, remoteResult] = await Promise.all([
      options.local.read(),
      options.primary.read(),
    ]);
    const local = await readableCandidate(localResult);
    const remote = await readableCandidate(remoteResult);
    const pending = state.pending == null ? null : await readablePending(state.pending);

    if (remote != null) return reconcileRemote(local, remote, pending);

    if (remoteResult.status === 'absent') return reconcileAbsentRemote(local, pending, localResult);

    // Transport and corrupt remote outcomes cannot safely be CAS-written over.
    // A readable local cache remains available, and its original encrypted bytes
    // stay either in the local cache or quarantine for later restore.
    const selected = selectHighest(local, pending);
    if (selected != null) {
      state = {
        status: 'pending-offline',
        active: selected,
        pending,
        lastFailure: resultMessage(remoteResult),
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

  async function reconcileRemote(
    local: VaultSyncCandidate | null,
    remote: VaultSyncCandidate,
    pending: VaultSyncCandidate | null,
  ): Promise<VaultSyncState> {
    if (pending != null && sameWrite(pending, remote)) {
      if (!(await commitLocal(remote))) return cloneState(state);
      state = { status: 'synced', active: remote, pending: null };
      return cloneState(state);
    }

    const candidate = pending ?? local;
    if (candidate == null) {
      if (!(await commitLocal(remote))) return cloneState(state);
      state = { status: 'synced', active: remote, pending: null };
      return cloneState(state);
    }

    const merged = mergeVaultDocuments({
      left: candidate.document,
      leftVersion: candidate.header.vaultVersion,
      right: remote.document,
      rightVersion: remote.header.vaultVersion,
      deviceId: options.deviceId,
      mergedAt: now(),
    });

    if (!merged.divergent) {
      // A local/pending successor can contain every remote entity while still
      // needing persistence. Equal-version divergent ciphertext is resolved to
      // the primary deterministically; it must not be force-overwritten.
      if (candidate.header.vaultVersion > remote.header.vaultVersion) {
        state = { status: 'pending-offline', active: candidate, pending: candidate };
        return pushPending();
      }
      if (!(await commitLocal(remote))) return cloneState(state);
      state = { status: 'synced', active: remote, pending: null };
      return cloneState(state);
    }

    const mergedCandidate = await encryptCandidate(
      merged.document,
      merged.vaultVersion,
      newestHeader(candidate, remote),
    );
    if (!(await commitLocal(mergedCandidate))) return cloneState(state);
    state = { status: 'pending-offline', active: mergedCandidate, pending: mergedCandidate };
    return pushPending();
  }

  async function reconcileAbsentRemote(
    local: VaultSyncCandidate | null,
    pending: VaultSyncCandidate | null,
    localResult: DataHomeReadResult,
  ): Promise<VaultSyncState> {
    const candidate = selectHighest(local, pending);
    if (candidate == null) {
      if (localResult.status === 'corrupt') {
        state = { ...state, status: 'corrupt', lastFailure: localResult.message };
      } else if (localResult.status === 'transport-failure') {
        state = withFailure(state, `Vault pull failed: ${localResult.failure.message}`);
      } else {
        state = { status: 'empty', active: null, pending: null };
      }
      return cloneState(state);
    }

    // The configured server medium has no blob. Preserve the highest readable
    // local candidate and create it with If-None-Match: *; no data is discarded.
    state = { status: 'pending-offline', active: candidate, pending: candidate };
    return pushPending();
  }

  async function pushPending(): Promise<VaultSyncState> {
    const pending = state.pending;
    if (pending == null) return cloneState(state);

    // Read immediately before write. This handles an ambiguous earlier network
    // outcome: if the same write is already remote, acknowledge it; otherwise
    // only write against exactly the predecessor version.
    const remoteResult = await options.primary.read();
    switch (remoteResult.status) {
      case 'transport-failure':
        state = { ...state, status: 'pending-offline', lastFailure: remoteResult.failure.message };
        return cloneState(state);
      case 'corrupt':
        await quarantineCorrupt(remoteResult);
        state = { ...state, status: 'pending-offline', lastFailure: remoteResult.message };
        return cloneState(state);
      case 'absent':
        return writePending(pending, null);
      case 'ok': {
        const remote = await readableCandidate(remoteResult);
        if (remote == null) {
          state = {
            ...state,
            status: 'pending-offline',
            lastFailure: 'Remote vault is unreadable.',
          };
          return cloneState(state);
        }
        if (sameWrite(pending, remote)) {
          if (!(await commitLocal(remote))) return cloneState(state);
          state = { status: 'synced', active: remote, pending: null };
          return cloneState(state);
        }
        const expectedVersion = pending.header.vaultVersion - 1;
        if (remote.header.vaultVersion !== expectedVersion) {
          // A competing writer won. Reconcile the still-pending local document
          // with the fresh remote snapshot before writing a normal successor.
          const merged = mergeVaultDocuments({
            left: pending.document,
            leftVersion: pending.header.vaultVersion,
            right: remote.document,
            rightVersion: remote.header.vaultVersion,
            deviceId: options.deviceId,
            mergedAt: now(),
          });
          if (!merged.divergent) {
            if (!(await commitLocal(remote))) return cloneState(state);
            state = { status: 'synced', active: remote, pending: null };
            return cloneState(state);
          }
          const reconciled = await encryptCandidate(
            merged.document,
            merged.vaultVersion,
            newestHeader(pending, remote),
          );
          if (!(await commitLocal(reconciled))) return cloneState(state);
          state = { status: 'pending-offline', active: reconciled, pending: reconciled };
          return writePending(reconciled, remote.header.vaultVersion);
        }
        return writePending(pending, expectedVersion);
      }
    }
  }

  async function writePending(
    pending: VaultSyncCandidate,
    expectedVersion: number | null,
  ): Promise<VaultSyncState> {
    const result = await options.primary.write(pending.envelope, { ifVersion: expectedVersion });
    switch (result.status) {
      case 'ok':
        state = { status: 'synced', active: pending, pending: null };
        return cloneState(state);
      case 'conflict':
        state = { ...state, status: 'conflict', lastFailure: 'Vault CAS conflict.' };
        return cloneState(state);
      case 'transport-failure':
        state = { ...state, status: 'pending-offline', lastFailure: result.failure.message };
        return cloneState(state);
      case 'corrupt':
        await quarantineCorrupt(result);
        state = { ...state, status: 'corrupt', lastFailure: result.message };
        return cloneState(state);
    }
  }

  async function commitLocal(candidate: VaultSyncCandidate): Promise<boolean> {
    const current = await options.local.info();
    let ifVersion: number | null;
    switch (current.status) {
      case 'ok':
        ifVersion = current.info.version;
        break;
      case 'absent':
        ifVersion = null;
        break;
      case 'corrupt':
        await quarantineCorrupt(current);
        ifVersion = current.version;
        if (ifVersion == null) {
          state = withFailure(state, 'Local cache version is unreadable.');
          return false;
        }
        break;
      case 'transport-failure':
        state = withFailure(state, current.failure.message);
        return false;
    }

    const written = await options.local.write(candidate.envelope, { ifVersion });
    if (written.status !== 'ok') {
      state = withFailure(state, `Local encrypted commit failed: ${outcomeMessage(written)}`);
      return false;
    }
    try {
      await options.local.markLastKnownGood(candidate.envelope);
      return true;
    } catch (cause) {
      state = withFailure(
        state,
        cause instanceof Error ? cause.message : 'Could not preserve the local rollback snapshot.',
      );
      return false;
    }
  }

  async function readableCandidate(result: DataHomeReadResult): Promise<VaultSyncCandidate | null> {
    switch (result.status) {
      case 'absent':
      case 'transport-failure':
        return null;
      case 'corrupt':
        await quarantineCorrupt(result);
        return null;
      case 'ok':
        try {
          const decrypted = await decryptVaultDocument(result.envelope, options.vaultKey);
          if (result.medium === 'local') await options.local.markLastKnownGood(result.envelope);
          return {
            home: result.medium === 'local' ? options.local : options.primary,
            envelope: result.envelope.slice(),
            header: decrypted.header,
            document: decrypted.document,
          };
        } catch (cause) {
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
            reason: cause instanceof Error ? cause.message : 'Vault could not be decrypted.',
          });
          return null;
        }
    }
  }

  async function readablePending(
    candidate: VaultSyncCandidate,
  ): Promise<VaultSyncCandidate | null> {
    try {
      const decrypted = await decryptVaultDocument(candidate.envelope, options.vaultKey);
      return { ...candidate, header: decrypted.header, document: decrypted.document };
    } catch (cause) {
      await options.quarantine.put({
        medium: candidate.home.medium,
        envelope: candidate.envelope,
        version: candidate.header.vaultVersion,
        updatedAt: candidate.header.writtenAt,
        capturedAt: now(),
        status:
          cause instanceof VaultCryptoError && cause.code === 'update-required'
            ? 'unsupported'
            : 'unreadable',
        reason:
          cause instanceof Error ? cause.message : 'Pending vault write could not be decrypted.',
      });
      state = {
        ...state,
        status: 'corrupt',
        pending: null,
        lastFailure: 'Pending vault write is unreadable.',
      };
      return null;
    }
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
  return right.header;
}

function sameWrite(left: VaultSyncCandidate, right: VaultSyncCandidate): boolean {
  return (
    left.header.vaultVersion === right.header.vaultVersion &&
    left.header.writeId === right.header.writeId
  );
}

function cloneState(state: VaultSyncState): VaultSyncState {
  return { ...state };
}

function withFailure(state: VaultSyncState, lastFailure: string): VaultSyncState {
  return { ...state, status: state.active == null ? 'corrupt' : 'pending-offline', lastFailure };
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

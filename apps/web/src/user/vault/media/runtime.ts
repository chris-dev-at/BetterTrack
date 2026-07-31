import {
  VAULT_DOCUMENT_VERSION,
  type VaultDocument,
  type VaultMirrorProvenance,
} from '@bettertrack/contracts';

import {
  getParanoidForkProvenance,
  getParanoidMediaState,
  purgeRetiredParanoidServer,
  readParanoidServerCandidate,
  requestRetiredServerPurgeChallenge,
  stageParanoidServerCandidate,
  transitionParanoidMedia,
} from '../../../lib/userApi';
import type { VaultKeyMaterial } from '../crypto';
import type { DataHome } from '../dataHome';
import {
  createDriveDataHome,
  createGoogleDriveTokenClient,
  type DriveDataHome,
  type GoogleDriveTokenClient,
} from '../drive';
import { createLocalDataHome } from '../localDataHome';
import { captureForkProvenanceIntoVault } from '../mirrorProvenance';
import { createIndexedDbVaultQuarantineStore } from '../quarantine';
import { createServerBlobDataHome } from '../serverBlobDataHome';
import {
  createVaultSyncEngine,
  hasUnambiguousBranch,
  type VaultSyncEngine,
  type VaultSyncState,
} from '../sync';
import { reconcilePortfolioDocument } from '../vaultPortfolioStore';
import { VaultCryptoError } from '../errors';
import { equalBytes } from '../bytes';
import { createDriveConnectionController, type DriveConnectionController } from './driveConnection';
import { createVaultMediaSwitcher, type VaultMediaApi } from './mediaSwitcher';
import {
  createReplicaReconcileCoordinator,
  createReplicatedVaultDataHome,
} from './replicatedDataHome';
import {
  createVaultRetirementProofManager,
  type VaultRetirementProofManager,
} from './retirementProof';
import { createVaultEnvelopeAuthenticator } from './verification';

export interface VaultDriveSyncCoordinator {
  readonly deviceId: string;
  readonly state: VaultSyncState;
  reconnect(): Promise<VaultSyncState>;
  mutate: VaultSyncEngine['mutate'];
}

export interface UnlockedVaultDriveRuntimeOptions {
  userId: string;
  clientId: string;
  tokens?: GoogleDriveTokenClient;
  server?: DataHome;
  drive?: DriveDataHome;
  api?: VaultMediaApi;
  sync?: VaultDriveSyncCoordinator;
  retirementProof?: VaultRetirementProofManager;
  /** §7.1 capture read; defaults to `GET /account/paranoid/fork-provenance`. */
  forkProvenance?: () => Promise<readonly VaultMirrorProvenance[]>;
}

export interface UnlockedVaultDriveRuntime {
  readonly controller: DriveConnectionController;
  /** The PD5 sync seam of this unlocked session — the PD7 money engine's read/write surface. */
  readonly sync: VaultDriveSyncCoordinator;
  readonly ready: Promise<void>;
  readonly syncState: VaultSyncState;
  /**
   * Publish a PD4-produced replacement envelope to the same verified replica
   * set. The caller locks immediately afterward so a rotated key can be
   * installed only through the normal authenticated unlock path.
   */
  replaceEnvelope?(envelope: Uint8Array): Promise<void>;
  reconnect(): Promise<VaultSyncState>;
  dispose(): void;
}

/**
 * Production composition boundary for one unlocked vault. The in-memory key,
 * GIS client, Drive/server DataHomes, media switcher, proof signer, and existing
 * PD5 sync coordinator meet only here; Settings receives the narrow controller.
 */
export function createUnlockedVaultDriveRuntime(
  vaultKey: VaultKeyMaterial,
  keyId: string,
  options: UnlockedVaultDriveRuntimeOptions,
): UnlockedVaultDriveRuntime {
  const tokens = options.tokens ?? createGoogleDriveTokenClient({ clientId: options.clientId });
  const retirementProof =
    options.retirementProof ?? createVaultRetirementProofManager(globalThis.crypto.subtle);
  const server =
    options.server ??
    createServerBlobDataHome({
      retirementProofPublicKey: () => retirementProof.publicKey,
    });
  const drive =
    options.drive ??
    createDriveDataHome({
      accountId: options.userId,
      tokens,
    });
  const api: VaultMediaApi = options.api ?? {
    getState: getParanoidMediaState,
    transition: transitionParanoidMedia,
    stageServerCandidate: stageParanoidServerCandidate,
    readServerCandidate: readParanoidServerCandidate,
    requestPurgeChallenge: requestRetiredServerPurgeChallenge,
    purgeRetired: purgeRetiredParanoidServer,
  };
  const authenticate = createVaultEnvelopeAuthenticator(vaultKey);
  const switcher = createVaultMediaSwitcher({
    api,
    server,
    drive,
    authenticate,
    retirementProof,
  });
  const defaultSync =
    options.sync == null
      ? createDefaultSyncCoordinator({
          userId: options.userId,
          vaultKey,
          keyId,
          api,
          server,
          drive,
        })
      : null;
  const sync = options.sync ?? defaultSync!.coordinator;

  let disposed = false;
  let readyPromise: Promise<void> | null = null;

  function requireActive(): void {
    if (disposed) {
      throw new VaultCryptoError('locked', 'The unlocked Drive runtime was disposed.');
    }
  }

  // The seam handed out to the money engine/provider. Disposal (lock) revokes
  // it: a stale holder — an in-flight export's final snapshot check, the
  // fire-and-forget standing-order catch-up — fails locked instead of reading
  // or mutating through the retired session's coordinator.
  const guardedSync: VaultDriveSyncCoordinator = {
    deviceId: sync.deviceId,
    get state() {
      requireActive();
      return sync.state;
    },
    async reconnect() {
      requireActive();
      const state = await sync.reconnect();
      requireActive();
      return state;
    },
    async mutate(mutator) {
      requireActive();
      const state = await sync.mutate(mutator);
      requireActive();
      return state;
    },
  };

  async function initialize(): Promise<void> {
    requireActive();
    const state = await sync.reconnect();
    requireActive();
    if (state.active == null || !hasUnambiguousBranch(state.status)) {
      throw new Error('No unambiguous readable vault is available on this device.');
    }
    const ensured = await retirementProof.ensure(state.active.document);
    requireActive();
    if (ensured.changed) {
      const committed = await sync.mutate(({ document }) =>
        applyRetirementProofMaterial(document, ensured.document),
      );
      requireActive();
      if (committed.status !== 'synced' || committed.active == null || committed.pending != null) {
        throw new Error('Vault retirement proof material was not durably synchronized.');
      }
      const confirmed = await retirementProof.ensure(committed.active.document);
      requireActive();
      if (confirmed.changed) {
        throw new Error('Committed vault retirement proof material could not be confirmed.');
      }
    }
    await captureForkProvenance();
  }

  /**
   * §7.1: fold the account's severed-fork identity map into the document on every
   * unlocked session. This is what puts the map inside the ciphertext BEFORE the
   * enable wizard's `enable()` purges `mirror_rows` — the map only exists while
   * the fork's copy does, and after enable the read is empty and this no-ops.
   *
   * An unreachable capture read must not block unlocking an already-encrypted
   * vault (Drive-only can be readable while the API is not), so a failed READ is
   * skipped and retried on the next unlock. A read that succeeded and produced new
   * provenance must land durably, exactly like the proof material above: a fork
   * whose identities never reached the ciphertext could not be restored later.
   */
  async function captureForkProvenance(): Promise<void> {
    const read =
      options.forkProvenance ?? (async () => (await getParanoidForkProvenance()).provenance);
    let captured: readonly VaultMirrorProvenance[];
    try {
      captured = await read();
    } catch {
      return;
    }
    requireActive();
    const committed = await captureForkProvenanceIntoVault(sync, async () => captured);
    if (committed == null) return;
    requireActive();
    if (committed.status !== 'synced' || committed.active == null || committed.pending != null) {
      throw new Error('Severed-fork MIRRORCHAIN provenance was not durably synchronized.');
    }
  }

  function ready(): Promise<void> {
    readyPromise ??= initialize().catch((cause) => {
      readyPromise = null;
      throw cause;
    });
    return readyPromise;
  }

  const controller = createDriveConnectionController({
    tokens,
    switcher,
    ready,
    resumeSync: async () => {
      requireActive();
      const state = await sync.reconnect();
      requireActive();
      return state;
    },
  });

  return {
    controller,
    sync: guardedSync,
    get ready() {
      return ready();
    },
    get syncState() {
      return sync.state;
    },
    async replaceEnvelope(envelope) {
      requireActive();
      await ready();
      requireActive();
      const active = sync.state.active;
      if (
        defaultSync == null ||
        sync.state.status !== 'synced' ||
        active == null ||
        sync.state.pending != null
      ) {
        throw new VaultCryptoError(
          'storage-failed',
          'Every selected vault medium must be synchronized before changing vault keys.',
        );
      }
      const expectedVersion = active.header.vaultVersion;
      const remoteWrite = await defaultSync.primary.write(envelope, {
        ifVersion: expectedVersion,
      });
      if (remoteWrite.status !== 'ok') {
        throw new VaultCryptoError(
          'storage-failed',
          'The replacement vault could not be written to every selected medium.',
        );
      }
      const remoteRead = await defaultSync.primary.read();
      if (remoteRead.status !== 'ok' || !equalBytes(remoteRead.envelope, envelope)) {
        throw new VaultCryptoError(
          'storage-failed',
          'The replacement vault could not be verified on every selected medium.',
        );
      }
      const localWrite = await defaultSync.local.write(envelope, {
        ifVersion: expectedVersion,
      });
      if (localWrite.status !== 'ok') {
        throw new VaultCryptoError(
          'storage-failed',
          'The replacement vault could not be saved to the encrypted local cache.',
        );
      }
      const localRead = await defaultSync.local.read();
      if (localRead.status !== 'ok' || !equalBytes(localRead.envelope, envelope)) {
        throw new VaultCryptoError(
          'storage-failed',
          'The replacement encrypted local cache could not be verified.',
        );
      }
    },
    async reconnect() {
      requireActive();
      const state = await sync.reconnect();
      requireActive();
      return state;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retirementProof.clear();
      tokens.clear();
    },
  };
}

function applyRetirementProofMaterial(
  current: VaultDocument,
  prepared: VaultDocument,
): VaultDocument {
  if (prepared.schemaVersion !== VAULT_DOCUMENT_VERSION) {
    throw new VaultCryptoError(
      'document-invalid',
      'Prepared vault retirement proof material is missing.',
    );
  }
  if (current.schemaVersion === VAULT_DOCUMENT_VERSION) {
    const currentProof = current.clientSecurity.retirementProof;
    const preparedProof = prepared.clientSecurity.retirementProof;
    if (
      currentProof.publicKey !== preparedProof.publicKey ||
      currentProof.privateKey !== preparedProof.privateKey
    ) {
      throw new VaultCryptoError(
        'document-invalid',
        'Vault retirement proof material changed during enrollment.',
      );
    }
    return current;
  }
  return {
    ...current,
    schemaVersion: VAULT_DOCUMENT_VERSION,
    clientSecurity: prepared.clientSecurity,
  };
}

function createDefaultSyncCoordinator(options: {
  userId: string;
  vaultKey: VaultKeyMaterial;
  keyId: string;
  api: VaultMediaApi;
  server: DataHome;
  drive: DriveDataHome;
}): {
  coordinator: VaultDriveSyncCoordinator;
  local: ReturnType<typeof createLocalDataHome>;
  primary: ReturnType<typeof createReplicatedVaultDataHome>;
} {
  const scope = `vault:${options.userId}:${options.keyId}`;
  const primary = createReplicatedVaultDataHome(options);
  const local = createLocalDataHome({ scope });
  const engine = createVaultSyncEngine({
    local,
    primary,
    vaultKey: options.vaultKey,
    deviceId: browserVaultDeviceId(options.userId, options.keyId),
    writeId: () => globalThis.crypto.randomUUID(),
    quarantine: createIndexedDbVaultQuarantineStore({ scope }),
    documentReconciler: reconcilePortfolioDocument,
    requiresCompleteMutationProvenance: true,
  });
  const replicaCoordinator = createReplicaReconcileCoordinator(engine, primary);
  const coordinator: VaultDriveSyncCoordinator = {
    deviceId: engine.deviceId,
    get state() {
      return replicaCoordinator.state;
    },
    reconnect: () => replicaCoordinator.reconnect(),
    mutate: (mutator) => replicaCoordinator.mutate(mutator),
  };
  return { coordinator, local, primary };
}

function browserVaultDeviceId(userId: string, keyId: string): string {
  const storageKey = `bettertrack:vault-device:${userId}:${keyId}`;
  try {
    const stored = globalThis.localStorage?.getItem(storageKey);
    if (stored) return stored;
    const created = globalThis.crypto.randomUUID();
    globalThis.localStorage?.setItem(storageKey, created);
    return created;
  } catch {
    return globalThis.crypto.randomUUID();
  }
}

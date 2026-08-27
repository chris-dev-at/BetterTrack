import { webcrypto } from 'node:crypto';

import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ParanoidMediaStateResponse,
  VaultDocument,
  VaultEntity,
  VaultEnvelopeHeader,
  VaultMedium,
  VaultMirrorProvenance,
} from '@bettertrack/contracts';

import { base64ToBytes } from '../bytes';
import type {
  DataHome,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import { decryptVaultDocument, encryptVaultDocument } from '../crypto';
import type { DriveDataHome, GoogleDriveTokenClient } from '../drive';
import { VaultCryptoError } from '../errors';
import { inspectVaultEnvelope } from '../envelope';
import type { VaultSyncCandidate, VaultSyncState } from '../sync';
import { vaultInteroperabilityFixture as fixture } from '@bettertrack/domain/vaultVectors';
import type { VaultMediaApi } from './mediaSwitcher';
import {
  createVaultRetirementProofManager,
  type VaultRetirementProofManager,
} from './retirementProof';
import { createUnlockedVaultDriveRuntime, type VaultDriveSyncCoordinator } from './runtime';

const baseDocument: VaultDocument = {
  schemaVersion: 1,
  entities: {},
  mergeLog: [],
  mirrorProvenance: [],
};
const securedDocument: VaultDocument = {
  ...baseDocument,
  schemaVersion: 2,
  clientSecurity: {
    retirementProof: {
      publicKey: 'public-proof',
      privateKey: 'private-proof',
    },
  },
};

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('unlocked Drive runtime', () => {
  it('commits proof material through the existing coordinator before becoming ready', async () => {
    const sync = coordinator('synced');
    const proof = proofManager();
    const runtime = createUnlockedVaultDriveRuntime(
      new Uint8Array(32).fill(1),
      fixture.initial.header.keyId,
      dependencies(sync, proof),
    );

    await expect(runtime.ready).resolves.toBeUndefined();

    expect(sync.reconnect).toHaveBeenCalledTimes(1);
    expect(sync.mutate).toHaveBeenCalledTimes(1);
    expect(proof.ensure).toHaveBeenCalledTimes(2);
    expect(proof.publicKey).toBe('public-proof');
  });

  /**
   * §7.1: the capture read runs on EVERY unlocked session, which is what gets the
   * severed-fork identity map into the ciphertext before the enable wizard's
   * `enable()` purges `mirror_rows`. An empty read (every paranoid-mode session,
   * every account without a fork) must not cost a vault version.
   */
  it('folds the severed-fork identity map into the document while unlocking', async () => {
    const entry: VaultMirrorProvenance = {
      chainId: '018f0000-0000-7000-8000-0000000000f1',
      membershipId: '018f0000-0000-7000-8000-0000000000f2',
      kind: 'transaction',
      mirrorId: '018f0000-0000-7000-8000-0000000000f3',
      portfolioId: '018f0000-0000-7000-8000-0000000000f4',
      localId: '018f0000-0000-7000-8000-000000000042',
    };
    // The fold only keeps identities naming a LIVE row, so the fork's row has to
    // be in the document — exactly as it is after the pre-enable capture.
    const sync = coordinator('synced', 'synced', {
      ...baseDocument,
      entities: { transaction: [concurrentTransaction()] },
    });
    const captured = createUnlockedVaultDriveRuntime(
      new Uint8Array(32).fill(1),
      fixture.initial.header.keyId,
      dependencies(sync, proofManager(), async () => [entry]),
    );

    await expect(captured.ready).resolves.toBeUndefined();
    // The proof-material mutation plus this one; the fold names a live row, so it
    // survives the encrypt-time prune.
    expect(sync.mutate).toHaveBeenCalledTimes(2);
    expect(sync.state.active?.document.mirrorProvenance).toEqual([entry]);

    const emptySync = coordinator('synced');
    const empty = createUnlockedVaultDriveRuntime(
      new Uint8Array(32).fill(1),
      fixture.initial.header.keyId,
      dependencies(emptySync, proofManager()),
    );
    await expect(empty.ready).resolves.toBeUndefined();
    expect(emptySync.mutate).toHaveBeenCalledTimes(1);
  });

  /**
   * An unreachable capture read must not block unlocking an already-encrypted
   * vault: Drive-only can be readable while the API is not, and in paranoid mode
   * there is nothing left to capture anyway. The next unlock retries.
   */
  it('still unlocks when the capture read is unreachable', async () => {
    const sync = coordinator('synced');
    const runtime = createUnlockedVaultDriveRuntime(
      new Uint8Array(32).fill(1),
      fixture.initial.header.keyId,
      dependencies(sync, proofManager(), async () => {
        throw new Error('offline');
      }),
    );

    await expect(runtime.ready).resolves.toBeUndefined();
    expect(sync.mutate).toHaveBeenCalledTimes(1);
  });

  it('adds proof material to the document refreshed after a concurrent transaction', async () => {
    const vaultKey = base64ToBytes(fixture.vaultKeyBase64, 'envelope-invalid');
    const initial = base64ToBytes(fixture.initial.envelopeBase64, 'envelope-invalid');
    const initialHeader = fixture.initial.header as VaultEnvelopeHeader;
    const opened = await decryptVaultDocument(initial, vaultKey);
    const transaction = concurrentTransaction();
    const concurrentDocument: VaultDocument = {
      ...opened.document,
      entities: {
        ...opened.document.entities,
        portfolio: [...(opened.document.entities.portfolio ?? []), concurrentPortfolio()],
        transaction: [...(opened.document.entities.transaction ?? []), transaction],
      },
    };
    const concurrent = (
      await encryptVaultDocument({
        document: concurrentDocument,
        vaultKey,
        header: {
          keyId: initialHeader.keyId,
          wrappedKeys: initialHeader.wrappedKeys,
          vaultVersion: 2,
          deviceId: '018f0000-0000-7000-8000-000000000046',
          writeId: '018f0000-0000-7000-8000-000000000047',
          writtenAt: '2026-07-28T10:00:01.000Z',
        },
      })
    ).envelope;
    const server = new RuntimeRemote('server', initial);
    const drive = new RuntimeDrive(initial);
    const ensureStarted = deferred<void>();
    const resumeEnsure = deferred<void>();
    const proofDelegate = createVaultRetirementProofManager(
      webcrypto.subtle as unknown as SubtleCrypto,
    );
    const proof: VaultRetirementProofManager = {
      get publicKey() {
        return proofDelegate.publicKey;
      },
      ensure: vi.fn(async (document) => {
        ensureStarted.resolve(undefined);
        await resumeEnsure.promise;
        return proofDelegate.ensure(document);
      }),
      sign: vi.fn((input) => proofDelegate.sign(input)),
      clear: vi.fn(() => proofDelegate.clear()),
    };
    const runtime = createUnlockedVaultDriveRuntime(vaultKey, fixture.initial.header.keyId, {
      userId: crypto.randomUUID(),
      clientId: 'browser-client-id',
      tokens: tokenClient(),
      server,
      drive,
      api: replicatedApi(version(initial)),
      retirementProof: proof,
    });

    const ready = runtime.ready;
    await ensureStarted.promise;
    server.envelope = concurrent.slice();
    drive.envelope = concurrent.slice();
    resumeEnsure.resolve(undefined);
    await expect(ready).resolves.toBeUndefined();

    expect(server.envelope).toEqual(drive.envelope);
    const committed = await decryptVaultDocument(server.envelope!, vaultKey);
    expect(committed.document).toMatchObject({
      schemaVersion: 2,
      clientSecurity: { retirementProof: {} },
    });
    expect(committed.document.entities.transaction).toEqual(expect.arrayContaining([transaction]));
    runtime.dispose();
  });

  it('fails closed when another device enrolls different proof material first', async () => {
    const concurrentDocument: VaultDocument = {
      ...securedDocument,
      clientSecurity: {
        retirementProof: {
          publicKey: 'other-public-proof',
          privateKey: 'other-private-proof',
        },
      },
    };
    const sync = coordinator('synced');
    vi.mocked(sync.mutate).mockImplementationOnce(async (mutator) => {
      const document = mutator({ document: concurrentDocument, currentVersion: 2 });
      return syncState('synced', document);
    });
    const runtime = createUnlockedVaultDriveRuntime(
      new Uint8Array(32).fill(1),
      fixture.initial.header.keyId,
      dependencies(sync, proofManager()),
    );

    await expect(runtime.ready).rejects.toMatchObject({
      code: 'document-invalid',
      message: expect.stringMatching(/changed during enrollment/i),
    });
  });

  it('fails closed when proof material remains pending on a selected medium', async () => {
    const sync = coordinator('synced', 'pending-offline');
    const proof = proofManager();
    const runtime = createUnlockedVaultDriveRuntime(
      new Uint8Array(32).fill(1),
      fixture.initial.header.keyId,
      dependencies(sync, proof),
    );

    await expect(runtime.ready).rejects.toThrow(/not durably synchronized/i);
    expect(proof.ensure).toHaveBeenCalledTimes(1);
  });

  it('opens a readable local vault offline while keeping storage changes sync-gated', async () => {
    const sync = coordinator('pending-offline', 'pending-offline', securedDocument);
    const runtime = createUnlockedVaultDriveRuntime(
      new Uint8Array(32).fill(1),
      fixture.initial.header.keyId,
      dependencies(sync, proofManager()),
    );

    await expect(runtime.ready).resolves.toBeUndefined();
    await expect(runtime.sync.mutate(({ document }) => document)).resolves.toMatchObject({
      status: 'pending-offline',
      active: {},
      pending: {},
    });
    await expect(runtime.controller.useDriveOnly()).resolves.toMatchObject({
      status: 'failed',
      stage: 'preflight-sync',
      synchronization: { status: 'pending', state: { status: 'pending-offline' } },
    });
  });

  it.each(['pending-offline', 'conflict'] as const)(
    'preserves a committed media result when resume resolves %s',
    async (status) => {
      const synced = syncState('synced', securedDocument);
      const unresolved = syncState(status, securedDocument);
      let current = synced;
      let reconnects = 0;
      const sync: VaultDriveSyncCoordinator = {
        deviceId: 'test-device',
        get state() {
          return current;
        },
        reconnect: vi.fn(async () => {
          // Pass 0 is `ready()`, pass 1 is the action preflight; only the
          // post-commit pass resolves unsynchronized here.
          current = reconnects++ < 2 ? synced : unresolved;
          return current;
        }),
        mutate: vi.fn(),
      };
      const api = {
        ...unusedApi(),
        getState: vi.fn(
          async (): Promise<ParanoidMediaStateResponse> => ({
            privacyMode: 'paranoid',
            mediaState: {
              mediaSet: ['server', 'drive'],
              driveAttestedVersion: 1,
              server: { disposition: 'active', candidate: null, retired: null },
            },
          }),
        ),
      };
      const runtime = createUnlockedVaultDriveRuntime(
        new Uint8Array(32).fill(1),
        fixture.initial.header.keyId,
        { ...dependencies(sync, proofManager()), api },
      );

      await expect(runtime.controller.connect()).resolves.toMatchObject({
        status: 'noop',
        synchronization: {
          status: 'pending',
          state: { status, active: {}, pending: {} },
        },
      });
      expect(runtime.syncState).toEqual(unresolved);
      runtime.dispose();
    },
  );

  it('never changes the media set while a later action finds an unsynchronized replica', async () => {
    // `ready()` is memoized per unlocked runtime, so a second storage action
    // would otherwise skip reconciliation entirely and migrate/retire around a
    // pending offline mutation.
    const synced = syncState('synced', securedDocument);
    const unresolved = syncState('pending-offline', securedDocument);
    let current = synced;
    let reconnects = 0;
    const sync: VaultDriveSyncCoordinator = {
      deviceId: 'test-device',
      get state() {
        return current;
      },
      reconnect: vi.fn(async () => {
        current = reconnects++ === 0 ? synced : unresolved;
        return current;
      }),
      mutate: vi.fn(),
    };
    const api = { ...unusedApi(), getState: vi.fn() };
    const runtime = createUnlockedVaultDriveRuntime(
      new Uint8Array(32).fill(1),
      fixture.initial.header.keyId,
      { ...dependencies(sync, proofManager()), api },
    );

    await expect(runtime.ready).resolves.toBeUndefined();

    await expect(runtime.controller.useDriveOnly()).resolves.toMatchObject({
      status: 'failed',
      stage: 'preflight-sync',
      media: null,
      synchronization: { status: 'pending', state: { status: 'pending-offline' } },
    });

    // The switcher was never reached, so no durable media state was even read.
    expect(api.getState).not.toHaveBeenCalled();
    expect(sync.reconnect).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('fails the exposed sync seam locked once the runtime is disposed', async () => {
    const sync = coordinator('synced');
    const runtime = createUnlockedVaultDriveRuntime(
      new Uint8Array(32).fill(1),
      fixture.initial.header.keyId,
      dependencies(sync, proofManager()),
    );
    await expect(runtime.ready).resolves.toBeUndefined();
    const seam = runtime.sync;
    expect(seam.deviceId).toBe('test-device');
    expect(seam.state.status).toBe('synced');

    runtime.dispose();

    expect(() => seam.state).toThrowError(VaultCryptoError);
    await expect(seam.reconnect()).rejects.toMatchObject({ code: 'locked' });
    await expect(
      seam.mutate(() => {
        throw new Error('a disposed seam must fail before invoking the mutator');
      }),
    ).rejects.toMatchObject({ code: 'locked' });
    // Only the ready() reconciliation ever reached the live coordinator.
    expect(sync.reconnect).toHaveBeenCalledTimes(1);
    expect(sync.mutate).toHaveBeenCalledTimes(1);
  });

  it('stops proof enrollment when the runtime is disposed during reconciliation', async () => {
    const reconnect = deferred<VaultSyncState>();
    const sync = coordinator('synced');
    vi.mocked(sync.reconnect).mockImplementationOnce(() => reconnect.promise);
    const proof = proofManager();
    const runtime = createUnlockedVaultDriveRuntime(
      new Uint8Array(32).fill(1),
      fixture.initial.header.keyId,
      dependencies(sync, proof),
    );

    const ready = runtime.ready;
    await vi.waitFor(() => expect(sync.reconnect).toHaveBeenCalledTimes(1));
    runtime.dispose();
    reconnect.resolve(syncState('synced', baseDocument));

    await expect(ready).rejects.toThrow(/disposed/i);
    expect(proof.ensure).not.toHaveBeenCalled();
    expect(sync.mutate).not.toHaveBeenCalled();
  });

  it.each(['absent', 'transport-failure', 'corrupt'] as const)(
    'keeps a server-first %s authoritative through runtime.syncState until repair',
    async (failure) => {
      const initial = base64ToBytes(fixture.initial.envelopeBase64, 'envelope-invalid');
      const server = new RuntimeRemote('server', initial);
      const drive = new RuntimeDrive(initial);
      if (failure === 'absent') server.envelope = null;
      if (failure === 'transport-failure') server.failure = true;
      if (failure === 'corrupt') server.corrupt = true;
      const api = replicatedApi(version(initial));
      const runtime = createUnlockedVaultDriveRuntime(
        base64ToBytes(fixture.vaultKeyBase64, 'envelope-invalid'),
        fixture.initial.header.keyId,
        {
          userId: crypto.randomUUID(),
          clientId: 'browser-client-id',
          tokens: tokenClient(),
          server,
          drive,
          api,
          retirementProof: proofManager(),
        },
      );

      const reconnect = await runtime.reconnect();

      expect(reconnect).toMatchObject({
        status: 'pending-offline',
        active: { header: { vaultVersion: 1 } },
        pending: { header: { vaultVersion: 1 } },
      });
      expect(runtime.syncState).toEqual(reconnect);

      server.envelope ??= initial.slice();
      server.failure = false;
      server.corrupt = false;
      const repaired = await runtime.reconnect();

      expect(repaired).toMatchObject({ status: 'synced', pending: null });
      expect(runtime.syncState).toEqual(repaired);
      runtime.dispose();
    },
  );
});

class RuntimeRemote implements DataHome {
  envelope: Uint8Array | null;
  failure = false;
  corrupt = false;

  constructor(
    readonly medium: VaultMedium,
    envelope: Uint8Array | null,
  ) {
    this.envelope = envelope?.slice() ?? null;
  }

  async read(): Promise<DataHomeReadResult> {
    if (this.failure) {
      return {
        status: 'transport-failure',
        medium: this.medium,
        failure: { code: 'offline', message: `${this.medium} offline` },
      };
    }
    if (this.corrupt) {
      return {
        status: 'corrupt',
        medium: this.medium,
        envelope: this.envelope?.slice(),
        version: this.envelope ? version(this.envelope) : null,
        updatedAt: null,
        reason: 'corrupt-bytes',
        message: `${this.medium} corrupt`,
      };
    }
    if (!this.envelope) return { status: 'absent', medium: this.medium };
    return {
      status: 'ok',
      medium: this.medium,
      envelope: this.envelope.slice(),
      info: runtimeInfo(this.medium, this.envelope),
    };
  }

  async write(
    envelope: Uint8Array,
    { ifVersion }: DataHomeWriteOptions,
  ): Promise<DataHomeWriteResult> {
    const currentVersion = this.envelope ? version(this.envelope) : null;
    if (currentVersion !== ifVersion) {
      return { status: 'conflict', medium: this.medium, currentVersion };
    }
    this.envelope = envelope.slice();
    return {
      status: 'ok',
      medium: this.medium,
      info: runtimeInfo(this.medium, envelope),
    };
  }

  async info(): Promise<DataHomeInfoResult> {
    const result = await this.read();
    return result.status === 'ok'
      ? { status: 'ok', medium: this.medium, info: result.info }
      : result;
  }
}

class RuntimeDrive extends RuntimeRemote implements DriveDataHome {
  override readonly medium = 'drive' as const;

  constructor(envelope: Uint8Array | null) {
    super('drive', envelope);
  }

  async observeReplicas() {
    return {
      observations: [await this.read()],
      async converge() {
        throw new Error('The single-file test Drive cannot converge duplicates.');
      },
      async deleteIfUnchanged() {
        throw new Error('Replica cleanup is not used by this runtime test.');
      },
    };
  }
}

function coordinator(
  reconnectStatus: VaultSyncState['status'],
  mutateStatus: VaultSyncState['status'] = 'synced',
  initialDocument: VaultDocument = baseDocument,
): VaultDriveSyncCoordinator {
  let state = syncState(reconnectStatus, initialDocument);
  const sync: VaultDriveSyncCoordinator = {
    deviceId: 'test-device',
    get state() {
      return state;
    },
    reconnect: vi.fn(async () => state),
    mutate: vi.fn(async (mutator) => {
      const document = mutator({ document: state.active!.document, currentVersion: 1 });
      state = syncState(mutateStatus, document);
      return state;
    }),
  };
  return sync;
}

function syncState(status: VaultSyncState['status'], document: VaultDocument): VaultSyncState {
  const active = candidate(document);
  return {
    status,
    active,
    pending: status === 'synced' ? null : active,
  };
}

function candidate(document: VaultDocument): VaultSyncCandidate {
  return {
    home: dataHome('local'),
    envelope: new Uint8Array([1]),
    header: fixture.initial.header as VaultEnvelopeHeader,
    document,
  };
}

function concurrentTransaction(): VaultEntity {
  return {
    id: '018f0000-0000-7000-8000-000000000042',
    rev: 0,
    editedAt: '2026-07-28T10:00:00.000Z',
    editedBy: '018f0000-0000-7000-8000-000000000043',
    deletedAt: null,
    data: {
      portfolioId: '018f0000-0000-7000-8000-000000000044',
      assetId: '018f0000-0000-7000-8000-000000000045',
      side: 'buy',
      quantity: '1',
      price: '10',
      fee: '0',
      executedAt: '2026-07-28T10:00:00.000Z',
      note: null,
      taxMode: null,
      taxCountry: null,
      taxAmountEur: null,
      taxParams: null,
      allowUncovered: false,
      uncoveredEntryPrice: null,
      source: 'manual',
    },
  };
}

function concurrentPortfolio(): VaultEntity {
  return {
    id: '018f0000-0000-7000-8000-000000000044',
    rev: 0,
    editedAt: '2026-07-28T10:00:00.000Z',
    editedBy: '018f0000-0000-7000-8000-000000000043',
    deletedAt: null,
    data: {
      userId: '018f0000-0000-7000-8000-000000000048',
      name: 'Concurrent portfolio',
      visibility: 'private',
      sortOrder: 0,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  };
}

function proofManager(): VaultRetirementProofManager {
  let publicKey: string | null = null;
  return {
    get publicKey() {
      return publicKey;
    },
    ensure: vi.fn(async (document) => {
      if (document.clientSecurity) {
        publicKey = 'public-proof';
        return { document, changed: false };
      }
      publicKey = 'public-proof';
      return { document: securedDocument, changed: true };
    }),
    sign: vi.fn(async () => 'signature'),
    clear: vi.fn(() => {
      publicKey = null;
    }),
  };
}

function dependencies(
  sync: VaultDriveSyncCoordinator,
  retirementProof: VaultRetirementProofManager,
  forkProvenance: () => Promise<readonly VaultMirrorProvenance[]> = async () => [],
) {
  return {
    userId: '018f0000-0000-7000-8000-000000000099',
    clientId: 'browser-client-id',
    tokens: tokenClient(),
    server: dataHome('server'),
    drive: driveHome(),
    api: unusedApi(),
    sync,
    retirementProof,
    forkProvenance,
  };
}

function tokenClient(): GoogleDriveTokenClient {
  return {
    state: 'connected',
    getAccessToken: () => ({
      status: 'ok',
      accessToken: 'memory-only',
      expiresAt: Date.now() + 60_000,
    }),
    subscribe: vi.fn(() => () => undefined),
    prepare: vi.fn(async () => undefined),
    authorize: async () => ({
      status: 'ok',
      accessToken: 'memory-only',
      expiresAt: Date.now() + 60_000,
    }),
    clear: vi.fn(),
    markExpired: vi.fn(),
    markRevoked: vi.fn(),
    identify: vi.fn(),
  };
}

function dataHome(medium: 'local' | 'server'): DataHome {
  return {
    medium,
    read: vi.fn(),
    write: vi.fn(),
    info: vi.fn(),
  };
}

function driveHome(): DriveDataHome {
  return {
    ...dataHome('server'),
    medium: 'drive',
    async observeReplicas() {
      return {
        observations: [await this.read()],
        async converge() {
          throw new Error('The single-file test Drive cannot converge duplicates.');
        },
        async deleteIfUnchanged() {
          throw new Error('Replica cleanup is not used by this runtime test.');
        },
      };
    },
  };
}

function unusedApi(): VaultMediaApi {
  return {
    getState: vi.fn(),
    transition: vi.fn(),
    stageServerCandidate: vi.fn(),
    readServerCandidate: vi.fn(),
    requestPurgeChallenge: vi.fn(),
    purgeRetired: vi.fn(),
  };
}

function replicatedApi(driveVersion: number): VaultMediaApi {
  const response: ParanoidMediaStateResponse = {
    privacyMode: 'paranoid',
    mediaState: {
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: driveVersion,
      server: { disposition: 'active', candidate: null, retired: null },
    },
  };
  return {
    ...unusedApi(),
    getState: vi.fn(async () => structuredClone(response)),
  };
}

function version(envelope: Uint8Array): number {
  const inspected = inspectVaultEnvelope(envelope);
  if (inspected.status !== 'supported') throw new Error('unsupported test envelope');
  return inspected.envelope.header.vaultVersion;
}

function runtimeInfo(medium: VaultMedium, envelope: Uint8Array) {
  const inspected = inspectVaultEnvelope(envelope);
  if (inspected.status !== 'supported') throw new Error('unsupported test envelope');
  return {
    medium,
    version: inspected.envelope.header.vaultVersion,
    sizeBytes: envelope.byteLength,
    updatedAt: inspected.envelope.header.writtenAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

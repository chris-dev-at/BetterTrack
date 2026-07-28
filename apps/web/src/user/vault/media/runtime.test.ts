import { webcrypto } from 'node:crypto';

import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ParanoidMediaStateResponse,
  VaultDocument,
  VaultEnvelopeHeader,
  VaultMedium,
} from '@bettertrack/contracts';

import { base64ToBytes } from '../bytes';
import type {
  DataHome,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import type { DriveDataHome, DriveDeleteResult, GoogleDriveTokenClient } from '../drive';
import { inspectVaultEnvelope } from '../envelope';
import type { VaultSyncCandidate, VaultSyncState } from '../sync';
import fixture from '../vectors.fixture.json';
import type { VaultMediaApi } from './mediaSwitcher';
import type { VaultRetirementProofManager } from './retirementProof';
import { createUnlockedVaultDriveRuntime, type VaultDriveSyncCoordinator } from './runtime';

const baseDocument: VaultDocument = { schemaVersion: 1, entities: {}, mergeLog: [] };
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

  async delete(): Promise<DriveDeleteResult> {
    const deleted = this.envelope != null;
    this.envelope = null;
    return { status: 'ok', deleted };
  }
}

function coordinator(
  reconnectStatus: VaultSyncState['status'],
  mutateStatus: VaultSyncState['status'] = 'synced',
): VaultDriveSyncCoordinator {
  let state = syncState(reconnectStatus, baseDocument);
  const sync: VaultDriveSyncCoordinator = {
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
    authorize: async () => ({
      status: 'ok',
      accessToken: 'memory-only',
      expiresAt: Date.now() + 60_000,
    }),
    clear: vi.fn(),
    markExpired: vi.fn(),
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
    delete: vi.fn(),
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

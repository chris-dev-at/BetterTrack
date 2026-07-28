import { describe, expect, it, vi } from 'vitest';

import type { VaultDocumentV1, VaultEnvelopeHeader } from '@bettertrack/contracts';

import type { DataHome } from '../dataHome';
import type { DriveDataHome, GoogleDriveTokenClient } from '../drive';
import type { VaultSyncCandidate, VaultSyncState } from '../sync';
import fixture from '../vectors.fixture.json';
import type { VaultMediaApi } from './mediaSwitcher';
import type { VaultRetirementProofManager } from './retirementProof';
import { createUnlockedVaultDriveRuntime, type VaultDriveSyncCoordinator } from './runtime';

const baseDocument: VaultDocumentV1 = { schemaVersion: 1, entities: {}, mergeLog: [] };
const securedDocument: VaultDocumentV1 = {
  ...baseDocument,
  clientSecurity: {
    retirementProof: {
      publicKey: 'public-proof',
      privateKey: 'private-proof',
    },
  },
};

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
});

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

function syncState(status: VaultSyncState['status'], document: VaultDocumentV1): VaultSyncState {
  const active = candidate(document);
  return {
    status,
    active,
    pending: status === 'synced' ? null : active,
  };
}

function candidate(document: VaultDocumentV1): VaultSyncCandidate {
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

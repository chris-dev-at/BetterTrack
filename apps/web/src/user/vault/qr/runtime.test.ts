import { describe, expect, it, vi } from 'vitest';

import type { DriveConnection, VaultConfig } from '@bettertrack/contracts';

import type { VaultDriveHeaderReader } from './driveHeader';
import { createVaultTransferRuntime } from './runtime';

const VAULT: VaultConfig = {
  id: '018f6a3e-1111-7000-8000-000000000001',
  name: 'Phone vault',
  headerDocId: '018f6a3e-2222-7000-8000-000000000001',
  commonDocId: '018f6a3e-2222-7000-8000-000000000002',
  media: ['server'],
  driveConnectionId: null,
  keyFingerprint: 'AbCdEfGhIjKlMn_o',
  retirementProofPublicKey: 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  retirementGeneration: 0,
  mediaAttestedAt: null,
  mediaAttestedDriveConnectionId: null,
  createdAt: '2026-08-20T12:00:00.000Z',
  updatedAt: '2026-08-20T12:00:00.000Z',
};

const CONNECTION: DriveConnection = {
  id: '018f6a3e-6666-7000-8000-000000000001',
  googleSub: 'google-permission-id',
  email: 'vault-owner@example.test',
  displayName: 'Vault owner',
  createdAt: '2026-08-20T12:00:00.000Z',
  lastVerifiedAt: '2026-08-20T12:00:00.000Z',
};

const DRIVE_VAULT: VaultConfig = {
  ...VAULT,
  media: ['drive'],
  driveConnectionId: CONNECTION.id,
};

function driveReader(envelope = new Uint8Array([7, 8, 9])): VaultDriveHeaderReader {
  return {
    readHeader: vi.fn(async () => envelope.slice()),
    clear: vi.fn(),
  };
}

describe('vault transfer production runtime', () => {
  it('lists account vaults and fetches the registered raw header document', async () => {
    const requestJson = vi.fn(async (path: string) =>
      path === '/vaults' ? { vaults: [VAULT] } : { vault: VAULT },
    );
    const requestRaw = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const runtime = createVaultTransferRuntime({
      requestJson,
      fetch: requestRaw as typeof globalThis.fetch,
      apiBase: 'https://api.example.test/api/v1',
      bindLockSignal: false,
    });

    await expect(runtime.listVaults()).resolves.toEqual([VAULT]);
    await expect(runtime.fetchHeaderEnvelope({ vaultId: VAULT.id })).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );

    expect(requestJson).toHaveBeenNthCalledWith(1, '/vaults');
    expect(requestJson).toHaveBeenNthCalledWith(2, `/vaults/${VAULT.id}`);
    expect(requestRaw).toHaveBeenCalledWith(
      `https://api.example.test/api/v1/vaults/${VAULT.id}/docs/${VAULT.headerDocId}`,
      { credentials: 'include', cache: 'no-store' },
    );

    runtime.registerOpenedVault({
      vaultId: VAULT.id,
      keyId: '018f6a3e-3333-7000-8000-000000000001',
      keyFingerprint: VAULT.keyFingerprint,
    });
    expect(runtime.isVaultOpen(VAULT.id)).toBe(true);
    runtime.endSession();
    expect(runtime.isVaultOpen(VAULT.id)).toBe(false);
  });

  it('reads a Drive-only header through the vault-bound Drive connection', async () => {
    const reader = driveReader();
    const requestJson = vi.fn(async (path: string) =>
      path === '/drive-connections' ? { connections: [CONNECTION] } : { vault: DRIVE_VAULT },
    );
    const requestRaw = vi.fn();
    const runtime = createVaultTransferRuntime({
      accountId: '018f6a3e-0000-7000-8000-00000000aaaa',
      requestJson,
      fetch: requestRaw as typeof globalThis.fetch,
      driveHeaderReader: reader,
      bindLockSignal: false,
    });

    await expect(runtime.fetchHeaderEnvelope({ vaultId: DRIVE_VAULT.id })).resolves.toEqual(
      new Uint8Array([7, 8, 9]),
    );

    expect(requestRaw).not.toHaveBeenCalled();
    expect(reader.readHeader).toHaveBeenCalledWith({
      accountId: '018f6a3e-0000-7000-8000-00000000aaaa',
      connection: CONNECTION,
      vaultId: DRIVE_VAULT.id,
      docId: DRIVE_VAULT.headerDocId,
    });
  });

  it('falls back from an unavailable server header to the bound Drive copy', async () => {
    const reader = driveReader(new Uint8Array([4, 5, 6]));
    const dualVault: VaultConfig = { ...DRIVE_VAULT, media: ['server', 'drive'] };
    const requestJson = vi.fn(async (path: string) =>
      path === '/drive-connections' ? { connections: [CONNECTION] } : { vault: dualVault },
    );
    const requestRaw = vi.fn(async () => new Response(null, { status: 503 }));
    const runtime = createVaultTransferRuntime({
      accountId: '018f6a3e-0000-7000-8000-00000000aaaa',
      requestJson,
      fetch: requestRaw as typeof globalThis.fetch,
      driveHeaderReader: reader,
      bindLockSignal: false,
      apiBase: 'https://api.example.test/api/v1',
    });

    await expect(runtime.fetchHeaderEnvelope({ vaultId: dualVault.id })).resolves.toEqual(
      new Uint8Array([4, 5, 6]),
    );

    expect(requestRaw).toHaveBeenCalledOnce();
    expect(reader.readHeader).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { VaultConfig } from '@bettertrack/contracts';

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
  });
});

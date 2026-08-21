import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateVaultRequest, VaultConfig } from '@bettertrack/contracts';

const VAULT_ID = '018f0000-0000-7000-8000-000000000001';
const mocks = vi.hoisted(() => ({
  createVault: vi.fn(),
  createVaultDocument: vi.fn(),
  readVaultHeaderDocument: vi.fn(),
  transitionVaultMedia: vi.fn(),
  storeAfterVerifiedOpen: vi.fn(),
  storePlainAfterVerifiedOpen: vi.fn(),
  clearProof: vi.fn(),
}));

vi.mock('../../lib/vaultApi', () => ({
  createVault: mocks.createVault,
  createVaultDocument: mocks.createVaultDocument,
  readVaultHeaderDocument: mocks.readVaultHeaderDocument,
  transitionVaultMedia: mocks.transitionVaultMedia,
}));
vi.mock('./keystore/runtime', () => ({
  endpointVaultKeystore: {
    storeAfterVerifiedOpen: mocks.storeAfterVerifiedOpen,
    storePlainAfterVerifiedOpen: mocks.storePlainAfterVerifiedOpen,
  },
}));
vi.mock('./media/retirementProof', () => ({
  createVaultRetirementProofManager: () => ({
    clear: mocks.clearProof,
    ensure: async (document: object) => ({
      changed: true,
      document: {
        ...document,
        schemaVersion: 2,
        clientSecurity: {
          retirementProof: { privateKey: 'private-proof', publicKey: 'public-proof' },
        },
      },
    }),
  }),
}));

import { provisionVault, VaultProvisionIncompleteError } from './provisionVault';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createVault.mockImplementation(
    async (body: CreateVaultRequest): Promise<VaultConfig> => ({
      id: VAULT_ID,
      name: body.name,
      headerDocId: body.headerDocId,
      commonDocId: body.commonDocId,
      media: body.media,
      driveConnectionId: body.driveConnectionId,
      keyFingerprint: body.keyFingerprint,
      retirementProofPublicKey: body.retirementProofPublicKey,
      retirementGeneration: 0,
      mediaAttestedAt: null,
      mediaAttestedDriveConnectionId: null,
      createdAt: '2026-08-21T10:00:00.000Z',
      updatedAt: '2026-08-21T10:00:00.000Z',
    }),
  );
  mocks.createVaultDocument.mockResolvedValue(undefined);
  mocks.transitionVaultMedia.mockResolvedValue({
    vaultId: VAULT_ID,
    media: ['server'],
    driveConnectionId: null,
    mediaAttestedAt: '2026-08-21T10:01:00.000Z',
    mediaAttestedDriveConnectionId: null,
    server: { disposition: 'active', candidates: [], retirement: null },
  });
  mocks.storeAfterVerifiedOpen.mockResolvedValue({
    vaultId: VAULT_ID,
    keyId: 'key',
    keyFingerprint: 'fingerprint',
  });
});

describe('provisionVault', () => {
  it('writes and attests the complete initial server document roster before storing custody', async () => {
    const vault = await provisionVault({
      accountId: '018f0000-0000-7000-8000-000000000099',
      name: 'Long-term',
      media: ['server'],
      driveConnectionId: null,
      mnemonic: PHRASE,
      custody: 'wrapped',
      devicePassword: 'device-secret',
      plainRiskAcknowledged: false,
    });

    expect(mocks.createVaultDocument).toHaveBeenCalledTimes(2);
    const createRequest = mocks.createVault.mock.calls[0]![0] as CreateVaultRequest;
    const transitionRequest = mocks.transitionVaultMedia.mock.calls[0]![1] as {
      transitionId: string;
      verification: { kind: 'server'; docs: { writeId: string }[] };
    };
    for (const id of [
      createRequest.headerDocId,
      createRequest.commonDocId,
      transitionRequest.transitionId,
      ...transitionRequest.verification.docs.map(({ writeId }) => writeId),
    ]) {
      expect(id[14]).toBe('7');
    }
    expect(mocks.transitionVaultMedia).toHaveBeenCalledWith(
      VAULT_ID,
      expect.objectContaining({
        transitionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        expected: {
          media: ['server'],
          driveConnectionId: null,
          mediaAttestedAt: null,
        },
        next: { media: ['server'], driveConnectionId: null },
        verification: {
          kind: 'server',
          docs: expect.arrayContaining([
            expect.objectContaining({ docVersion: 1, writeId: expect.any(String) }),
            expect.objectContaining({ docVersion: 1, writeId: expect.any(String) }),
          ]),
        },
      }),
    );
    expect(mocks.storeAfterVerifiedOpen).toHaveBeenCalledOnce();
    expect(vault.mediaAttestedAt).toBe('2026-08-21T10:01:00.000Z');
    expect(mocks.clearProof).toHaveBeenCalledOnce();
  });

  it('refuses unavailable Drive provisioning before creating a server config', async () => {
    await expect(
      provisionVault({
        accountId: '018f0000-0000-7000-8000-000000000099',
        name: 'Drive',
        media: ['drive'],
        driveConnectionId: '018f0000-0000-7000-8000-000000000088',
        mnemonic: PHRASE,
        custody: 'wrapped',
        devicePassword: 'device-secret',
        plainRiskAcknowledged: false,
      }),
    ).rejects.toThrow('per-vault-drive-provisioning-unavailable');
    expect(mocks.createVault).not.toHaveBeenCalled();
  });

  it('reports a failure past createVault as an unfinished vault, naming the leftover', async () => {
    const cause = new Error('document-write-failed');
    mocks.createVaultDocument.mockRejectedValue(cause);

    const failure = await provisionVault({
      accountId: '018f0000-0000-7000-8000-000000000099',
      name: 'Long-term',
      media: ['server'],
      driveConnectionId: null,
      mnemonic: PHRASE,
      custody: 'wrapped',
      devicePassword: 'device-secret',
      plainRiskAcknowledged: false,
    }).catch((error: unknown) => error);

    // The row exists, so "try again" is the wrong instruction: the caller needs
    // to know WHICH empty vault was left behind.
    expect(failure).toBeInstanceOf(VaultProvisionIncompleteError);
    expect((failure as VaultProvisionIncompleteError).vaultName).toBe('Long-term');
    expect((failure as VaultProvisionIncompleteError).cause).toBe(cause);
    expect(mocks.storeAfterVerifiedOpen).not.toHaveBeenCalled();
    expect(mocks.clearProof).toHaveBeenCalledOnce();
  });
});

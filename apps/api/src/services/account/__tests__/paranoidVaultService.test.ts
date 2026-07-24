import { encodeVaultEnvelope, VAULT_CONTENT_CIPHER } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type {
  ParanoidVaultCasInput,
  ParanoidVaultCasResult,
  ParanoidVaultRepository,
} from '../../../data/repositories/paranoidVaultRepository';
import type { ParanoidVaultRow } from '../../../data/schema';
import { createParanoidVaultService } from '../paranoidVaultService';

const UUID_A = '018f0000-0000-7000-8000-00000000000a';
const UUID_B = '018f0000-0000-7000-8000-00000000000b';
const UUID_C = '018f0000-0000-7000-8000-00000000000c';

function envelope(vaultVersion: number, ciphertext: Uint8Array): Buffer {
  const header = {
    formatVersion: 1,
    cipher: VAULT_CONTENT_CIPHER,
    iv: 'aXYtOTZiaXQ=',
    keyId: UUID_A,
    wrappedKeys: [
      {
        keyId: UUID_A,
        kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'c2FsdA==' },
        wrappedVk: 'd3I=',
      },
    ],
    vaultVersion,
    schemaVersion: 1,
    deviceId: UUID_B,
    writeId: UUID_C,
    writtenAt: '2026-07-24T10:00:00.000Z',
  };
  return Buffer.from(encodeVaultEnvelope(header, ciphertext));
}

interface FakeRepoOptions {
  current?: ParanoidVaultRow | null;
  casResult?: ParanoidVaultCasResult;
}

function fakeRepo(options: FakeRepoOptions = {}) {
  const calls: ParanoidVaultCasInput[] = [];
  const repo: ParanoidVaultRepository = {
    async getCurrent() {
      return options.current ?? null;
    },
    async listHistory() {
      return [];
    },
    async compareAndSwap(input) {
      calls.push(input);
      return (
        options.casResult ?? {
          status: 'ok',
          version: input.version,
          updatedAt: new Date('2026-07-24T10:00:00.000Z'),
        }
      );
    },
  };
  return { repo, calls };
}

const retention = { maxVersions: 10, maxAgeMs: 30 * 24 * 60 * 60 * 1000 };

describe('paranoid vault service', () => {
  it('rejects an oversized payload before any parse or persistence', async () => {
    const { repo, calls } = fakeRepo();
    const service = createParanoidVaultService({ vaults: repo, maxBytes: 10, retention });
    const result = await service.put({
      userId: UUID_A,
      expectedVersion: null,
      blob: Buffer.alloc(11, 1),
    });
    expect(result).toEqual({ status: 'too_large', sizeBytes: 11, maxBytes: 10 });
    expect(calls).toHaveLength(0);
  });

  it('rejects bytes that are not a well-formed envelope', async () => {
    const { repo, calls } = fakeRepo();
    const service = createParanoidVaultService({ vaults: repo, maxBytes: 1_000_000, retention });
    const result = await service.put({
      userId: UUID_A,
      expectedVersion: null,
      blob: Buffer.from('this is not an envelope'),
    });
    expect(result.status).toBe('malformed');
    expect(calls).toHaveLength(0);
  });

  it('delegates a valid create to the repository with the header version', async () => {
    const { repo, calls } = fakeRepo();
    const service = createParanoidVaultService({
      vaults: repo,
      maxBytes: 1_000_000,
      retention,
      now: () => new Date('2026-07-24T12:00:00.000Z'),
    });
    const result = await service.put({
      userId: UUID_A,
      expectedVersion: null,
      blob: envelope(1, new Uint8Array([9, 9, 9])),
    });
    expect(result).toMatchObject({ status: 'ok', version: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      userId: UUID_A,
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      now: new Date('2026-07-24T12:00:00.000Z'),
    });
  });

  it('refuses a non-advancing version against the If-Match precondition', async () => {
    const { repo, calls } = fakeRepo();
    const service = createParanoidVaultService({ vaults: repo, maxBytes: 1_000_000, retention });
    const result = await service.put({
      userId: UUID_A,
      expectedVersion: 5,
      blob: envelope(5, new Uint8Array([1])),
    });
    expect(result.status).toBe('malformed');
    expect(calls).toHaveLength(0);
  });

  it('accepts an advancing replace and forwards the CAS precondition', async () => {
    const { repo, calls } = fakeRepo();
    const service = createParanoidVaultService({ vaults: repo, maxBytes: 1_000_000, retention });
    const result = await service.put({
      userId: UUID_A,
      expectedVersion: 5,
      blob: envelope(6, new Uint8Array([1])),
    });
    expect(result).toMatchObject({ status: 'ok', version: 6 });
    expect(calls[0]).toMatchObject({ expectedVersion: 5, version: 6 });
  });

  it('exposes metadata without any payload', async () => {
    const row: ParanoidVaultRow = {
      userId: UUID_A,
      version: 3,
      formatVersion: 1,
      sizeBytes: 42,
      blob: Buffer.from('opaque'),
      createdAt: new Date('2026-07-24T09:00:00.000Z'),
      updatedAt: new Date('2026-07-24T10:00:00.000Z'),
    };
    const { repo } = fakeRepo({ current: row });
    const service = createParanoidVaultService({ vaults: repo, maxBytes: 1_000_000, retention });
    expect(await service.getMetadata(UUID_A)).toEqual({
      version: 3,
      formatVersion: 1,
      sizeBytes: 42,
      updatedAt: '2026-07-24T10:00:00.000Z',
    });

    const { repo: emptyRepo } = fakeRepo({ current: null });
    const emptyService = createParanoidVaultService({
      vaults: emptyRepo,
      maxBytes: 1_000_000,
      retention,
    });
    expect(await emptyService.getMetadata(UUID_A)).toBeNull();
  });
});

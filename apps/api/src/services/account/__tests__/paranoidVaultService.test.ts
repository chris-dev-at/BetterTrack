import { generateKeyPairSync, sign } from 'node:crypto';

import {
  encodeVaultEnvelope,
  serializeRetiredServerPurgeTranscript,
  VAULT_CONTENT_CIPHER,
  VAULT_RETIRED_PURGE_CHALLENGE_TTL_MS,
} from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type {
  ParanoidVaultCasInput,
  ParanoidVaultCasResult,
  ParanoidRetirementState,
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
  retirement?: ParanoidRetirementState | null;
}

function fakeRepo(options: FakeRepoOptions = {}) {
  const calls: ParanoidVaultCasInput[] = [];
  const purges: unknown[] = [];
  const repo: ParanoidVaultRepository = {
    async getCurrent() {
      return options.current ?? null;
    },
    async getMediaState() {
      return null;
    },
    async listHistory() {
      return { items: [], nextCursor: null };
    },
    async getHistory() {
      return null;
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
    async stageServerCandidate() {
      return { status: 'not_found' } as const;
    },
    async getServerCandidate() {
      return null;
    },
    async transitionMedia() {
      return { status: 'not_found' } as const;
    },
    async getRetirementState() {
      return options.retirement ?? null;
    },
    async purgeRetired(input) {
      purges.push(input);
      return { status: 'ok' } as const;
    },
  };
  return { repo, calls, purges };
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
      retirementProofPublicKey: null,
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

  it('requires a fresh, client-held-key purge transcript and accepts an advanced version', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const proofKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    let clock = new Date('2026-07-24T10:00:00.000Z');
    const { repo, purges } = fakeRepo({
      retirement: {
        retiredVersion: 2,
        retirementProofPublicKey: proofKey,
        retiredAt: new Date('2026-07-17T10:00:00.000Z'),
      },
    });
    const service = createParanoidVaultService({
      vaults: repo,
      maxBytes: 1_000_000,
      retention,
      proofSecret: 'proof-secret-for-test-only',
      now: () => clock,
    });

    const prepared = await service.prepareRetiredPurge(UUID_A, { retiredVersion: 2 });
    expect(prepared.status).toBe('ok');
    if (prepared.status !== 'ok') throw new Error('expected a challenge');
    const valid = {
      retiredVersion: 2,
      observedVersion: 3,
      challenge: prepared.challenge.challenge,
      signature: sign(
        null,
        Buffer.from(
          serializeRetiredServerPurgeTranscript({
            retiredVersion: 2,
            observedVersion: 3,
            challenge: prepared.challenge.challenge,
          }),
        ),
        privateKey,
      ).toString('base64url'),
    };
    expect(await service.purgeRetired(UUID_A, valid)).toEqual({ status: 'ok' });
    expect(purges).toHaveLength(1);

    const lower = {
      ...valid,
      observedVersion: 1,
      signature: sign(
        null,
        Buffer.from(
          serializeRetiredServerPurgeTranscript({
            retiredVersion: 2,
            observedVersion: 1,
            challenge: prepared.challenge.challenge,
          }),
        ),
        privateKey,
      ).toString('base64url'),
    };
    expect(await service.purgeRetired(UUID_A, lower)).toEqual({ status: 'proof_invalid' });

    clock = new Date(clock.getTime() + VAULT_RETIRED_PURGE_CHALLENGE_TTL_MS + 1);
    expect(await service.purgeRetired(UUID_A, valid)).toEqual({ status: 'proof_invalid' });
    expect(purges).toHaveLength(1);
  });
});

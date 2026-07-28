import { webcrypto } from 'node:crypto';

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decodeVaultEnvelope as decodeContractEnvelope,
  encodeVaultEnvelope as encodeContractEnvelope,
  VAULT_HISTORY_CREATED_AT_HEADER,
  VAULT_HISTORY_MEDIUM_HEADER,
  VAULT_HISTORY_PAGE_MAX,
  VAULT_HISTORY_SIZE_BYTES_HEADER,
  VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER,
  type VaultDocumentV1,
  type VaultEntity,
  type VaultEnvelopeHeader,
} from '@bettertrack/contracts';

import { decryptVaultDocument, encryptVaultDocument } from './crypto';
import type {
  DataHome,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from './dataHome';
import {
  createIndexedDbLocalDataHomeStorage,
  createLocalDataHome,
  type LocalDataHome,
  type LocalDataHomeStorage,
  type LocalVaultRecord,
} from './localDataHome';
import { createMemoryVaultQuarantineStore } from './quarantine';
import {
  createCurrentServerRestoreCandidateSource,
  createQuarantinedRestoreCandidateSource,
  createRestoreCandidateSources,
  createRestorePicker,
  createServerHistoryRestoreCandidateSource,
  type RestoreCandidate,
} from './restore';
import { createServerBlobDataHome } from './serverBlobDataHome';
import {
  createVaultSyncEngine as createBaseVaultSyncEngine,
  type VaultDocumentReconcileContext,
  type VaultSyncEngineOptions,
} from './sync';
import { deterministicRandom, VECTOR_DEVICE_ID, VECTOR_KEY_ID, VECTOR_WRITE_ID } from './vectors';

const DEVICE_A = VECTOR_DEVICE_ID;
const DEVICE_B = '018f0000-0000-7000-8000-00000000000e';
const ENTITY_A = '018f0000-0000-7000-8000-000000000010';
const ENTITY_B = '018f0000-0000-7000-8000-000000000011';
const ENTITY_C = '018f0000-0000-7000-8000-000000000012';
const ENTITY_D = '018f0000-0000-7000-8000-000000000013';
const KEY = new Uint8Array(32).fill(9);
const WRAPPED = {
  keyId: VECTOR_KEY_ID,
  kdf: {
    alg: 'argon2id' as const,
    m: 65536,
    t: 3,
    p: 1,
    salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
  },
  wrappedVk: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

type TestVaultSyncEngineOptions = Omit<
  VaultSyncEngineOptions,
  'documentReconciler' | 'requiresCompleteMutationProvenance'
> &
  Partial<
    Pick<VaultSyncEngineOptions, 'documentReconciler' | 'requiresCompleteMutationProvenance'>
  >;

function createVaultSyncEngine(options: TestVaultSyncEngineOptions) {
  return createBaseVaultSyncEngine({
    documentReconciler: (document, context) => ({
      document,
      mutations: context.mutations,
    }),
    requiresCompleteMutationProvenance: false,
    ...options,
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

afterEach(async () => {
  await deleteDatabase('bettertrack-vault-cache');
});

function entity(
  id: string,
  rev: number,
  editedBy: string,
  data: Record<string, unknown> = { amount: rev },
): VaultEntity {
  return {
    id,
    rev,
    editedAt: `2026-07-25T10:${String(rev).padStart(2, '0')}:00.000Z`,
    editedBy,
    deletedAt: null,
    data,
  };
}

function document(rows: VaultEntity[]): VaultDocumentV1 {
  return { schemaVersion: 1, entities: { transaction: rows }, mergeLog: [] };
}

function header(
  version: number,
  deviceId = DEVICE_A,
  writeId = VECTOR_WRITE_ID,
): Omit<VaultEnvelopeHeader, 'cipher' | 'iv' | 'formatVersion' | 'schemaVersion'> {
  return {
    keyId: VECTOR_KEY_ID,
    wrappedKeys: [WRAPPED],
    vaultVersion: version,
    deviceId,
    writeId,
    writtenAt: '2026-07-25T10:00:00.000Z',
  };
}

async function encrypted(
  value: VaultDocumentV1,
  version: number,
  deviceId = DEVICE_A,
  writeId = VECTOR_WRITE_ID,
): Promise<Uint8Array> {
  return (
    await encryptVaultDocument({
      document: value,
      vaultKey: KEY,
      header: header(version, deviceId, writeId),
      randomBytes: deterministicRandom(version * 29 + writeId.charCodeAt(writeId.length - 1)),
    })
  ).envelope;
}

describe('vault DataHome boundaries', () => {
  it('distinguishes success, absent, corruption, transport failure and CAS conflict', async () => {
    const blob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 3);
    const ok = createServerBlobDataHome({
      fetch: async () => new Response(blob, { status: 200, headers: { ETag: '"3"' } }),
    });
    const absent = createServerBlobDataHome({
      fetch: async () => new Response(null, { status: 404 }),
    });
    const corrupt = createServerBlobDataHome({
      fetch: async () => new Response(blob, { status: 200 }),
    });
    const failed = createServerBlobDataHome({
      fetch: async () => {
        throw new TypeError('offline');
      },
    });
    const conflict = createServerBlobDataHome({
      fetch: async () => new Response(null, { status: 412, headers: { ETag: '"4"' } }),
    });

    await expect(ok.read()).resolves.toMatchObject({
      status: 'ok',
      info: { version: 3 },
    });
    await expect(absent.read()).resolves.toEqual({ status: 'absent', medium: 'server' });
    await expect(corrupt.read()).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'missing-version',
      envelope: blob,
    });
    await expect(failed.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { message: 'GET vault failed.' },
    });
    await expect(conflict.write(blob, { ifVersion: 2 })).resolves.toEqual({
      status: 'conflict',
      medium: 'server',
      currentVersion: 4,
    });
  });

  it('maps ETag and If-Match exactly and fails closed on mismatched metadata', async () => {
    const blob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 3);
    const calls: RequestInit[] = [];
    const mismatch = createServerBlobDataHome({
      retirementProofPublicKey: () => 'client-held-public-verifier',
      fetch: async (_url, init = {}) => {
        calls.push(init);
        return init.method === 'PUT'
          ? new Response(null, { status: 204, headers: { ETag: '"4"' } })
          : new Response(blob, { status: 200, headers: { ETag: '"4"' } });
      },
    });

    await expect(mismatch.read()).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'version-mismatch',
    });
    await expect(mismatch.write(blob, { ifVersion: 2 })).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'version-mismatch',
    });
    expect(calls[1]?.headers).toMatchObject({
      'If-Match': '"2"',
      'Content-Type': 'application/octet-stream',
      [VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER]: 'client-held-public-verifier',
    });
  });

  it('classifies the shipped malformed-write 400 as corruption, not uncertain transport', async () => {
    const blob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 3);
    let requests = 0;
    const rejected = createServerBlobDataHome({
      fetch: async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            error: { code: 'VAULT_MALFORMED', message: 'non-advancing envelope' },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await expect(rejected.write(blob, { ifVersion: 2 })).resolves.toMatchObject({
      status: 'corrupt',
      medium: 'server',
      envelope: blob,
      version: 3,
      reason: 'malformed-envelope',
    });
    expect(requests).toBe(1);
  });

  it('rejects malformed and non-advancing envelopes before transport', async () => {
    let requests = 0;
    const home = createServerBlobDataHome({
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 204 });
      },
    });
    const v3 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 3);

    await expect(home.write(new Uint8Array([1, 2, 3]), { ifVersion: 2 })).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'malformed-envelope',
    });
    await expect(home.write(v3, { ifVersion: 3 })).resolves.toMatchObject({
      status: 'corrupt',
      version: 3,
      reason: 'malformed-envelope',
    });
    expect(requests).toBe(0);
  });

  it('serializes IndexedDB compare-and-swap writes from concurrent tabs', async () => {
    const local = createLocalDataHome({
      scope: 'indexeddb-race',
      storage: createIndexedDbLocalDataHomeStorage(),
    });
    const v1 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const left = await encrypted(
      document([entity(ENTITY_A, 2, DEVICE_A)]),
      2,
      DEVICE_A,
      '018f0000-0000-7000-8000-0000000000a1',
    );
    const right = await encrypted(
      document([entity(ENTITY_B, 2, DEVICE_B)]),
      2,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b1',
    );
    await local.write(v1, { ifVersion: null });

    const outcomes = await Promise.all([
      local.write(left, { ifVersion: 1 }),
      local.write(right, { ifVersion: 1 }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['conflict', 'ok']);
    await expect(local.read()).resolves.toMatchObject({ status: 'ok', info: { version: 2 } });
  });
});

describe('versioned encrypted local cache', () => {
  it('cannot acknowledge over a newer local write and has no unversioned storage mutator', async () => {
    const storage = memoryLocalStorage();
    const tabA = createLocalDataHome({ scope: 'shared', storage });
    const tabB = createLocalDataHome({ scope: 'shared', storage });
    const v1 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const v3 = await encrypted(
      document([entity(ENTITY_A, 1, DEVICE_A), entity(ENTITY_C, 1, DEVICE_B)]),
      3,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b3',
    );
    await tabA.write(v1, { ifVersion: null });
    await tabA.setPendingRemote(false, { ifVersion: 1 });
    await tabB.write(v3, { ifVersion: 1 });

    await expect(tabA.setPendingRemote(false, { ifVersion: 1 })).resolves.toEqual({
      status: 'conflict',
      medium: 'local',
      currentVersion: 3,
    });
    await expect(tabA.read()).resolves.toMatchObject({
      status: 'ok',
      info: { version: 3, pendingRemote: true },
      envelope: v3,
    });
    expect('update' in storage).toBe(false);
  });

  it('persists only encrypted envelopes and non-sensitive synchronization metadata', async () => {
    const storage = memoryLocalStorage();
    const home = createLocalDataHome({ scope: 'opaque-probe', storage });
    const blob = await encrypted(
      document([entity(ENTITY_A, 1, DEVICE_A, { amount: 987654, memo: 'secret memo' })]),
      1,
    );
    await home.write(blob, { ifVersion: null });
    await home.markLastKnownGood(blob, { ifVersion: 1 });

    const record = storage.peek();
    expect(record).not.toBeNull();
    expect(Object.keys(record!).sort()).toEqual([
      'envelope',
      'lastKnownGood',
      'lastKnownGoodUpdatedAt',
      'lastKnownGoodVersion',
      'pendingRemote',
      'recordVersion',
      'updatedAt',
      'version',
    ]);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('987654');
    expect(serialized).not.toContain('secret memo');
    expect(serialized).not.toContain('vaultKey');
    expect(serialized).not.toContain(Array.from(KEY).join(','));
  });

  it('treats every partial last-known-good tuple as corrupt and preserves its provenance', async () => {
    const current = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const rollback = await encrypted(document([entity(ENTITY_B, 2, DEVICE_B)]), 2);
    const rollbackBuffer = toArrayBuffer(rollback);
    const rollbackUpdatedAt = '2026-07-25T10:02:00.000Z';
    const base = {
      recordVersion: 1,
      envelope: toArrayBuffer(current),
      version: 1,
      updatedAt: '2026-07-25T10:01:00.000Z',
      pendingRemote: false,
    };
    const permutations = [
      { label: 'bytes', fields: { lastKnownGood: rollbackBuffer } },
      { label: 'version', fields: { lastKnownGoodVersion: 2 } },
      { label: 'timestamp', fields: { lastKnownGoodUpdatedAt: rollbackUpdatedAt } },
      {
        label: 'bytes and version',
        fields: { lastKnownGood: rollbackBuffer, lastKnownGoodVersion: 2 },
      },
      {
        label: 'bytes and timestamp',
        fields: { lastKnownGood: rollbackBuffer, lastKnownGoodUpdatedAt: rollbackUpdatedAt },
      },
      {
        label: 'version and timestamp',
        fields: { lastKnownGoodVersion: 2, lastKnownGoodUpdatedAt: rollbackUpdatedAt },
      },
    ];

    for (const { label, fields } of permutations) {
      const malformed = { ...base, ...fields } as LocalVaultRecord;
      const storage: LocalDataHomeStorage = {
        async read() {
          return cloneRecord(malformed);
        },
        async compareAndSwap() {
          throw new Error('A corrupt record must not be mutated.');
        },
      };
      const home = createLocalDataHome({ scope: `partial-rollback-${label}`, storage });

      await expect(home.read(), label).resolves.toMatchObject({
        status: 'corrupt',
        reason: 'invalid-response',
      });
      const result = await home.readLastKnownGood();
      expect(result, label).toMatchObject({
        status: 'corrupt',
        medium: 'local',
        reason: 'invalid-response',
        message: 'The last-known-good vault metadata is incomplete or malformed.',
      });
      if (result.status !== 'corrupt') throw new Error(`Expected corrupt result for ${label}.`);
      expect(result.envelope, label).toEqual('lastKnownGood' in fields ? rollback : undefined);
      expect(result.version, label).toBe('lastKnownGoodVersion' in fields ? 2 : null);
      expect(result.updatedAt, label).toBe(
        'lastKnownGoodUpdatedAt' in fields ? rollbackUpdatedAt : null,
      );
    }
  });

  it('reads an intact last-known-good tuple independently of malformed current metadata', async () => {
    const current = await encrypted(document([entity(ENTITY_B, 2, DEVICE_B)]), 2);
    const rollbackDocument = document([entity(ENTITY_A, 1, DEVICE_A)]);
    const rollback = await encrypted(rollbackDocument, 1);
    const malformed = {
      recordVersion: 1,
      envelope: toArrayBuffer(current),
      version: 2,
      updatedAt: '2026-07-25T10:02:00.000Z',
      lastKnownGood: toArrayBuffer(rollback),
      lastKnownGoodVersion: 1,
      lastKnownGoodUpdatedAt: '2026-07-25T10:01:00.000Z',
      pendingRemote: 'malformed',
    } as unknown as LocalVaultRecord;
    const storage: LocalDataHomeStorage = {
      async read() {
        return cloneRecord(malformed);
      },
      async compareAndSwap() {
        throw new Error('A corrupt current record must not be mutated.');
      },
    };
    const local = createLocalDataHome({ scope: 'valid-rollback-corrupt-current', storage });

    await expect(local.read()).resolves.toMatchObject({
      status: 'corrupt',
      envelope: current,
      version: 2,
      reason: 'invalid-response',
    });
    await expect(local.readLastKnownGood()).resolves.toMatchObject({
      status: 'ok',
      envelope: rollback,
      info: { version: 1, pendingRemote: false },
    });

    const quarantine = createMemoryVaultQuarantineStore();
    const engine = createVaultSyncEngine({
      local,
      primary: offlineRemote(),
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine,
    });
    await expect(engine.start()).resolves.toMatchObject({
      status: 'pending-offline',
      active: { document: rollbackDocument, header: { vaultVersion: 1 } },
      pending: null,
    });
    await expect(quarantine.list()).resolves.toEqual([
      expect.objectContaining({
        medium: 'local',
        status: 'corrupt',
        envelope: current,
        version: 2,
      }),
    ]);
  });
});

describe('CAS-aware vault synchronization', () => {
  it('passes every original mutation member to reconciliation before entity winners are filtered', async () => {
    const initialDocument = document([entity(ENTITY_A, 0, DEVICE_A, { state: 'initial' })]);
    const initial = await encrypted(initialDocument, 1);
    const remoteWinner = document([entity(ENTITY_A, 1, DEVICE_B, { state: 'remote-winner' })]);
    const remoteV2 = await encrypted(
      remoteWinner,
      2,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b2',
    );
    const local = createLocalDataHome({
      scope: 'complete-mutation-provenance',
      storage: memoryLocalStorage(),
    });
    await seedLocal(local, initial, false);
    const primary = memoryRemote(initial, 1, [remoteV2]);
    const observed: VaultDocumentReconcileContext[] = [];
    const engine = createVaultSyncEngine({
      local,
      primary,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      now: () => '2026-07-25T10:02:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
      documentReconciler(merged, context) {
        observed.push(context);
        expect(merged.entities.transaction).toEqual([
          expect.objectContaining({ id: ENTITY_A, deletedAt: null }),
          expect.objectContaining({ id: ENTITY_B, deletedAt: null }),
        ]);
        return {
          document: { ...merged, entities: context.remote.entities },
          mutations: [],
        };
      },
    });
    await engine.start();

    await expect(
      engine.mutate(({ document: value }) => ({
        ...value,
        entities: {
          ...value.entities,
          transaction: [
            {
              ...value.entities.transaction![0]!,
              rev: 1,
              editedAt: '2026-07-25T10:01:00.000Z',
              editedBy: DEVICE_A,
              deletedAt: '2026-07-25T10:01:00.000Z',
            },
            entity(ENTITY_B, 1, DEVICE_A, { state: 'local-only' }),
          ],
        },
      })),
    ).resolves.toMatchObject({ status: 'synced' });

    expect(observed[0]?.mutations).toHaveLength(1);
    expect(observed[0]?.mutations[0]?.changes.map((change) => change.id)).toEqual([
      ENTITY_A,
      ENTITY_B,
    ]);
    expect(observed[0]?.mutations[0]?.changes).toEqual([
      expect.objectContaining({
        id: ENTITY_A,
        before: expect.objectContaining({ deletedAt: null }),
        after: expect.objectContaining({ deletedAt: '2026-07-25T10:01:00.000Z' }),
      }),
      expect.objectContaining({
        id: ENTITY_B,
        before: undefined,
        after: expect.objectContaining({ deletedAt: null }),
      }),
    ]);
    expect(engine.state.active?.document.entities).toEqual(remoteWinner.entities);
    expect(engine.state.active?.document.mergeLog).toHaveLength(1);
  });

  it('keeps readable remote data active but read-only when the local CAS version is unavailable', async () => {
    const remoteV2 = await encrypted(
      document([entity(ENTITY_B, 2, DEVICE_B)]),
      2,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b2',
    );
    type LocalReadFailure = Extract<
      DataHomeReadResult,
      { status: 'corrupt' } | { status: 'transport-failure' }
    >;
    const cases: {
      label: string;
      result: LocalReadFailure;
      expectedStatus: 'corrupt' | 'pending-offline';
      expectedFailure: string;
    }[] = [
      {
        label: 'transport failure',
        result: {
          status: 'transport-failure',
          medium: 'local',
          failure: { message: 'IndexedDB is unavailable' },
        },
        expectedStatus: 'pending-offline',
        expectedFailure: 'IndexedDB is unavailable',
      },
      {
        label: 'corrupt metadata without a version',
        result: {
          status: 'corrupt',
          medium: 'local',
          envelope: new Uint8Array([1, 2, 3]),
          version: null,
          updatedAt: '2026-07-25T10:01:00.000Z',
          reason: 'invalid-response',
          message: 'Local metadata has no usable version',
        },
        expectedStatus: 'corrupt',
        expectedFailure: 'Local metadata has no usable version',
      },
    ];

    for (const testCase of cases) {
      let localMutationCalls = 0;
      const local: LocalDataHome = {
        medium: 'local',
        async read() {
          return testCase.result;
        },
        async info() {
          return testCase.result;
        },
        async readLastKnownGood() {
          return { status: 'absent', medium: 'local' };
        },
        async write() {
          localMutationCalls += 1;
          return {
            status: 'transport-failure',
            medium: 'local',
            failure: { message: 'unexpected local write' },
          };
        },
        async markLastKnownGood() {
          localMutationCalls += 1;
          return {
            status: 'transport-failure',
            medium: 'local',
            failure: { message: 'unexpected rollback promotion' },
          };
        },
        async setPendingRemote() {
          localMutationCalls += 1;
          return {
            status: 'transport-failure',
            medium: 'local',
            failure: { message: 'unexpected acknowledgement write' },
          };
        },
      };
      const primary = memoryRemote(remoteV2, 2);
      const engine = createVaultSyncEngine({
        local,
        primary,
        vaultKey: KEY,
        deviceId: DEVICE_A,
        writeId: writeIds(),
        quarantine: createMemoryVaultQuarantineStore(),
      });

      const started = await engine.start();

      expect(started, testCase.label).toMatchObject({
        status: testCase.expectedStatus,
        active: { header: { vaultVersion: 2 }, envelope: remoteV2 },
        pending: null,
        lastFailure: testCase.expectedFailure,
      });
      await expect(
        engine.mutate(({ document: value }) => value),
        testCase.label,
      ).rejects.toMatchObject({ code: 'storage-failed' });
      expect(engine.state.active?.envelope, testCase.label).toEqual(remoteV2);
      expect(localMutationCalls, testCase.label).toBe(0);
      expect(primary.writeCalls, testCase.label).toBe(0);
    }
  });

  it('keeps readable startup candidates active when acknowledgement metadata writes fail', async () => {
    const blob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 2);

    for (const seeded of [true, false]) {
      const storage = memoryLocalStorage();
      const baseLocal = createLocalDataHome({
        scope: seeded ? 'ack-failure-existing' : 'ack-failure-install',
        storage,
      });
      if (seeded) await seedLocal(baseLocal, blob, false);
      let acknowledgementCalls = 0;
      const local: LocalDataHome = {
        ...baseLocal,
        async setPendingRemote(pending, options) {
          if (pending) return baseLocal.setPendingRemote(pending, options);
          acknowledgementCalls += 1;
          return {
            status: 'transport-failure',
            medium: 'local',
            failure: { message: 'acknowledgement metadata unavailable' },
          };
        },
      };
      const engine = createVaultSyncEngine({
        local,
        primary: memoryRemote(blob, 2),
        vaultKey: KEY,
        deviceId: DEVICE_A,
        writeId: writeIds(),
        quarantine: createMemoryVaultQuarantineStore(),
      });

      await expect(
        engine.start(),
        seeded ? 'existing local' : 'remote install',
      ).resolves.toMatchObject({
        status: 'pending-offline',
        active: { header: { vaultVersion: 2 }, envelope: blob },
        pending: null,
        lastFailure: 'acknowledgement metadata unavailable',
      });
      expect(acknowledgementCalls, seeded ? 'existing local' : 'remote install').toBe(1);
    }
  });

  it('keeps a readable local startup candidate active when marking it pending fails', async () => {
    const blob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const storage = memoryLocalStorage();
    const baseLocal = createLocalDataHome({ scope: 'pending-marker-failure', storage });
    await seedLocal(baseLocal, blob, false);
    const local: LocalDataHome = {
      ...baseLocal,
      async setPendingRemote(pending, options) {
        if (!pending) return baseLocal.setPendingRemote(pending, options);
        return {
          status: 'corrupt',
          medium: 'local',
          envelope: blob,
          version: 1,
          updatedAt: '2026-07-25T10:00:00.000Z',
          reason: 'invalid-response',
          message: 'Pending metadata is malformed.',
        };
      },
    };
    let remoteWriteCalls = 0;
    const primary: DataHome = {
      medium: 'server',
      async read() {
        return { status: 'absent', medium: 'server' };
      },
      async info() {
        return { status: 'absent', medium: 'server' };
      },
      async write() {
        remoteWriteCalls += 1;
        return {
          status: 'transport-failure',
          medium: 'server',
          failure: { message: 'unexpected remote write' },
        };
      },
    };
    const engine = createVaultSyncEngine({
      local,
      primary,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine: createMemoryVaultQuarantineStore(),
    });

    await expect(engine.start()).resolves.toMatchObject({
      status: 'pending-offline',
      active: { header: { vaultVersion: 1 }, envelope: blob },
      pending: { header: { vaultVersion: 1 }, envelope: blob },
      lastFailure: 'Pending metadata is malformed.',
    });
    expect(remoteWriteCalls).toBe(0);
  });

  it('serializes a same-engine reconnect snapshot against a concurrent mutation', async () => {
    const localV1 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const remoteV2 = await encrypted(
      document([entity(ENTITY_B, 2, DEVICE_B)]),
      2,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b2',
    );
    const storage = memoryLocalStorage();
    const baseLocal = createLocalDataHome({ scope: 'same-engine-race', storage });
    await seedLocal(baseLocal, localV1, false);

    const reconnectPromotion = deferred<void>();
    const releaseReconnect = deferred<void>();
    let promotionCalls = 0;
    const local: LocalDataHome = {
      ...baseLocal,
      async markLastKnownGood(envelope, options) {
        promotionCalls += 1;
        if (promotionCalls === 2) {
          reconnectPromotion.resolve();
          await releaseReconnect.promise;
        }
        return baseLocal.markLastKnownGood(envelope, options);
      },
    };
    const onlineRemote = memoryRemote(remoteV2, 2);
    let online = false;
    const primary: DataHome = {
      medium: 'server',
      read: () => (online ? onlineRemote.read() : offlineRemote().read()),
      info: () => (online ? onlineRemote.info() : offlineRemote().info()),
      write: (envelope, options) =>
        online ? onlineRemote.write(envelope, options) : offlineRemote().write(envelope, options),
    };
    const engine = createVaultSyncEngine({
      local,
      primary,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      now: () => '2026-07-25T10:10:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
    });
    await engine.start();

    online = true;
    const reconnecting = engine.reconnect();
    await reconnectPromotion.promise;
    let mutationRan = false;
    const mutating = engine.mutate(({ document: value }) => {
      mutationRan = true;
      return {
        ...value,
        entities: {
          ...value.entities,
          transaction: [...(value.entities.transaction ?? []), entity(ENTITY_C, 1, DEVICE_A)],
        },
      };
    });
    await Promise.resolve();
    expect(mutationRan).toBe(false);
    releaseReconnect.resolve();

    await expect(reconnecting).resolves.toMatchObject({
      status: 'synced',
      active: { header: { vaultVersion: 3 } },
    });
    await expect(mutating).resolves.toMatchObject({
      status: 'synced',
      active: { header: { vaultVersion: 4 } },
    });
    expect(engine.state.active?.document.entities.transaction?.map((row) => row.id).sort()).toEqual(
      [ENTITY_A, ENTITY_B, ENTITY_C],
    );
  });

  it('restarts selection when last-known-good promotion loses a local race offline', async () => {
    const localV1 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const tabBV3 = await encrypted(
      document([entity(ENTITY_A, 1, DEVICE_A), entity(ENTITY_B, 2, DEVICE_B)]),
      3,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b3',
    );
    const storage = memoryLocalStorage();
    const local = createLocalDataHome({ scope: 'promotion-race-offline', storage });
    await seedLocal(local, localV1, false);
    let raced = false;
    storage.beforeCompareAndSwap = (ifVersion) => {
      if (!raced && ifVersion === 1) {
        raced = true;
        storage.replace(tabBV3, 3, true);
      }
    };
    const engine = createVaultSyncEngine({
      local,
      primary: offlineRemote(),
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine: createMemoryVaultQuarantineStore(),
    });

    await expect(engine.start()).resolves.toMatchObject({
      status: 'pending-offline',
      active: { header: { vaultVersion: 3 } },
      pending: { header: { vaultVersion: 3 } },
    });
    await expect(local.read()).resolves.toMatchObject({
      status: 'ok',
      envelope: tabBV3,
      info: { version: 3, pendingRemote: true },
    });
  });

  it('keeps a readable current candidate active when rollback promotion transport fails', async () => {
    const localV1 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const storage = memoryLocalStorage();
    const baseLocal = createLocalDataHome({ scope: 'promotion-transport', storage });
    await seedLocal(baseLocal, localV1, false);
    const local: LocalDataHome = {
      ...baseLocal,
      async markLastKnownGood() {
        return {
          status: 'transport-failure',
          medium: 'local',
          failure: { message: 'rollback storage unavailable' },
        };
      },
    };
    const engine = createVaultSyncEngine({
      local,
      primary: memoryRemote(localV1, 1),
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine: createMemoryVaultQuarantineStore(),
    });

    const result = await engine.start();

    expect(result).toMatchObject({
      status: 'pending-offline',
      active: { header: { vaultVersion: 1 } },
      pending: null,
    });
    expect(result.lastFailure).toContain('rollback storage unavailable');
  });

  it('does not report synced when post-commit rollback promotion transport fails', async () => {
    const localV1 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const storage = memoryLocalStorage();
    const baseLocal = createLocalDataHome({ scope: 'commit-promotion-transport', storage });
    await seedLocal(baseLocal, localV1, false);
    let promotionCalls = 0;
    const local: LocalDataHome = {
      ...baseLocal,
      async markLastKnownGood(envelope, options) {
        promotionCalls += 1;
        if (promotionCalls === 2) {
          return {
            status: 'transport-failure',
            medium: 'local',
            failure: { message: 'rollback write interrupted' },
          };
        }
        return baseLocal.markLastKnownGood(envelope, options);
      },
    };
    const engine = createVaultSyncEngine({
      local,
      primary: memoryRemote(localV1, 1),
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine: createMemoryVaultQuarantineStore(),
    });
    await expect(engine.start()).resolves.toMatchObject({ status: 'synced' });

    const result = await engine.mutate(({ document: value }) => ({
      ...value,
      entities: {
        ...value.entities,
        transaction: [...(value.entities.transaction ?? []), entity(ENTITY_B, 1, DEVICE_A)],
      },
    }));

    expect(result).toMatchObject({
      status: 'pending-offline',
      active: { header: { vaultVersion: 2 } },
      pending: null,
    });
    expect(result.lastFailure).toContain('rollback write interrupted');
    await expect(local.readLastKnownGood()).resolves.toMatchObject({
      status: 'ok',
      info: { version: 1 },
    });
  });

  it('retains an active mutation when reconnect sees only an older rollback and remote', async () => {
    const v1Document = document([entity(ENTITY_A, 1, DEVICE_A)]);
    const v1 = await encrypted(v1Document, 1);
    const storage = memoryLocalStorage();
    const baseLocal = createLocalDataHome({ scope: 'active-reconnect-fallback', storage });
    await seedLocal(baseLocal, v1, false);
    let promotionCalls = 0;
    const local: LocalDataHome = {
      ...baseLocal,
      async markLastKnownGood(envelope, options) {
        promotionCalls += 1;
        if (promotionCalls === 2) {
          return {
            status: 'transport-failure',
            medium: 'local',
            failure: { message: 'rollback write interrupted' },
          };
        }
        return baseLocal.markLastKnownGood(envelope, options);
      },
    };
    const remote = memoryRemote(v1, 1);
    let rejectRemoteWrites = false;
    const primary: DataHome = {
      ...remote,
      async write(envelope, options) {
        if (rejectRemoteWrites) {
          return {
            status: 'transport-failure',
            medium: 'server',
            failure: { message: 'remote temporarily unavailable' },
          };
        }
        return remote.write(envelope, options);
      },
    };
    const engine = createVaultSyncEngine({
      local,
      primary,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      now: () => '2026-07-25T10:10:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
    });
    await expect(engine.start()).resolves.toMatchObject({ status: 'synced' });

    rejectRemoteWrites = true;
    await expect(
      engine.mutate(({ document: value }) => ({
        ...value,
        entities: {
          ...value.entities,
          transaction: [...(value.entities.transaction ?? []), entity(ENTITY_B, 1, DEVICE_A)],
        },
      })),
    ).resolves.toMatchObject({
      status: 'pending-offline',
      active: { header: { vaultVersion: 2 } },
      pending: { header: { vaultVersion: 2 } },
    });

    const corruptCurrent = new Uint8Array(storage.peek()!.envelope.slice(0));
    corruptCurrent[corruptCurrent.length - 1] = corruptCurrent[corruptCurrent.length - 1]! ^ 1;
    storage.replace(corruptCurrent, 2, true);
    rejectRemoteWrites = false;

    await expect(engine.reconnect()).resolves.toMatchObject({
      status: 'synced',
      active: { header: { vaultVersion: 3 } },
      pending: null,
    });
    expect(engine.state.active?.document.entities.transaction?.map((row) => row.id).sort()).toEqual(
      [ENTITY_A, ENTITY_B],
    );
    const remoteResult = await remote.read();
    if (remoteResult.status !== 'ok') throw new Error('Expected a readable reconciled remote.');
    await expect(decryptVaultDocument(remoteResult.envelope, KEY)).resolves.toMatchObject({
      document: {
        entities: {
          transaction: [
            expect.objectContaining({ id: ENTITY_A }),
            expect.objectContaining({ id: ENTITY_B }),
          ],
        },
      },
    });
  });

  it('rejects tab A stale v1 reconciliation after tab B commits v3', async () => {
    const v1 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const remoteV2 = await encrypted(
      document([entity(ENTITY_B, 1, DEVICE_B)]),
      2,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b2',
    );
    const tabBV3 = await encrypted(
      document([entity(ENTITY_A, 1, DEVICE_A), entity(ENTITY_C, 1, DEVICE_B)]),
      3,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b3',
    );
    const storage = memoryLocalStorage();
    const local = createLocalDataHome({ scope: 'multi-tab', storage });
    await seedLocal(local, v1, false);

    let casCalls = 0;
    storage.beforeCompareAndSwap = (ifVersion) => {
      casCalls += 1;
      // First CAS is the read candidate's versioned last-known-good promotion.
      // The second is tab A's reconciliation commit. Tab B wins immediately
      // before that exact CAS is evaluated.
      if (casCalls === 2 && ifVersion === 1) storage.replace(tabBV3, 3, true);
    };
    const remote = memoryRemote(remoteV2, 2);
    const engine = createVaultSyncEngine({
      local,
      primary: remote,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      now: () => '2026-07-25T10:10:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
    });

    await expect(engine.start()).resolves.toMatchObject({
      status: 'conflict',
      active: { header: { vaultVersion: 3 } },
    });
    await expect(local.read()).resolves.toMatchObject({
      status: 'ok',
      envelope: tabBV3,
      info: { version: 3, pendingRemote: true },
    });
    expect(remote.writeCalls).toBe(0);
  });

  it('re-merges different offline edits after repeated remote CAS losses', async () => {
    const localV2 = await encrypted(
      document([entity(ENTITY_A, 2, DEVICE_A)]),
      2,
      DEVICE_A,
      '018f0000-0000-7000-8000-0000000000a2',
    );
    const remoteV3 = await encrypted(
      document([entity(ENTITY_B, 3, DEVICE_B)]),
      3,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b3',
    );
    const remoteV4 = await encrypted(
      document([entity(ENTITY_B, 3, DEVICE_B), entity(ENTITY_C, 1, DEVICE_B)]),
      4,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b4',
    );
    const remoteV5 = await encrypted(
      document([
        entity(ENTITY_B, 3, DEVICE_B),
        entity(ENTITY_C, 1, DEVICE_B),
        entity(ENTITY_D, 1, DEVICE_B),
      ]),
      5,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b5',
    );
    const storage = memoryLocalStorage();
    const local = createLocalDataHome({ scope: 'repeated-cas', storage });
    await seedLocal(local, localV2, true);
    const remote = memoryRemote(remoteV3, 3, [remoteV4, remoteV5]);
    const engine = createVaultSyncEngine({
      local,
      primary: remote,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      now: () => '2026-07-25T10:10:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
    });

    await expect(engine.start()).resolves.toMatchObject({
      status: 'synced',
      active: { header: { vaultVersion: 6 } },
    });
    expect(engine.state.active?.document.entities.transaction?.map((row) => row.id).sort()).toEqual(
      [ENTITY_A, ENTITY_B, ENTITY_C, ENTITY_D],
    );
    expect(remote.expectedVersions).toEqual([3, 4, 5]);
  });

  it('resolves same-entity offline revisions without inventing or vanishing rows', async () => {
    const localV2 = await encrypted(
      document([entity(ENTITY_A, 4, DEVICE_A, { amount: 400 })]),
      2,
      DEVICE_A,
      '018f0000-0000-7000-8000-0000000000a2',
    );
    const remoteV3 = await encrypted(
      document([entity(ENTITY_A, 5, DEVICE_B, { amount: 500 })]),
      3,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b3',
    );
    const storage = memoryLocalStorage();
    const local = createLocalDataHome({ scope: 'same-row', storage });
    await seedLocal(local, localV2, true);
    const engine = createVaultSyncEngine({
      local,
      primary: memoryRemote(remoteV3, 3),
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      now: () => '2026-07-25T10:10:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
    });

    await expect(engine.start()).resolves.toMatchObject({ status: 'synced' });
    expect(engine.state.active?.document.entities.transaction).toEqual([
      expect.objectContaining({ id: ENTITY_A, rev: 5, data: { amount: 500 } }),
    ]);
  });

  it('does not clear a newer tab write after an older remote push succeeds', async () => {
    const v1 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const tabBV3 = await encrypted(
      document([entity(ENTITY_A, 1, DEVICE_A), entity(ENTITY_C, 1, DEVICE_B)]),
      3,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b3',
    );
    const storage = memoryLocalStorage();
    const local = createLocalDataHome({ scope: 'ack-race', storage });
    await seedLocal(local, v1, false);
    const remote = memoryRemote(v1, 1);
    remote.afterSuccessfulWrite = () => storage.replace(tabBV3, 3, true);
    const engine = createVaultSyncEngine({
      local,
      primary: remote,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      now: () => '2026-07-25T10:10:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
    });
    await engine.start();

    await expect(
      engine.mutate(({ document: value }) => ({
        ...value,
        entities: {
          ...value.entities,
          transaction: [...(value.entities.transaction ?? []), entity(ENTITY_B, 1, DEVICE_A)],
        },
      })),
    ).resolves.toMatchObject({
      status: 'conflict',
      active: { header: { vaultVersion: 3 } },
    });
    await expect(local.read()).resolves.toMatchObject({
      status: 'ok',
      info: { version: 3, pendingRemote: true },
      envelope: tabBV3,
    });
  });
});

describe('corruption quarantine and rollback safety', () => {
  it('reports a cold-start unreadable server candidate as locked instead of empty', async () => {
    const unreadable = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 2);
    unreadable[unreadable.length - 1] = unreadable[unreadable.length - 1]! ^ 1;
    const quarantine = createMemoryVaultQuarantineStore();
    const engine = createVaultSyncEngine({
      local: createLocalDataHome({
        scope: 'unreadable-server-cold-start',
        storage: memoryLocalStorage(),
      }),
      primary: memoryRemote(unreadable, 2),
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine,
    });

    const result = await engine.start();

    expect(result).toMatchObject({ status: 'locked', active: null, pending: null });
    expect(result.lastFailure).toContain('Vault authentication failed');
    await expect(quarantine.list()).resolves.toEqual([
      expect.objectContaining({
        medium: 'server',
        status: 'unreadable',
        envelope: unreadable,
        version: 2,
      }),
    ]);
  });

  it('preserves remote validation failure while using a readable local fallback', async () => {
    const localV1 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const unreadableRemoteV2 = await encrypted(
      document([entity(ENTITY_B, 2, DEVICE_B)]),
      2,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b2',
    );
    unreadableRemoteV2[unreadableRemoteV2.length - 1] =
      unreadableRemoteV2[unreadableRemoteV2.length - 1]! ^ 1;
    const local = createLocalDataHome({
      scope: 'unreadable-server-local-fallback',
      storage: memoryLocalStorage(),
    });
    await seedLocal(local, localV1, false);
    const engine = createVaultSyncEngine({
      local,
      primary: memoryRemote(unreadableRemoteV2, 2),
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine: createMemoryVaultQuarantineStore(),
    });

    const result = await engine.start();

    expect(result).toMatchObject({
      status: 'pending-offline',
      active: { header: { vaultVersion: 1 } },
      pending: null,
    });
    expect(result.lastFailure).toContain('Vault authentication failed');
  });

  it('retains last-known-good bytes and exposes no partial plaintext while offline', async () => {
    const goodDocument = document([entity(ENTITY_A, 1, DEVICE_A, { amount: 100 })]);
    const good = await encrypted(goodDocument, 1);
    const unreadableDocument = document([
      entity(ENTITY_D, 9, DEVICE_B, { amount: 999999, memo: 'must never surface' }),
    ]);
    const unreadable = await encrypted(
      unreadableDocument,
      2,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b2',
    );
    unreadable[unreadable.length - 1] = unreadable[unreadable.length - 1]! ^ 1;

    const storage = memoryLocalStorage();
    const local = createLocalDataHome({ scope: 'corrupt-offline', storage });
    await seedLocal(local, good, false);
    storage.replace(unreadable, 2, true);
    const quarantine = createMemoryVaultQuarantineStore();
    const engine = createVaultSyncEngine({
      local,
      primary: offlineRemote(),
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine,
    });

    await expect(engine.start()).resolves.toMatchObject({
      status: 'pending-offline',
      active: { document: goodDocument },
    });
    expect(JSON.stringify(engine.state.active?.document)).not.toContain('must never surface');
    await expect(local.readLastKnownGood()).resolves.toMatchObject({
      status: 'ok',
      envelope: good,
      info: { version: 1 },
    });
    await expect(quarantine.list()).resolves.toEqual([
      expect.objectContaining({
        medium: 'local',
        status: 'unreadable',
        envelope: unreadable,
        version: 2,
      }),
    ]);
  });

  it('selects the highest readable candidate and promotes above quarantined metadata', async () => {
    const goodV1 = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 1);
    const remoteV3 = await encrypted(
      document([entity(ENTITY_B, 3, DEVICE_B)]),
      3,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b3',
    );
    const unreadableV4 = await encrypted(
      document([entity(ENTITY_D, 4, DEVICE_B)]),
      4,
      DEVICE_B,
      '018f0000-0000-7000-8000-0000000000b4',
    );
    unreadableV4[unreadableV4.length - 1] = unreadableV4[unreadableV4.length - 1]! ^ 1;
    const storage = memoryLocalStorage();
    const local = createLocalDataHome({ scope: 'highest-readable', storage });
    await seedLocal(local, goodV1, false);
    storage.replace(unreadableV4, 4, true);
    const quarantine = createMemoryVaultQuarantineStore();
    const engine = createVaultSyncEngine({
      local,
      primary: memoryRemote(remoteV3, 3),
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine,
    });

    await expect(engine.start()).resolves.toMatchObject({
      status: 'synced',
      active: { header: { vaultVersion: 5 } },
    });
    expect(engine.state.active?.document.entities.transaction?.map((row) => row.id)).toEqual([
      ENTITY_A,
      ENTITY_B,
    ]);
    await expect(quarantine.list()).resolves.toEqual([
      expect.objectContaining({ envelope: unreadableV4, version: 4 }),
    ]);
  });
});

describe('restore candidate seam', () => {
  it('enumerates exactly local quarantine and current server with explicit source outcomes', async () => {
    const blob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 2);
    const quarantine = createMemoryVaultQuarantineStore();
    await quarantine.put({
      medium: 'local',
      envelope: blob,
      version: 2,
      updatedAt: '2026-07-25T10:00:00.000Z',
      capturedAt: '2026-07-25T10:01:00.000Z',
      status: 'unreadable',
      reason: 'wrong key',
    });
    const sources = createRestoreCandidateSources(quarantine, memoryRemote(blob, 2));
    expect(sources.map((source) => source.id)).toEqual(['quarantined-local', 'current-server']);
    const listed = await createRestorePicker(sources, memoryRemote(blob, 2)).listCandidates();
    expect(listed.sources.map((source) => source.status)).toEqual(['ok', 'ok']);
    expect(listed.candidates).toEqual([
      expect.objectContaining({ source: 'quarantined-local', status: 'unreadable' }),
      expect.objectContaining({ source: 'current-server', status: 'available' }),
    ]);

    const transport = createCurrentServerRestoreCandidateSource(offlineRemote());
    await expect(transport.list()).resolves.toMatchObject({
      status: 'transport-failure',
      medium: 'server',
    });
    const corruptHome: DataHome = {
      ...offlineRemote(),
      async read() {
        return {
          status: 'corrupt',
          medium: 'server',
          version: null,
          updatedAt: null,
          reason: 'missing-version',
          message: 'missing ETag',
        };
      },
    };
    await expect(
      createCurrentServerRestoreCandidateSource(corruptHome).list(),
    ).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'missing ETag',
    });
    await expect(
      createQuarantinedRestoreCandidateSource(createMemoryVaultQuarantineStore()).list(),
    ).resolves.toMatchObject({ status: 'ok', candidates: [] });
  });

  it('adds blind server history and restores a selected version only through a new CAS', async () => {
    const historical = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 2);
    const current = await encrypted(document([entity(ENTITY_B, 3, DEVICE_B)]), 3);
    const archivedAt = '2026-07-25T10:05:00.000Z';
    const urls: string[] = [];
    const history = createServerHistoryRestoreCandidateSource({
      url: 'https://api.bt.test/api/v1/vault/history',
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('?')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  version: 2,
                  createdAt: archivedAt,
                  sizeBytes: historical.byteLength,
                  medium: 'server',
                },
              ],
              nextCursor: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(historical, {
          status: 200,
          headers: {
            ETag: '"2"',
            [VAULT_HISTORY_CREATED_AT_HEADER]: archivedAt,
            [VAULT_HISTORY_SIZE_BYTES_HEADER]: String(historical.byteLength),
            [VAULT_HISTORY_MEDIUM_HEADER]: 'server',
          },
        });
      },
    });
    const quarantine = createMemoryVaultQuarantineStore();
    const destination = memoryRemote(current, 3);
    const sources = createRestoreCandidateSources(quarantine, destination, history);
    expect(sources.map((source) => source.id)).toEqual([
      'quarantined-local',
      'current-server',
      'server-history',
    ]);

    const picker = createRestorePicker(sources, destination);
    const listed = await picker.listCandidates();
    const candidate = listed.candidates.find((item) => item.source === 'server-history');
    if (!candidate) throw new Error('Expected a retained server-history candidate.');
    expect(candidate).toMatchObject({
      id: 'server-history-2',
      version: 2,
      updatedAt: archivedAt,
      status: 'available',
    });
    expect(urls).toEqual([
      'https://api.bt.test/api/v1/vault/history?limit=10',
      'https://api.bt.test/api/v1/vault/history/2',
    ]);

    let activatedVersion: number | null = null;
    await expect(
      picker.restore(candidate, {
        vaultKey: KEY,
        activeVersion: 3,
        encrypt: (value, version) => encrypted(value, version),
        activate: (_value, _envelope, version) => {
          activatedVersion = version;
        },
      }),
    ).resolves.toEqual({ status: 'restored', version: 4 });
    expect(destination.expectedVersions).toEqual([3]);
    expect(activatedVersion).toBe(4);

    const restored = await destination.read();
    expect(restored).toMatchObject({ status: 'ok', info: { version: 4 } });
    if (restored.status !== 'ok') throw new Error('Expected restored remote bytes.');
    await expect(decryptVaultDocument(restored.envelope, KEY)).resolves.toMatchObject({
      document: { entities: { transaction: [expect.objectContaining({ id: ENTITY_A })] } },
    });
  });

  it('follows server history pagination to candidates older than the first page', async () => {
    const versions = Array.from(
      { length: VAULT_HISTORY_PAGE_MAX + 1 },
      (_, index) => VAULT_HISTORY_PAGE_MAX + 2 - index,
    );
    const records = new Map(
      await Promise.all(
        versions.map(async (version) => {
          const envelope = await encrypted(
            document([entity(ENTITY_A, version, DEVICE_A)]),
            version,
          );
          return [
            version,
            {
              envelope,
              createdAt: new Date(Date.UTC(2026, 6, 25, 10, 0, version)).toISOString(),
            },
          ] as const;
        }),
      ),
    );
    const listUrls: string[] = [];
    const history = createServerHistoryRestoreCandidateSource({
      url: 'https://api.bt.test/api/v1/vault/history',
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/history')) {
          listUrls.push(url.toString());
          const cursor = url.searchParams.get('cursor');
          const pageVersions =
            cursor === null
              ? versions.slice(0, VAULT_HISTORY_PAGE_MAX)
              : versions.slice(VAULT_HISTORY_PAGE_MAX);
          expect(cursor === null || cursor === String(versions[VAULT_HISTORY_PAGE_MAX - 1])).toBe(
            true,
          );
          return new Response(
            JSON.stringify({
              items: pageVersions.map((version) => {
                const record = records.get(version);
                if (!record) throw new Error(`Missing history fixture ${version}.`);
                return {
                  version,
                  createdAt: record.createdAt,
                  sizeBytes: record.envelope.byteLength,
                  medium: 'server',
                };
              }),
              nextCursor: cursor === null ? versions[VAULT_HISTORY_PAGE_MAX - 1] : null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const version = Number(url.pathname.split('/').at(-1));
        const record = records.get(version);
        if (!record) return new Response(null, { status: 404 });
        return new Response(record.envelope, {
          status: 200,
          headers: {
            ETag: `"${version}"`,
            [VAULT_HISTORY_CREATED_AT_HEADER]: record.createdAt,
            [VAULT_HISTORY_SIZE_BYTES_HEADER]: String(record.envelope.byteLength),
            [VAULT_HISTORY_MEDIUM_HEADER]: 'server',
          },
        });
      },
    });

    const listed = await history.list();
    expect(listed.status).toBe('ok');
    if (listed.status !== 'ok') throw new Error('Expected paginated server history.');
    expect(listed.candidates).toHaveLength(VAULT_HISTORY_PAGE_MAX + 1);
    expect(listed.candidates.find((candidate) => candidate.version === 2)).toMatchObject({
      id: 'server-history-2',
      version: 2,
      status: 'available',
    });
    expect(listUrls).toEqual([
      `https://api.bt.test/api/v1/vault/history?limit=${VAULT_HISTORY_PAGE_MAX}`,
      `https://api.bt.test/api/v1/vault/history?limit=${VAULT_HISTORY_PAGE_MAX}&cursor=${
        versions[VAULT_HISTORY_PAGE_MAX - 1]
      }`,
    ]);
  });

  it('leaves activation unchanged on cancel, wrong key, invalid status and lost CAS', async () => {
    const blob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 2);
    const corruptBlob = blob.slice();
    corruptBlob[0] = 0;
    let activations = 0;
    const destination = memoryRemote(blob, 3);
    destination.alwaysConflict = true;
    const picker = createRestorePicker([], destination);
    const candidate: RestoreCandidate = {
      id: 'candidate',
      source: 'fixture',
      medium: 'local',
      envelope: blob,
      version: 2,
      updatedAt: null,
      status: 'available',
    };
    const options = {
      vaultKey: KEY,
      activeVersion: 3,
      encrypt: (value: VaultDocumentV1, version: number) => encrypted(value, version),
      activate: () => {
        activations += 1;
      },
    };
    const decoded = decodeContractEnvelope(blob);
    const newerEnvelope = encodeContractEnvelope(
      {
        ...(decoded.header as Record<string, unknown>),
        schemaVersion: 2,
      },
      decoded.ciphertext,
    );

    await expect(picker.restore(null, options)).resolves.toEqual({ status: 'cancelled' });
    await expect(
      picker.restore(candidate, { ...options, vaultKey: new Uint8Array(32).fill(8) }),
    ).resolves.toMatchObject({ status: 'invalid-selection' });
    await expect(
      picker.restore({ ...candidate, envelope: corruptBlob, status: 'corrupt' }, options),
    ).resolves.toMatchObject({ status: 'invalid-selection' });
    await expect(
      picker.restore({ ...candidate, status: 'unsupported' }, options),
    ).resolves.toMatchObject({ status: 'invalid-selection' });
    await expect(
      picker.restore({ ...candidate, envelope: newerEnvelope }, options),
    ).resolves.toMatchObject({ status: 'invalid-selection' });
    await expect(picker.restore(candidate, options)).resolves.toEqual({
      status: 'conflict',
      currentVersion: 3,
    });
    expect(activations).toBe(0);
  });

  it('restores an actual quarantined wrong-key candidate with the correct key', async () => {
    const candidateBlob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 2);
    const quarantine = createMemoryVaultQuarantineStore();
    const local = createLocalDataHome({
      scope: 'wrong-key-quarantine',
      storage: memoryLocalStorage(),
    });
    const wrongKeyEngine = createVaultSyncEngine({
      local,
      primary: memoryRemote(candidateBlob, 2),
      vaultKey: new Uint8Array(32).fill(8),
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine,
    });
    await expect(wrongKeyEngine.start()).resolves.toMatchObject({ status: 'locked' });

    const source = createQuarantinedRestoreCandidateSource(quarantine);
    const current = await encrypted(document([entity(ENTITY_B, 3, DEVICE_B)]), 3);
    const destination = memoryRemote(current, 3);
    const picker = createRestorePicker([source], destination);
    const listed = await picker.listCandidates();
    expect(listed.candidates).toHaveLength(1);
    const candidate = listed.candidates[0];
    if (candidate == null) throw new Error('Expected the quarantined wrong-key candidate.');
    expect(candidate).toMatchObject({
      source: 'quarantined-local',
      status: 'unreadable',
      version: 2,
    });
    let activatedVersion: number | null = null;

    await expect(
      picker.restore(candidate, {
        vaultKey: KEY,
        activeVersion: 3,
        encrypt: (value, version) => encrypted(value, version),
        activate: (_value, _envelope, version) => {
          activatedVersion = version;
        },
      }),
    ).resolves.toEqual({ status: 'restored', version: 4 });
    expect(destination.expectedVersions).toEqual([3]);
    expect(activatedVersion).toBe(4);
  });

  it('uses authenticated envelope metadata when quarantined external metadata was corrupt', async () => {
    const candidateBlob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 2);
    const quarantine = createMemoryVaultQuarantineStore();
    await quarantine.put({
      medium: 'local',
      envelope: candidateBlob,
      version: 99,
      updatedAt: '2026-07-25T10:00:00.000Z',
      capturedAt: '2026-07-25T10:01:00.000Z',
      status: 'corrupt',
      reason: 'External version metadata did not match.',
    });
    const current = await encrypted(document([entity(ENTITY_B, 3, DEVICE_B)]), 3);
    const destination = memoryRemote(current, 3);
    const picker = createRestorePicker(
      [createQuarantinedRestoreCandidateSource(quarantine)],
      destination,
    );
    const listed = await picker.listCandidates();
    const candidate = listed.candidates[0];
    if (candidate == null) throw new Error('Expected the quarantined metadata candidate.');

    await expect(
      picker.restore(candidate, {
        vaultKey: KEY,
        activeVersion: 3,
        encrypt: (value, version) => encrypted(value, version),
        activate: () => undefined,
      }),
    ).resolves.toEqual({ status: 'restored', version: 4 });
    expect(destination.expectedVersions).toEqual([3]);
  });

  it('leaves the destination unchanged for unrecoverable candidates from the actual quarantine source', async () => {
    const candidateBlob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 2);
    const corruptBlob = candidateBlob.slice();
    corruptBlob[0] = 0;
    const quarantine = createMemoryVaultQuarantineStore();
    for (const candidate of [
      {
        envelope: candidateBlob,
        status: 'unreadable' as const,
        reason: 'Previously opened with the wrong key.',
      },
      {
        envelope: corruptBlob,
        status: 'corrupt' as const,
        reason: 'Malformed encrypted bytes.',
      },
      {
        envelope: candidateBlob,
        status: 'unsupported' as const,
        reason: 'A newer vault schema is required.',
      },
    ]) {
      await quarantine.put({
        medium: 'local',
        envelope: candidate.envelope,
        version: 2,
        updatedAt: '2026-07-25T10:00:00.000Z',
        capturedAt: '2026-07-25T10:01:00.000Z',
        status: candidate.status,
        reason: candidate.reason,
      });
    }
    const current = await encrypted(document([entity(ENTITY_B, 3, DEVICE_B)]), 3);
    const destination = memoryRemote(current, 3);
    const picker = createRestorePicker(
      [createQuarantinedRestoreCandidateSource(quarantine)],
      destination,
    );
    const listed = await picker.listCandidates();
    let activations = 0;

    for (const candidate of listed.candidates) {
      await expect(
        picker.restore(candidate, {
          vaultKey: candidate.status === 'unreadable' ? new Uint8Array(32).fill(8) : KEY,
          activeVersion: 3,
          encrypt: (value, version) => encrypted(value, version),
          activate: () => {
            activations += 1;
          },
        }),
      ).resolves.toMatchObject({ status: 'invalid-selection' });
    }
    expect(destination.writeCalls).toBe(0);
    expect(activations).toBe(0);
    await expect(destination.read()).resolves.toMatchObject({
      status: 'ok',
      envelope: current,
      info: { version: 3 },
    });
  });

  it('validates a candidate and restores only through a new monotonic CAS version', async () => {
    const candidateBlob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 2);
    const current = await encrypted(document([entity(ENTITY_B, 3, DEVICE_B)]), 3);
    const destination = memoryRemote(current, 3);
    let activatedVersion: number | null = null;
    const picker = createRestorePicker([], destination);
    const candidate: RestoreCandidate = {
      id: 'candidate',
      source: 'fixture',
      medium: 'local',
      envelope: candidateBlob,
      version: 2,
      updatedAt: null,
      status: 'available',
    };

    await expect(
      picker.restore(candidate, {
        vaultKey: KEY,
        activeVersion: 3,
        encrypt: (value, version) => encrypted(value, version),
        activate: (_value, _envelope, version) => {
          activatedVersion = version;
        },
      }),
    ).resolves.toEqual({ status: 'restored', version: 4 });
    expect(destination.expectedVersions).toEqual([3]);
    expect(activatedVersion).toBe(4);
    const restored = await destination.read();
    expect(restored).toMatchObject({ status: 'ok', info: { version: 4 } });
    if (restored.status !== 'ok') throw new Error('Expected restored remote bytes.');
    await expect(decryptVaultDocument(restored.envelope, KEY)).resolves.toMatchObject({
      document: { entities: { transaction: [expect.objectContaining({ id: ENTITY_A })] } },
    });
  });
});

interface MemoryLocalStorage extends LocalDataHomeStorage {
  beforeCompareAndSwap?: (ifVersion: number | null) => void;
  peek(): LocalVaultRecord | null;
  replace(envelope: Uint8Array, version: number, pendingRemote: boolean): void;
}

function memoryLocalStorage(): MemoryLocalStorage {
  let record: LocalVaultRecord | null = null;
  const storage: MemoryLocalStorage = {
    async read() {
      return cloneRecord(record);
    },
    async compareAndSwap(_scope, ifVersion, build) {
      storage.beforeCompareAndSwap?.(ifVersion);
      const currentVersion = record?.version ?? null;
      if (currentVersion !== ifVersion) {
        return { status: 'conflict', currentVersion };
      }
      record = cloneRecord(build(cloneRecord(record)));
      return { status: 'ok' };
    },
    peek() {
      return cloneRecord(record);
    },
    replace(envelope, version, pendingRemote) {
      record = {
        ...(record ?? {
          recordVersion: 1,
          updatedAt: '2026-07-25T10:00:00.000Z',
        }),
        envelope: toArrayBuffer(envelope),
        version,
        pendingRemote,
      };
    },
  };
  return storage;
}

async function seedLocal(
  local: LocalDataHome,
  envelope: Uint8Array,
  pending: boolean,
): Promise<void> {
  const written = await local.write(envelope, { ifVersion: null });
  if (written.status !== 'ok') throw new Error('Could not seed local vault.');
  const version = written.info.version;
  const marked = await local.markLastKnownGood(envelope, { ifVersion: version });
  if (marked.status !== 'ok') throw new Error('Could not seed last-known-good vault.');
  const pendingResult = await local.setPendingRemote(pending, { ifVersion: version });
  if (pendingResult.status !== 'ok') throw new Error('Could not seed pending metadata.');
}

interface MemoryRemote extends DataHome {
  writeCalls: number;
  expectedVersions: (number | null)[];
  alwaysConflict: boolean;
  afterSuccessfulWrite?: () => void;
}

function memoryRemote(
  initial: Uint8Array,
  initialVersion: number,
  conflictEnvelopes: Uint8Array[] = [],
): MemoryRemote {
  let envelope = initial.slice();
  let version = initialVersion;
  const remote: MemoryRemote = {
    medium: 'server',
    writeCalls: 0,
    expectedVersions: [],
    alwaysConflict: false,
    async read(): Promise<DataHomeReadResult> {
      return {
        status: 'ok',
        medium: 'server',
        envelope: envelope.slice(),
        info: {
          medium: 'server',
          version,
          sizeBytes: envelope.byteLength,
          updatedAt: null,
        },
      };
    },
    async info() {
      return {
        status: 'ok' as const,
        medium: 'server' as const,
        info: {
          medium: 'server' as const,
          version,
          sizeBytes: envelope.byteLength,
          updatedAt: null,
        },
      };
    },
    async write(next: Uint8Array, options: DataHomeWriteOptions): Promise<DataHomeWriteResult> {
      remote.writeCalls += 1;
      remote.expectedVersions.push(options.ifVersion);
      if (remote.alwaysConflict) {
        return { status: 'conflict', medium: 'server', currentVersion: version };
      }
      const conflict = conflictEnvelopes.shift();
      if (conflict != null) {
        envelope = conflict.slice();
        version = vaultVersion(conflict);
        return { status: 'conflict', medium: 'server', currentVersion: version };
      }
      if (options.ifVersion !== version) {
        return { status: 'conflict', medium: 'server', currentVersion: version };
      }
      envelope = next.slice();
      version = vaultVersion(next);
      remote.afterSuccessfulWrite?.();
      return {
        status: 'ok',
        medium: 'server',
        info: {
          medium: 'server',
          version,
          sizeBytes: envelope.byteLength,
          updatedAt: null,
        },
      };
    },
  };
  return remote;
}

function offlineRemote(): DataHome {
  return {
    medium: 'server',
    async read() {
      return {
        status: 'transport-failure',
        medium: 'server',
        failure: { message: 'offline' },
      };
    },
    async info() {
      return {
        status: 'transport-failure',
        medium: 'server',
        failure: { message: 'offline' },
      };
    },
    async write() {
      return {
        status: 'transport-failure',
        medium: 'server',
        failure: { message: 'offline' },
      };
    },
  };
}

function vaultVersion(envelope: Uint8Array): number {
  const magicLength = 'BTVAULT1'.length;
  const headerLength = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  ).getUint32(magicLength, false);
  const start = magicLength + 4;
  const parsed = JSON.parse(
    new TextDecoder().decode(envelope.subarray(start, start + headerLength)),
  ) as { vaultVersion: number };
  return parsed.vaultVersion;
}

function cloneRecord(record: LocalVaultRecord | null): LocalVaultRecord | null {
  return record == null
    ? null
    : {
        ...record,
        envelope: record.envelope.slice(0),
        lastKnownGood: record.lastKnownGood?.slice(0),
      };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not delete ${name}.`));
    request.onblocked = () => reject(new Error(`Deleting ${name} was blocked.`));
  });
}

function writeIds(): () => string {
  let value = 0xf0;
  return () => `018f0000-0000-7000-8000-0000000000${(value++).toString(16)}`;
}

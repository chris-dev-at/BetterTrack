import { webcrypto } from 'node:crypto';

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decodeVaultEnvelope as decodeContractEnvelope,
  encodeVaultEnvelope as encodeContractEnvelope,
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
  type RestoreCandidate,
} from './restore';
import { createServerBlobDataHome } from './serverBlobDataHome';
import { createVaultSyncEngine } from './sync';
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
    await expect(conflict.write(blob, { ifVersion: 3 })).resolves.toEqual({
      status: 'conflict',
      medium: 'server',
      currentVersion: 4,
    });
  });

  it('maps ETag and If-Match exactly and fails closed on mismatched metadata', async () => {
    const blob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 3);
    const calls: RequestInit[] = [];
    const mismatch = createServerBlobDataHome({
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
    });
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
});

describe('CAS-aware vault synchronization', () => {
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

  it('leaves activation unchanged on cancel, wrong key, invalid status and lost CAS', async () => {
    const blob = await encrypted(document([entity(ENTITY_A, 1, DEVICE_A)]), 2);
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
      picker.restore({ ...candidate, status: 'corrupt' }, options),
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

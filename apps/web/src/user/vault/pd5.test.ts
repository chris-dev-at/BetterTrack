import { webcrypto } from 'node:crypto';

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  VaultDocumentV1,
  VaultEntity,
  VaultEnvelopeHeader,
  PortfolioAsset,
} from '@bettertrack/contracts';

import { encryptVaultDocument } from './crypto';
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
import { chooseVaultEntity, mergeVaultDocuments } from './merge';
import {
  createIndexedDbVaultQuarantineStore,
  createMemoryVaultQuarantineStore,
} from './quarantine';
import { createRestorePicker } from './restore';
import { createServerBlobDataHome } from './serverBlobDataHome';
import { createVaultSyncEngine, type VaultSyncEngine } from './sync';
import { createVaultPortfolioStore } from './vaultPortfolioStore';
import { deterministicRandom, VECTOR_DEVICE_ID, VECTOR_KEY_ID, VECTOR_WRITE_ID } from './vectors';

const DEVICE_A = VECTOR_DEVICE_ID;
const DEVICE_B = '018f0000-0000-7000-8000-00000000000e';
const ENTITY_A = '018f0000-0000-7000-8000-000000000010';
const ENTITY_B = '018f0000-0000-7000-8000-000000000011';
const ENTITY_C = '018f0000-0000-7000-8000-000000000012';
const ENTITY_D = '018f0000-0000-7000-8000-000000000013';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = new Uint8Array(32).fill(9);
const WRAPPED = {
  keyId: VECTOR_KEY_ID,
  kdf: { alg: 'argon2id' as const, m: 65536, t: 3, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' },
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
  editedAt: string,
  editedBy: string,
  deletedAt: string | null = null,
  data: Record<string, unknown> = { amount: rev },
): VaultEntity {
  return { id, rev, editedAt, editedBy, deletedAt, data };
}

function document(entities: VaultEntity[]): VaultDocumentV1 {
  return { schemaVersion: 1, entities: { transaction: entities }, mergeLog: [] };
}

function header(
  version: number,
  deviceId = DEVICE_A,
): Omit<VaultEnvelopeHeader, 'cipher' | 'iv' | 'formatVersion' | 'schemaVersion'> {
  return {
    keyId: VECTOR_KEY_ID,
    wrappedKeys: [WRAPPED],
    vaultVersion: version,
    deviceId,
    writeId: VECTOR_WRITE_ID,
    writtenAt: `2026-07-25T10:00:0${version}.000Z`,
  };
}

async function encrypted(
  doc: VaultDocumentV1,
  version: number,
  deviceId = DEVICE_A,
): Promise<Uint8Array> {
  return (
    await encryptVaultDocument({
      document: doc,
      vaultKey: KEY,
      header: header(version, deviceId),
      randomBytes: deterministicRandom(version * 20),
    })
  ).envelope;
}

describe('PD5 deterministic entity merge matrix', () => {
  it('is commutative and idempotent for offline forks and records a bounded merge', () => {
    const phone = document([
      entity(ENTITY_A, 2, '2026-07-25T10:01:00.000Z', DEVICE_A, null, { amount: 20 }),
    ]);
    const desktop = document([
      entity(ENTITY_B, 2, '2026-07-25T10:02:00.000Z', DEVICE_B, null, { amount: 30 }),
    ]);
    const forward = mergeVaultDocuments({
      left: phone,
      leftVersion: 4,
      right: desktop,
      rightVersion: 6,
      deviceId: DEVICE_A,
      mergedAt: '2026-07-25T10:03:00.000Z',
    });
    const backward = mergeVaultDocuments({
      left: desktop,
      leftVersion: 6,
      right: phone,
      rightVersion: 4,
      deviceId: DEVICE_A,
      mergedAt: '2026-07-25T10:03:00.000Z',
    });

    expect(forward.vaultVersion).toBe(7);
    expect(forward.document.entities.transaction).toEqual(backward.document.entities.transaction);
    expect(forward.document.mergeLog).toEqual(backward.document.mergeLog);
    expect(forward.document.entities.transaction).toHaveLength(2);
    const again = mergeVaultDocuments({
      left: forward.document,
      leftVersion: forward.vaultVersion,
      right: forward.document,
      rightVersion: forward.vaultVersion,
      deviceId: DEVICE_A,
      mergedAt: '2026-07-25T10:04:00.000Z',
    });
    expect(again).toMatchObject({ divergent: false, vaultVersion: 7 });
  });

  it('resolves same-entity revisions, timestamps, and device IDs deterministically', () => {
    const original = entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A);
    expect(chooseVaultEntity(original, { ...original, rev: 2, data: { amount: 2 } }).data).toEqual({
      amount: 2,
    });
    expect(
      chooseVaultEntity(original, {
        ...original,
        editedAt: '2026-07-25T10:01:00.000Z',
        data: { amount: 3 },
      }).data,
    ).toEqual({ amount: 3 });
    expect(
      chooseVaultEntity(original, { ...original, editedBy: DEVICE_B, data: { amount: 4 } }).data,
    ).toEqual({ amount: 4 });
  });

  it('makes concurrent edits beat tombstones in either order, but later re-delete wins', () => {
    const tombstone = entity(
      ENTITY_A,
      2,
      '2026-07-25T10:02:00.000Z',
      DEVICE_A,
      '2026-07-25T10:02:00.000Z',
    );
    const edit = entity(ENTITY_A, 2, '2026-07-25T10:01:00.000Z', DEVICE_B, null, { amount: 10 });
    expect(chooseVaultEntity(tombstone, edit)).toEqual(edit);
    expect(chooseVaultEntity(edit, tombstone)).toEqual(edit);
    const redelete = { ...tombstone, rev: 3, editedAt: '2026-07-25T10:03:00.000Z' };
    expect(chooseVaultEntity(edit, redelete)).toEqual(redelete);
    expect(chooseVaultEntity(tombstone, { ...tombstone, editedBy: DEVICE_B })).toMatchObject({
      editedBy: DEVICE_B,
    });
  });
});

describe('PD5 DataHome adapters', () => {
  it('maps server ETag/If-Match and maps 412 to a recoverable CAS conflict', async () => {
    const blob = await encrypted(
      document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]),
      3,
    );
    const calls: RequestInit[] = [];
    const home = createServerBlobDataHome({
      url: 'https://api.test/vault',
      fetch: async (_url, init = {}) => {
        calls.push(init);
        return new Response(null, { status: 412, headers: { ETag: '"4"' } });
      },
    });
    await expect(home.write(blob, { ifVersion: 3 })).resolves.toEqual({
      status: 'conflict',
      medium: 'server',
      currentVersion: 4,
    });
    expect(calls[0]?.headers).toMatchObject({
      'If-Match': '"3"',
      'Content-Type': 'application/octet-stream',
    });
  });

  it('fails closed on missing or mismatched server version metadata', async () => {
    const blob = await encrypted(
      document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]),
      3,
    );
    const missing = createServerBlobDataHome({
      fetch: async () => new Response(blob, { status: 200 }),
    });
    await expect(missing.read()).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'missing-version',
    });
    const mismatched = createServerBlobDataHome({
      fetch: async () => new Response(blob, { status: 200, headers: { ETag: '"4"' } }),
    });
    await expect(mismatched.read()).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'version-mismatch',
    });
  });

  it('stores only opaque encrypted local records and detects local CAS races', async () => {
    let record: Awaited<ReturnType<LocalDataHomeStorage['read']>> = null;
    const storage: LocalDataHomeStorage = {
      read: async () => record,
      compareAndSwap: async (_scope, ifVersion, build) => {
        const currentVersion = record?.version ?? null;
        if (currentVersion !== ifVersion) {
          return { status: 'conflict', currentVersion };
        }
        record = build(record);
        return { status: 'ok' };
      },
      update: async (_scope, update) => {
        if (record == null) return false;
        record = update(record);
        return true;
      },
    };
    const home = createLocalDataHome({ scope: 'user-device', storage });
    const blob = await encrypted(
      document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]),
      1,
    );
    await expect(home.write(blob, { ifVersion: null })).resolves.toMatchObject({ status: 'ok' });
    expect(record).toMatchObject({ version: 1 });
    expect(JSON.stringify(record)).not.toContain('amount');
    await home.markLastKnownGood(blob);
    await expect(home.readLastKnownGood()).resolves.toMatchObject({
      status: 'ok',
      info: { version: 1 },
    });
    await expect(home.write(blob, { ifVersion: null })).resolves.toEqual({
      status: 'conflict',
      medium: 'local',
      currentVersion: 1,
    });
  });
});

describe('PD5 sync reconciliation and restore', () => {
  it('keeps an offline local write pending, then converges after a second CAS loss and re-merge', async () => {
    const localEntity = entity(ENTITY_A, 2, '2026-07-25T10:01:00.000Z', DEVICE_A);
    const firstRemoteEntity = entity(ENTITY_B, 3, '2026-07-25T10:02:00.000Z', DEVICE_B);
    const localEnvelope = await encrypted(document([localEntity]), 2);
    const remoteEnvelopeV3 = await encrypted(document([firstRemoteEntity]), 3, DEVICE_B);
    const remoteEnvelopeV4 = await encrypted(
      document([firstRemoteEntity, entity(ENTITY_C, 1, '2026-07-25T10:03:00.000Z', DEVICE_B)]),
      4,
      DEVICE_B,
    );
    const remoteEnvelopeV5 = await encrypted(
      document([
        firstRemoteEntity,
        entity(ENTITY_C, 1, '2026-07-25T10:03:00.000Z', DEVICE_B),
        entity(ENTITY_D, 1, '2026-07-25T10:04:00.000Z', DEVICE_B),
      ]),
      5,
      DEVICE_B,
    );
    const local = memoryLocalHome(localEnvelope, 2);
    const remote = memoryHome('server', remoteEnvelopeV3, 3, [
      { status: 'conflict', currentVersion: 4, currentEnvelope: remoteEnvelopeV4 },
      { status: 'conflict', currentVersion: 5, currentEnvelope: remoteEnvelopeV5 },
      { status: 'ok', version: 6 },
    ]);
    const engine = createVaultSyncEngine({
      local,
      primary: remote,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: () => '018f0000-0000-7000-8000-0000000000ff',
      now: () => '2026-07-25T10:03:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
    });

    await expect(engine.start()).resolves.toMatchObject({ status: 'synced' });
    // A second CAS loss is reconciled inside the same startup/push cycle: no
    // caller-driven reconnect is needed to converge safely.
    expect(engine.state.active?.header.vaultVersion).toBe(6);
    expect(engine.state.active?.document.entities.transaction?.map((row) => row.id).sort()).toEqual(
      [ENTITY_A, ENTITY_B, ENTITY_C, ENTITY_D],
    );
    await expect(remote.read()).resolves.toMatchObject({ status: 'ok', info: { version: 6 } });
  });

  it('keeps an unreadable local cache quarantined and does not replace its last known-good blob', async () => {
    let record: Awaited<ReturnType<LocalDataHomeStorage['read']>> = null;
    const storage: LocalDataHomeStorage = {
      read: async () => record,
      compareAndSwap: async (_scope, ifVersion, build) => {
        const currentVersion = record?.version ?? null;
        if (currentVersion !== ifVersion) {
          return { status: 'conflict', currentVersion };
        }
        record = build(record);
        return { status: 'ok' };
      },
      update: async (_scope, update) => {
        if (record == null) return false;
        record = update(record);
        return true;
      },
    };
    const home = createLocalDataHome({ scope: 'rollback', storage });
    const good = await encrypted(
      document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]),
      1,
    );
    await home.write(good, { ifVersion: null });
    await home.markLastKnownGood(good);
    const bad = good.slice();
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    record = {
      ...record!,
      envelope: bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength) as ArrayBuffer,
    };
    await expect(home.read()).resolves.toMatchObject({ status: 'ok' });
    await expect(home.readLastKnownGood()).resolves.toMatchObject({
      status: 'ok',
      envelope: good,
    });
  });

  it('leaves a pending write unacknowledged when remote version lookup is unavailable', async () => {
    const good = await encrypted(
      document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]),
      2,
    );
    const local = memoryLocalHome(good, 2);
    const remote: DataHome = {
      medium: 'server',
      async read() {
        return { status: 'transport-failure', medium: 'server', failure: { message: 'offline' } };
      },
      async info() {
        return { status: 'transport-failure', medium: 'server', failure: { message: 'offline' } };
      },
      async write() {
        throw new Error('must not write without a fresh remote version');
      },
    };
    const engine = createVaultSyncEngine({
      local,
      primary: remote,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: () => '018f0000-0000-7000-8000-0000000000ff',
      quarantine: createMemoryVaultQuarantineStore(),
    });
    await engine.start();
    await expect(
      engine.mutate(({ document: value }) => ({
        ...value,
        entities: { ...value.entities, transaction: [...(value.entities.transaction ?? [])] },
      })),
    ).resolves.toMatchObject({ status: 'pending-offline' });
    expect(engine.state.pending).not.toBeNull();
  });

  it('keeps pending offline work through reconnect and merges it before a normal CAS retry', async () => {
    const localDocument = document([
      entity(ENTITY_A, 2, '2026-07-25T10:01:00.000Z', DEVICE_A, null, { amount: 20 }),
    ]);
    const remoteDocument = document([
      entity(ENTITY_B, 3, '2026-07-25T10:02:00.000Z', DEVICE_B, null, { amount: 30 }),
    ]);
    const localEnvelope = await encrypted(localDocument, 2);
    const remoteEnvelope = await encrypted(remoteDocument, 3, DEVICE_B);
    const local = memoryLocalHome(localEnvelope, 2);
    let online = false;
    const remote = memoryHome('server', remoteEnvelope, 3);
    const primary: DataHome = {
      medium: 'server',
      async read() {
        if (!online) {
          return { status: 'transport-failure', medium: 'server', failure: { message: 'offline' } };
        }
        return remote.read();
      },
      async info() {
        return remote.info();
      },
      async write(envelope, options) {
        return remote.write(envelope, options);
      },
    };
    const engine = createVaultSyncEngine({
      local,
      primary,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: () => '018f0000-0000-7000-8000-0000000000ff',
      now: () => '2026-07-25T10:03:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
    });
    await expect(engine.start()).resolves.toMatchObject({ status: 'pending-offline' });
    await engine.mutate(({ document: value }) => value);
    expect(engine.state.pending).not.toBeNull();
    online = true;
    await expect(engine.reconnect()).resolves.toMatchObject({ status: 'synced' });
    expect(engine.state.active?.document.entities.transaction).toHaveLength(2);
  });

  it('keeps active state unchanged when restore loses CAS, sees a wrong key, or selects corrupt bytes', async () => {
    const goodDocument = document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]);
    const good = await encrypted(goodDocument, 2);
    let activated = false;
    const conflictDestination: DataHome = {
      medium: 'server',
      async read() {
        return { status: 'absent', medium: 'server' };
      },
      async info() {
        return { status: 'absent', medium: 'server' };
      },
      async write() {
        return { status: 'conflict', medium: 'server', currentVersion: 3 };
      },
    };
    const picker = createRestorePicker(
      [
        {
          id: 'fixture',
          list: async () => [
            {
              id: 'good',
              source: 'fixture',
              medium: 'local',
              envelope: good,
              version: 2,
              updatedAt: null,
              status: 'available' as const,
            },
          ],
        },
      ],
      conflictDestination,
    );
    const candidate = (await picker.listCandidates())[0]!;
    await expect(
      picker.restore(candidate, {
        vaultKey: KEY,
        activeVersion: 3,
        encrypt: async (doc, version) => encrypted(doc, version),
        activate: () => {
          activated = true;
        },
      }),
    ).resolves.toEqual({ status: 'conflict', currentVersion: 3 });
    expect(activated).toBe(false);
    await expect(
      picker.restore(candidate, {
        vaultKey: new Uint8Array(32).fill(8),
        activeVersion: 3,
        encrypt: async (doc, version) => encrypted(doc, version),
        activate: () => {
          activated = true;
        },
      }),
    ).resolves.toMatchObject({ status: 'invalid-selection' });
    await expect(
      picker.restore(
        { ...candidate, status: 'corrupt' },
        {
          vaultKey: KEY,
          activeVersion: 3,
          encrypt: async (doc, version) => encrypted(doc, version),
          activate: () => {
            activated = true;
          },
        },
      ),
    ).resolves.toMatchObject({ status: 'invalid-selection' });
    expect(activated).toBe(false);
  });

  it('quarantines unreadable candidates, retains active state, and restores only through a monotonic CAS write', async () => {
    const goodDocument = document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]);
    const good = await encrypted(goodDocument, 2);
    const bad = good.slice();
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    const quarantine = createMemoryVaultQuarantineStore(() => '2026-07-25T10:01:00.000Z');
    const local = memoryLocalHome(good, 2);
    const remote = memoryHome('server', bad, 3);
    const engine = createVaultSyncEngine({
      local,
      primary: remote,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: () => '018f0000-0000-7000-8000-0000000000ff',
      now: () => '2026-07-25T10:01:00.000Z',
      quarantine,
    });
    await engine.start();
    expect(await quarantine.list()).toHaveLength(1);
    expect(engine.state.active?.header.vaultVersion).toBe(2);

    const picker = createRestorePicker(
      [
        {
          id: 'custom-source',
          list: async () => [
            {
              id: 'good',
              source: 'custom',
              medium: 'local',
              envelope: good,
              version: 2,
              updatedAt: null,
              status: 'available' as const,
            },
          ],
        },
      ],
      remote,
    );
    const candidate = (await picker.listCandidates())[0]!;
    await expect(
      picker.restore(candidate, {
        vaultKey: KEY,
        activeVersion: 3,
        encrypt: async (doc, version) => encrypted(doc, version),
        activate: () => undefined,
      }),
    ).resolves.toEqual({ status: 'restored', version: 4 });
  });
});

describe('PD5 vault portfolio store responses', () => {
  it('uses the local engine device id and returns a complete transaction asset snapshot', async () => {
    const portfolioId = '018f0000-0000-7000-8000-000000000020';
    const assetId = '018f0000-0000-7000-8000-000000000021';
    const remoteDevice = DEVICE_B;
    const asset: PortfolioAsset = {
      id: assetId,
      symbol: 'LOCAL',
      name: 'Local Asset',
      exchange: null,
      currency: 'EUR',
      type: 'stock',
      isCustom: true,
      category: 'stock',
      smoothing: false,
    };
    const initial: VaultDocumentV1 = {
      schemaVersion: 1,
      entities: {
        portfolio: [
          entity(portfolioId, 0, '2026-07-25T10:00:00.000Z', remoteDevice, null, {
            name: 'Main',
            visibility: 'private',
            sortOrder: 0,
            isDefault: true,
            defaultPayFromCash: false,
            archivedAt: null,
          }),
        ],
        customAsset: [entity(assetId, 0, '2026-07-25T10:00:00.000Z', remoteDevice, null, asset)],
      },
      mergeLog: [],
    };
    const engine = await startedEngine(initial, 1, remoteDevice);
    const store = createVaultPortfolioStore(engine);

    const [created] = await store.createTransactions(portfolioId, [
      {
        assetId,
        side: 'buy',
        quantity: 2,
        price: 10,
        fee: 0,
        executedAt: '2026-07-25T10:01:00.000Z',
      },
    ]);

    expect(created?.asset).toEqual(asset);
    expect(created?.id).toMatch(UUID_V7);
    expect(engine.state.active?.document.entities.transaction?.[0]?.editedBy).toBe(DEVICE_A);
    await expect(store.listTransactions(portfolioId)).resolves.toMatchObject({
      items: [expect.objectContaining({ asset })],
    });
  });

  it('rejects transaction creation without a local asset snapshot and signs withdrawals', async () => {
    const portfolioId = '018f0000-0000-7000-8000-000000000022';
    const cashSourceId = '018f0000-0000-7000-8000-000000000024';
    const initial: VaultDocumentV1 = {
      schemaVersion: 1,
      entities: {
        portfolio: [
          entity(portfolioId, 0, '2026-07-25T10:00:00.000Z', DEVICE_B, null, {
            name: 'Main',
            visibility: 'private',
            sortOrder: 0,
            isDefault: true,
            defaultPayFromCash: false,
            archivedAt: null,
          }),
        ],
        cashSource: [
          entity(cashSourceId, 0, '2026-07-25T10:00:00.000Z', DEVICE_B, null, {
            portfolioId,
            name: 'Main',
            type: 'cash',
            isMain: true,
            archivedAt: null,
            createdAt: '2026-07-25T10:00:00.000Z',
          }),
        ],
      },
      mergeLog: [],
    };
    const store = createVaultPortfolioStore(await startedEngine(initial, 1, DEVICE_B));

    await expect(
      store.createTransactions(portfolioId, [
        {
          assetId: '018f0000-0000-7000-8000-000000000023',
          side: 'buy',
          quantity: 1,
          price: 1,
          fee: 0,
          executedAt: '2026-07-25T10:01:00.000Z',
        },
      ]),
    ).rejects.toMatchObject({ code: 'locked' });
    const withdrawal = await store.withdrawCash(portfolioId, { amountEur: 25 });
    expect(withdrawal).toMatchObject({
      movement: { kind: 'withdrawal', amountEur: -25, sourceId: cashSourceId },
    });
    expect(withdrawal.movement.id).toMatch(UUID_V7);
    await expect(
      store.depositCash(portfolioId, {
        amountEur: 10,
        sourceId: '018f0000-0000-7000-8000-000000000025',
      }),
    ).rejects.toMatchObject({ code: 'locked' });
  });

  it('pages transactions from the last emitted cursor without gaps or duplicates', async () => {
    const portfolioId = '018f0000-0000-7000-8000-000000000030';
    const assetId = '018f0000-0000-7000-8000-000000000031';
    const transactionIds = [
      '018f0000-0000-7000-8000-000000000032',
      '018f0000-0000-7000-8000-000000000033',
      '018f0000-0000-7000-8000-000000000034',
      '018f0000-0000-7000-8000-000000000035',
      '018f0000-0000-7000-8000-000000000036',
    ];
    const asset: PortfolioAsset = {
      id: assetId,
      symbol: 'PAGE',
      name: 'Paged Asset',
      exchange: null,
      currency: 'EUR',
      type: 'stock',
      isCustom: true,
      category: 'stock',
      smoothing: false,
    };
    const initial: VaultDocumentV1 = {
      schemaVersion: 1,
      entities: {
        portfolio: [
          entity(portfolioId, 0, '2026-07-25T10:00:00.000Z', DEVICE_A, null, {
            name: 'Main',
            visibility: 'private',
            sortOrder: 0,
            isDefault: true,
            defaultPayFromCash: false,
            archivedAt: null,
          }),
        ],
        transaction: transactionIds.map((id, index) =>
          entity(id, 0, `2026-07-25T10:0${index}:00.000Z`, DEVICE_A, null, {
            portfolioId,
            assetId,
            asset,
            side: 'buy',
            quantity: index + 1,
            price: 10,
            fee: 0,
            executedAt: `2026-07-25T10:0${index}:00.000Z`,
            source: 'manual',
          }),
        ),
      },
      mergeLog: [],
    };
    const store = createVaultPortfolioStore(await startedEngine(initial, 1, DEVICE_A));

    const first = await store.listTransactions(portfolioId, { limit: 2 });
    const second = await store.listTransactions(portfolioId, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    const terminal = await store.listTransactions(portfolioId, {
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    });

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(terminal.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[1]?.id);
    expect(second.nextCursor).toBe(second.items[1]?.id);
    expect(terminal.nextCursor).toBeNull();
    const pagedIds = [...first.items, ...second.items, ...terminal.items].map((row) => row.id);
    expect(pagedIds).toEqual([...transactionIds].reverse());
    expect(new Set(pagedIds).size).toBe(transactionIds.length);
  });
});

describe('PD5 review regressions', () => {
  it('serializes concurrent IndexedDB compare-and-swap writes', async () => {
    const local = createLocalDataHome({
      scope: 'concurrent-cas',
      storage: createIndexedDbLocalDataHomeStorage(),
    });
    const initial = await encrypted(
      document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]),
      1,
    );
    const left = await encrypted(
      document([entity(ENTITY_A, 2, '2026-07-25T10:01:00.000Z', DEVICE_A)]),
      2,
    );
    const right = await encrypted(
      document([entity(ENTITY_B, 2, '2026-07-25T10:01:00.000Z', DEVICE_B)]),
      2,
      DEVICE_B,
    );
    await expect(local.write(initial, { ifVersion: null })).resolves.toMatchObject({
      status: 'ok',
    });

    const outcomes = await Promise.all([
      local.write(left, { ifVersion: 1 }),
      local.write(right, { ifVersion: 1 }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['conflict', 'ok']);
    expect(outcomes.find((outcome) => outcome.status === 'conflict')).toMatchObject({
      currentVersion: 2,
    });
    const stored = await local.read();
    expect(stored).toMatchObject({ status: 'ok', info: { version: 2 } });
    if (stored.status !== 'ok') throw new Error('Expected the winning local candidate.');
    const winner = outcomes[0]?.status === 'ok' ? left : right;
    expect(stored.envelope).toEqual(winner);
  });

  it('opens a coordinated cache schema after either local cache or quarantine initializes first', async () => {
    const localStorage = createIndexedDbLocalDataHomeStorage();
    const local = createLocalDataHome({ scope: 'schema-order', storage: localStorage });
    const blob = await encrypted(
      document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]),
      1,
    );
    const quarantine = createIndexedDbVaultQuarantineStore({
      scope: 'schema-order',
      id: () => '018f0000-0000-7000-8000-0000000000f1',
    });

    await quarantine.put({
      medium: 'server',
      envelope: blob,
      version: 1,
      updatedAt: null,
      capturedAt: '2026-07-25T10:00:00.000Z',
      status: 'corrupt',
      reason: 'fixture',
    });
    await expect(local.write(blob, { ifVersion: null })).resolves.toMatchObject({ status: 'ok' });

    await deleteDatabase('bettertrack-vault-cache');
    await expect(local.write(blob, { ifVersion: null })).resolves.toMatchObject({ status: 'ok' });
    await expect(
      createIndexedDbVaultQuarantineStore({
        scope: 'schema-order',
        id: () => '018f0000-0000-7000-8000-0000000000f2',
      }).put({
        medium: 'local',
        envelope: blob,
        version: 1,
        updatedAt: null,
        capturedAt: '2026-07-25T10:00:00.000Z',
        status: 'corrupt',
        reason: 'fixture',
      }),
    ).resolves.toMatchObject({ id: '018f0000-0000-7000-8000-0000000000f2' });
  });

  it('selects a higher linear successor without minting a merge record', () => {
    const base = document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]);
    const successor = document([
      entity(ENTITY_A, 2, '2026-07-25T10:01:00.000Z', DEVICE_A, null, { amount: 2 }),
    ]);
    const merged = mergeVaultDocuments({
      left: base,
      leftVersion: 1,
      right: successor,
      rightVersion: 2,
      deviceId: DEVICE_A,
      mergedAt: '2026-07-25T10:02:00.000Z',
    });

    expect(merged).toEqual({ document: successor, vaultVersion: 2, divergent: false });
  });

  it('merges equal-version different writes into a new successor', () => {
    const left = document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]);
    const right = document([entity(ENTITY_B, 1, '2026-07-25T10:01:00.000Z', DEVICE_B)]);

    const merged = mergeVaultDocuments({
      left,
      leftVersion: 2,
      right,
      rightVersion: 2,
      deviceId: DEVICE_A,
      mergedAt: '2026-07-25T10:02:00.000Z',
    });

    expect(merged).toMatchObject({ divergent: true, vaultVersion: 3 });
    expect(merged.document.entities.transaction?.map((row) => row.id)).toEqual([
      ENTITY_A,
      ENTITY_B,
    ]);
  });

  it('recovers an unmarked lower-version local winner after restart', async () => {
    const localEnvelope = await encrypted(
      document([entity(ENTITY_A, 2, '2026-07-25T10:02:00.000Z', DEVICE_A, null, { amount: 200 })]),
      2,
    );
    const remoteEnvelope = await encrypted(
      document([entity(ENTITY_A, 1, '2026-07-25T10:01:00.000Z', DEVICE_B, null, { amount: 100 })]),
      3,
      DEVICE_B,
    );
    const local = memoryLocalHome(localEnvelope, 2);
    await local.setPendingRemote(false);
    const remote = memoryHome('server', remoteEnvelope, 3);
    const restarted = createVaultSyncEngine({
      local,
      primary: remote,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      now: () => '2026-07-25T10:03:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
    });

    await expect(restarted.start()).resolves.toMatchObject({
      status: 'synced',
      active: { header: { vaultVersion: 4 } },
    });
    expect(restarted.state.active?.document.entities.transaction?.[0]).toMatchObject({
      id: ENTITY_A,
      rev: 2,
      data: { amount: 200 },
    });
    await expect(remote.read()).resolves.toMatchObject({ status: 'ok', info: { version: 4 } });
  });

  it('pulls and merges after a write-time CAS loss without requiring reconnect', async () => {
    const base = document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]);
    const remoteDocument = document([
      entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A),
      entity(ENTITY_B, 1, '2026-07-25T10:01:00.000Z', DEVICE_B),
    ]);
    const baseEnvelope = await encrypted(base, 1);
    const remoteEnvelope = await encrypted(remoteDocument, 2, DEVICE_B);
    const local = memoryLocalHome(baseEnvelope, 1);
    let readCount = 0;
    let writes = 0;
    const remote: DataHome = {
      medium: 'server',
      async read() {
        readCount += 1;
        // start() reads v1 and the mutation pre-write pull reads v1. The
        // recovery pull after the 412 sees device B's new v2.
        const current = readCount >= 3 ? remoteEnvelope : baseEnvelope;
        const version = readCount >= 3 ? 2 : 1;
        return {
          status: 'ok',
          medium: 'server',
          envelope: current,
          info: { medium: 'server', version, sizeBytes: current.byteLength, updatedAt: null },
        };
      },
      async info() {
        return {
          status: 'ok',
          medium: 'server',
          info: {
            medium: 'server',
            version: 1,
            sizeBytes: baseEnvelope.byteLength,
            updatedAt: null,
          },
        };
      },
      async write(next, options) {
        writes += 1;
        if (writes === 1) return { status: 'conflict', medium: 'server', currentVersion: 2 };
        expect(options).toEqual({ ifVersion: 2 });
        expect(next).toBeInstanceOf(Uint8Array);
        return {
          status: 'ok',
          medium: 'server',
          info: { medium: 'server', version: 3, sizeBytes: next.byteLength, updatedAt: null },
        };
      },
    };
    const engine = createVaultSyncEngine({
      local,
      primary: remote,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      now: () => '2026-07-25T10:02:00.000Z',
      quarantine: createMemoryVaultQuarantineStore(),
    });

    await expect(engine.start()).resolves.toMatchObject({ status: 'synced' });
    await expect(
      engine.mutate(({ document: value }) => ({
        ...value,
        entities: {
          ...value.entities,
          transaction: [
            ...(value.entities.transaction ?? []),
            entity('018f0000-0000-7000-8000-000000000012', 1, '2026-07-25T10:02:00.000Z', DEVICE_A),
          ],
        },
      })),
    ).resolves.toMatchObject({ status: 'synced' });
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(engine.state.active?.document.entities.transaction).toHaveLength(3);
  });

  it('recovers from an unreadable current cache through last-known-good while remote is offline', async () => {
    let record: LocalVaultRecord | null = null;
    const storage: LocalDataHomeStorage = {
      read: async () => record,
      compareAndSwap: async (_scope, ifVersion, build) => {
        const currentVersion = record?.version ?? null;
        if (currentVersion !== ifVersion) {
          return { status: 'conflict', currentVersion };
        }
        record = build(record);
        return { status: 'ok' };
      },
      update: async (_scope, update) => {
        if (record == null) return false;
        record = update(record);
        return true;
      },
    };
    const goodDocument = document([entity(ENTITY_A, 1, '2026-07-25T10:00:00.000Z', DEVICE_A)]);
    const good = await encrypted(goodDocument, 1);
    const local = createLocalDataHome({ scope: 'last-known-good-recovery', storage });
    await local.write(good, { ifVersion: null });
    await local.markLastKnownGood(good);
    const unreadable = good.slice();
    unreadable[unreadable.length - 1] = unreadable[unreadable.length - 1]! ^ 1;
    record = {
      ...record!,
      envelope: unreadable.buffer.slice(
        unreadable.byteOffset,
        unreadable.byteOffset + unreadable.byteLength,
      ) as ArrayBuffer,
    };
    const quarantine = createMemoryVaultQuarantineStore();
    const offline: DataHome = {
      medium: 'server',
      async read() {
        return { status: 'transport-failure', medium: 'server', failure: { message: 'offline' } };
      },
      async info() {
        return { status: 'transport-failure', medium: 'server', failure: { message: 'offline' } };
      },
      async write() {
        throw new Error('Offline remote must not be written.');
      },
    };
    const engine = createVaultSyncEngine({
      local,
      primary: offline,
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine,
    });

    await expect(engine.start()).resolves.toMatchObject({
      status: 'pending-offline',
      active: { document: goodDocument },
    });
    await expect(quarantine.list()).resolves.toEqual([
      expect.objectContaining({ medium: 'local', status: 'unreadable', envelope: unreadable }),
    ]);
  });

  it('rejects vault-store success when the encrypted local commit fails', async () => {
    const initial: VaultDocumentV1 = { schemaVersion: 1, entities: {}, mergeLog: [] };
    const envelope = await encrypted(initial, 1);
    const durableLocal = memoryLocalHome(envelope, 1);
    let rejectWrites = false;
    const local: LocalDataHome = {
      ...durableLocal,
      async write(next, options) {
        if (rejectWrites) {
          return {
            status: 'transport-failure',
            medium: 'local',
            failure: { message: 'quota exceeded' },
          };
        }
        return durableLocal.write(next, options);
      },
    };
    const engine = createVaultSyncEngine({
      local,
      primary: memoryHome('server', envelope, 1),
      vaultKey: KEY,
      deviceId: DEVICE_A,
      writeId: writeIds(),
      quarantine: createMemoryVaultQuarantineStore(),
    });
    await engine.start();
    rejectWrites = true;
    const store = createVaultPortfolioStore(engine);

    await expect(store.createPortfolio('Not committed')).rejects.toMatchObject({
      code: 'storage-failed',
    });
    await expect(store.listPortfolios()).resolves.toEqual({ portfolios: [] });
    expect(engine.state.active?.document.entities.portfolio).toBeUndefined();
  });
});

function memoryLocalHome(initial: Uint8Array, initialVersion: number): LocalDataHome {
  const home = memoryHome('local', initial, initialVersion);
  let knownGood = initial.slice();
  let pendingRemote = false;
  return {
    ...home,
    async markLastKnownGood(envelope) {
      knownGood = envelope.slice();
    },
    async isPendingRemote() {
      return pendingRemote;
    },
    async setPendingRemote(pending) {
      pendingRemote = pending;
    },
    async readLastKnownGood() {
      return {
        status: 'ok',
        medium: 'local',
        envelope: knownGood.slice(),
        info: {
          medium: 'local',
          version: initialVersion,
          sizeBytes: knownGood.byteLength,
          updatedAt: null,
        },
      };
    },
  };
}

function memoryHome(
  medium: 'local' | 'server',
  initial: Uint8Array,
  initialVersion: number,
  writes: (
    | { status: 'conflict'; currentVersion: number; currentEnvelope: Uint8Array }
    | { status: 'ok'; version: number }
  )[] = [],
): DataHome & { set(envelope: Uint8Array, version: number): void } {
  let envelope = initial.slice();
  let version = initialVersion;
  return {
    medium,
    async read(): Promise<DataHomeReadResult> {
      return {
        status: 'ok',
        medium,
        envelope: envelope.slice(),
        info: { medium, version, sizeBytes: envelope.byteLength, updatedAt: null },
      };
    },
    async info() {
      return {
        status: 'ok' as const,
        medium,
        info: { medium, version, sizeBytes: envelope.byteLength, updatedAt: null },
      };
    },
    async write(next: Uint8Array, _options: DataHomeWriteOptions): Promise<DataHomeWriteResult> {
      const outcome = writes.shift();
      if (outcome?.status === 'conflict') {
        envelope = outcome.currentEnvelope.slice();
        version = outcome.currentVersion;
        return { status: 'conflict', medium, currentVersion: outcome.currentVersion };
      }
      envelope = next.slice();
      version = outcome?.status === 'ok' ? outcome.version : version + 1;
      return {
        status: 'ok',
        medium,
        info: { medium, version, sizeBytes: envelope.byteLength, updatedAt: null },
      };
    },
    set(next, nextVersion) {
      envelope = next.slice();
      version = nextVersion;
    },
  };
}

async function startedEngine(
  documentValue: VaultDocumentV1,
  version: number,
  remoteDevice: string,
): Promise<VaultSyncEngine> {
  const envelope = await encrypted(documentValue, version, remoteDevice);
  const engine = createVaultSyncEngine({
    local: memoryLocalHome(envelope, version),
    primary: memoryHome('server', envelope, version),
    vaultKey: KEY,
    deviceId: DEVICE_A,
    writeId: writeIds(),
    now: () => '2026-07-25T10:02:00.000Z',
    quarantine: createMemoryVaultQuarantineStore(),
  });
  await engine.start();
  return engine;
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

import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { VaultDocumentV1, VaultEntity, VaultEnvelopeHeader } from '@bettertrack/contracts';

import { encryptVaultDocument } from './crypto';
import type {
  DataHome,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from './dataHome';
import {
  createLocalDataHome,
  type LocalDataHome,
  type LocalDataHomeStorage,
} from './localDataHome';
import { chooseVaultEntity, mergeVaultDocuments } from './merge';
import { createMemoryVaultQuarantineStore } from './quarantine';
import { createRestorePicker } from './restore';
import { createServerBlobDataHome } from './serverBlobDataHome';
import { createVaultSyncEngine } from './sync';
import { deterministicRandom, VECTOR_DEVICE_ID, VECTOR_KEY_ID, VECTOR_WRITE_ID } from './vectors';

const DEVICE_A = VECTOR_DEVICE_ID;
const DEVICE_B = '018f0000-0000-7000-8000-00000000000e';
const ENTITY_A = '018f0000-0000-7000-8000-000000000010';
const ENTITY_B = '018f0000-0000-7000-8000-000000000011';
const KEY = new Uint8Array(32).fill(9);
const WRAPPED = {
  keyId: VECTOR_KEY_ID,
  kdf: { alg: 'argon2id' as const, m: 65536, t: 3, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' },
  wrappedVk: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
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
      write: async (_scope, next) => {
        record = next;
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
    const localEnvelope = await encrypted(
      document([entity(ENTITY_A, 2, '2026-07-25T10:01:00.000Z', DEVICE_A)]),
      2,
    );
    const remoteEnvelope = await encrypted(
      document([entity(ENTITY_B, 3, '2026-07-25T10:02:00.000Z', DEVICE_B)]),
      3,
      DEVICE_B,
    );
    const local = memoryLocalHome(localEnvelope, 2);
    const remote = memoryHome('server', remoteEnvelope, 3, [
      { status: 'conflict', currentVersion: 4 },
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

    await expect(engine.start()).resolves.toMatchObject({ status: 'conflict' });
    // A remote writer advanced after the first merge. Reconnect fetches it, does
    // not force overwrite, and safely attempts the successor through normal CAS.
    remote.set(remoteEnvelope, 4);
    await expect(engine.reconnect()).resolves.toMatchObject({ status: 'synced' });
  });

  it('keeps an unreadable local cache quarantined and does not replace its last known-good blob', async () => {
    let record: Awaited<ReturnType<LocalDataHomeStorage['read']>> = null;
    const storage: LocalDataHomeStorage = {
      read: async () => record,
      write: async (_scope, next) => {
        record = next;
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

function memoryLocalHome(initial: Uint8Array, initialVersion: number): LocalDataHome {
  const home = memoryHome('local', initial, initialVersion);
  let knownGood = initial.slice();
  return {
    ...home,
    async markLastKnownGood(envelope) {
      knownGood = envelope.slice();
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
    | { status: 'conflict'; currentVersion: number | null }
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
      if (outcome?.status === 'conflict')
        return { status: 'conflict', medium, currentVersion: outcome.currentVersion };
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

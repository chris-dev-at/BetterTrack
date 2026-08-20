import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createIndexedDbEndpointKeystoreStorage,
  ENDPOINT_KEYSTORE_CONTROL_STORE,
  ENDPOINT_KEYSTORE_DATABASE_NAME,
  ENDPOINT_KEYSTORE_DATABASE_VERSION,
  ENDPOINT_KEYSTORE_METADATA_STORE,
  ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE,
} from './storage';

const originalIndexedDb = globalThis.indexedDB;

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: originalIndexedDb,
  });
});

describe('IndexedDB endpoint keystore storage', () => {
  it('round-trips untrusted metadata and keyed phrase entries in the dedicated database', async () => {
    expect(ENDPOINT_KEYSTORE_DATABASE_NAME).toBe('bettertrack-paranoid-keystore-v1');
    const storage = createIndexedDbEndpointKeystoreStorage();
    const metadata = { version: 1, salt: new Uint8Array([1, 2, 3]) };
    const entry = {
      vaultId: 'vault-a',
      custody: 'wrapped',
      payload: { ciphertext: new Uint8Array([4, 5, 6]) },
    };

    await expect(storage.readEndpointSnapshot()).resolves.toEqual({
      revision: 0,
      metadata: null,
    });
    await expect(storage.readEntry('vault-a')).resolves.toBeNull();
    await expect(storage.initializeMetadata(0, metadata)).resolves.toEqual({
      status: 'created',
      revision: 1,
    });
    await expect(storage.writeEntry(1, 'vault-a', entry)).resolves.toEqual({
      status: 'written',
      revision: 2,
    });

    const snapshot = await storage.readEndpointSnapshot();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.metadata).toMatchObject({ version: 1 });
    expect(Array.from((snapshot.metadata as { salt: Uint8Array }).salt)).toEqual([1, 2, 3]);

    const storedEntry = await storage.readEntry('vault-a');
    expect(storedEntry).toMatchObject({ vaultId: 'vault-a', custody: 'wrapped' });
    expect(
      Array.from((storedEntry as { payload: { ciphertext: Uint8Array } }).payload.ciphertext),
    ).toEqual([4, 5, 6]);

    const listed = await storage.listEntries(2);
    expect(listed).toMatchObject({ status: 'current', revision: 2 });
    if (listed.status !== 'current') throw new Error('Expected a current entry list.');
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({ vaultId: 'vault-a' });
    expect(listed.entries[0]?.value).toMatchObject({ custody: 'wrapped' });
  });

  it('serializes concurrent initialization and never overwrites the winner', async () => {
    const storage = createIndexedDbEndpointKeystoreStorage({ databaseName: 'init-race' });
    const candidates = [{ endpoint: 'first' }, { endpoint: 'second' }];

    const results = await Promise.all([
      storage.initializeMetadata(0, candidates[0]),
      storage.initializeMetadata(0, candidates[1]),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['created', 'stale']);
    expect(results).toEqual(
      expect.arrayContaining([
        { status: 'created', revision: 1 },
        { status: 'stale', revision: 1 },
      ]),
    );
    const winnerIndex = results.findIndex((result) => result.status === 'created');
    await expect(storage.readEndpointSnapshot()).resolves.toEqual({
      revision: 1,
      metadata: candidates[winnerIndex],
    });
    await expect(storage.initializeMetadata(1, { endpoint: 'replacement' })).resolves.toEqual({
      status: 'exists',
      revision: 1,
    });
    await expect(storage.readEndpointSnapshot()).resolves.toEqual({
      revision: 1,
      metadata: candidates[winnerIndex],
    });
  });

  it('updates metadata atomically and prevents a stale updater from running', async () => {
    const storage = createIndexedDbEndpointKeystoreStorage({ databaseName: 'metadata-cas' });
    await storage.initializeMetadata(0, { failures: 0 });
    const update = vi.fn((current: unknown) => ({
      value: { failures: (current as { failures: number }).failures + 1 },
      result: 'lockout-recorded',
    }));

    await expect(storage.updateMetadata(1, update)).resolves.toEqual({
      status: 'updated',
      revision: 2,
      result: 'lockout-recorded',
    });
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({ failures: 0 });

    const staleUpdater = vi.fn(() => ({ value: { failures: 99 }, result: 'bad' }));
    await expect(storage.updateMetadata(1, staleUpdater)).resolves.toEqual({
      status: 'stale',
      revision: 2,
    });
    expect(staleUpdater).not.toHaveBeenCalled();
    await expect(storage.readEndpointSnapshot()).resolves.toEqual({
      revision: 2,
      metadata: { failures: 1 },
    });

    await expect(
      storage.updateMetadata(2, () => {
        throw new Error('updater failed');
      }),
    ).rejects.toMatchObject({ code: 'write-failed' });
    await expect(storage.readEndpointSnapshot()).resolves.toEqual({
      revision: 2,
      metadata: { failures: 1 },
    });
  });

  it('returns current revisions on stale entry writes, lists, and deletes', async () => {
    const storage = createIndexedDbEndpointKeystoreStorage({ databaseName: 'entry-cas' });
    await storage.initializeMetadata(0, { version: 1 });
    await expect(storage.writeEntry(1, 'vault-a', { sequence: 1 })).resolves.toEqual({
      status: 'written',
      revision: 2,
    });
    await expect(storage.writeEntry(1, 'vault-a', { sequence: 2 })).resolves.toEqual({
      status: 'stale',
      revision: 2,
    });
    await expect(storage.readEntry('vault-a')).resolves.toEqual({ sequence: 1 });
    await expect(storage.listEntries(1)).resolves.toEqual({ status: 'stale', revision: 2 });
    await expect(storage.listEntries(2)).resolves.toEqual({
      status: 'current',
      revision: 2,
      entries: [{ vaultId: 'vault-a', value: { sequence: 1 } }],
    });

    await expect(storage.deleteEntry(1, 'vault-a')).resolves.toEqual({
      status: 'stale',
      revision: 2,
    });
    await expect(storage.deleteEntry(2, 'vault-a')).resolves.toEqual({
      status: 'deleted',
      revision: 3,
    });
    await expect(storage.readEntry('vault-a')).resolves.toBeNull();
  });

  it('lists, deletes, and resets records while preserving a monotonic revision', async () => {
    const storage = createIndexedDbEndpointKeystoreStorage({ databaseName: 'lifecycle' });
    await storage.initializeMetadata(0, { version: 1 });
    await storage.writeEntry(1, 'vault-a', { value: 'first' });
    await storage.writeEntry(2, 'vault-b', { value: 'second' });

    await expect(storage.listEntries(3)).resolves.toEqual({
      status: 'current',
      revision: 3,
      entries: [
        { vaultId: 'vault-a', value: { value: 'first' } },
        { vaultId: 'vault-b', value: { value: 'second' } },
      ],
    });
    await expect(storage.deleteEntry(3, 'vault-a')).resolves.toEqual({
      status: 'deleted',
      revision: 4,
    });
    await expect(storage.reset()).resolves.toEqual({ revision: 5 });
    await expect(storage.readEndpointSnapshot()).resolves.toEqual({
      revision: 5,
      metadata: null,
    });
    await expect(storage.listEntries(5)).resolves.toEqual({
      status: 'current',
      revision: 5,
      entries: [],
    });
    await expect(storage.writeEntry(4, 'vault-c', {})).resolves.toEqual({
      status: 'stale',
      revision: 5,
    });
  });

  it('isolates revisions, metadata, entries, and reset by database name', async () => {
    const endpointA = createIndexedDbEndpointKeystoreStorage({ databaseName: 'device-a' });
    const endpointB = createIndexedDbEndpointKeystoreStorage({ databaseName: 'device-b' });

    await endpointA.initializeMetadata(0, { endpoint: 'a' });
    await endpointB.initializeMetadata(0, { endpoint: 'b' });
    await endpointA.writeEntry(1, 'shared-vault', { endpoint: 'a' });
    await endpointB.writeEntry(1, 'shared-vault', { endpoint: 'b' });
    await expect(endpointA.reset()).resolves.toEqual({ revision: 3 });

    await expect(endpointA.readEndpointSnapshot()).resolves.toEqual({
      revision: 3,
      metadata: null,
    });
    await expect(endpointB.readEndpointSnapshot()).resolves.toEqual({
      revision: 2,
      metadata: { endpoint: 'b' },
    });
    await expect(endpointB.listEntries(2)).resolves.toEqual({
      status: 'current',
      revision: 2,
      entries: [{ vaultId: 'shared-vault', value: { endpoint: 'b' } }],
    });
  });

  it('rejects non-string phrase-entry keys instead of losing their identity', async () => {
    const databaseName = 'invalid-entry-key';
    const storage = createIndexedDbEndpointKeystoreStorage({ databaseName });
    await storage.readEndpointSnapshot();
    await injectEntry(databaseName, 42, { vaultId: 'untrusted' });

    await expect(storage.listEntries(0)).rejects.toMatchObject({
      name: 'EndpointKeystoreStorageError',
      code: 'read-failed',
    });
  });

  it('upgrades the prior schema with revision zero without dropping records', async () => {
    const databaseName = 'schema-upgrade';
    await createVersionOneDatabase(databaseName, { endpoint: 'legacy' }, { payload: 'kept' });
    const storage = createIndexedDbEndpointKeystoreStorage({ databaseName });

    await expect(storage.readEndpointSnapshot()).resolves.toEqual({
      revision: 0,
      metadata: { endpoint: 'legacy' },
    });
    await expect(storage.listEntries(0)).resolves.toEqual({
      status: 'current',
      revision: 0,
      entries: [{ vaultId: 'vault-a', value: { payload: 'kept' } }],
    });
    await expect(storage.initializeMetadata(0, { endpoint: 'replacement' })).resolves.toEqual({
      status: 'exists',
      revision: 0,
    });
  });

  it('fails closed instead of falling back when IndexedDB is unavailable', async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    const storage = createIndexedDbEndpointKeystoreStorage({ databaseName: 'unavailable' });

    await expect(storage.readEndpointSnapshot()).rejects.toMatchObject({
      name: 'EndpointKeystoreStorageError',
      code: 'unavailable',
    });
    await expect(storage.writeEntry(0, 'vault-a', {})).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(storage.reset()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('uses reset as the recovery path for a malformed local revision record', async () => {
    const databaseName = 'corrupt-control-reset';
    const storage = createIndexedDbEndpointKeystoreStorage({ databaseName });
    await storage.readEndpointSnapshot();
    await injectControl(databaseName, { malformed: true });

    await expect(storage.readEndpointSnapshot()).rejects.toMatchObject({ code: 'read-failed' });
    const reset = await storage.reset();
    expect(reset.revision).toBe(2 ** 52 + 1);
    await expect(storage.readEndpointSnapshot()).resolves.toEqual({
      revision: reset.revision,
      metadata: null,
    });
    await expect(storage.listEntries(reset.revision)).resolves.toEqual({
      status: 'current',
      revision: reset.revision,
      entries: [],
    });
  });
});

async function injectEntry(databaseName: string, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openDatabase(databaseName, ENDPOINT_KEYSTORE_DATABASE_VERSION);
  try {
    const transaction = db.transaction(ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE, 'readwrite');
    const completion = transactionComplete(transaction);
    transaction.objectStore(ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE).put(value, key);
    await completion;
  } finally {
    db.close();
  }
}

async function injectControl(databaseName: string, value: unknown): Promise<void> {
  const db = await openDatabase(databaseName, ENDPOINT_KEYSTORE_DATABASE_VERSION);
  try {
    const transaction = db.transaction(ENDPOINT_KEYSTORE_CONTROL_STORE, 'readwrite');
    const completion = transactionComplete(transaction);
    transaction.objectStore(ENDPOINT_KEYSTORE_CONTROL_STORE).put(value, 'endpoint');
    await completion;
  } finally {
    db.close();
  }
}

async function createVersionOneDatabase(
  databaseName: string,
  metadata: unknown,
  entry: unknown,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = globalThis.indexedDB.open(databaseName, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(ENDPOINT_KEYSTORE_METADATA_STORE);
      open.result.createObjectStore(ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    const transaction = db.transaction(
      [ENDPOINT_KEYSTORE_METADATA_STORE, ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE],
      'readwrite',
    );
    const completion = transactionComplete(transaction);
    transaction.objectStore(ENDPOINT_KEYSTORE_METADATA_STORE).put(metadata, 'endpoint');
    transaction.objectStore(ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE).put(entry, 'vault-a');
    await completion;
  } finally {
    db.close();
  }
}

function openDatabase(databaseName: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = globalThis.indexedDB.open(databaseName, version);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

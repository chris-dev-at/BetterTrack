import { inspectVaultEnvelope } from './envelope';
import type {
  DataHome,
  DataHomeCorruptCandidate,
  DataHomeInfo,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from './dataHome';

export const VAULT_CACHE_DATABASE_NAME = 'bettertrack-vault-cache';
export const VAULT_CACHE_DATABASE_VERSION = 2;
export const VAULT_CACHE_VAULTS_STORE = 'vaults';
export const VAULT_CACHE_QUARANTINE_STORE = 'quarantine';

const STORE_NAME = VAULT_CACHE_VAULTS_STORE;
const RECORD_VERSION = 1;

export interface LocalVaultRecord {
  recordVersion: number;
  envelope: ArrayBuffer;
  /** Non-sensitive metadata derived from the authenticated envelope header. */
  version: number;
  updatedAt: string;
  /** Last envelope that the sync coordinator successfully decrypted. */
  lastKnownGood: ArrayBuffer;
  lastKnownGoodVersion: number;
  lastKnownGoodUpdatedAt: string;
  /** Survives restart so a local optimistic write is never mistaken for a stale cache. */
  pendingRemote?: boolean;
}

export interface LocalDataHomeOptions {
  /** A stable per-account/device scope; it prevents one account reading another account's cache. */
  scope: string;
  /** Test seam and a future OPFS-backed implementation seam. */
  storage?: LocalDataHomeStorage;
}

export type LocalDataHomeCompareAndSwapResult =
  | { status: 'ok' }
  | { status: 'conflict'; currentVersion: number | null };

export interface LocalDataHomeStorage {
  read(scope: string): Promise<LocalVaultRecord | null>;
  compareAndSwap(
    scope: string,
    ifVersion: number | null,
    build: (current: LocalVaultRecord | null) => LocalVaultRecord,
  ): Promise<LocalDataHomeCompareAndSwapResult>;
  update(scope: string, update: (current: LocalVaultRecord) => LocalVaultRecord): Promise<boolean>;
}

export interface LocalDataHome extends DataHome {
  /** Promotes an already-decrypted envelope to the rollback-safe local snapshot. */
  markLastKnownGood(envelope: Uint8Array): Promise<void>;
  /** Returns the rollback-safe encrypted bytes without exposing decrypted data. */
  readLastKnownGood(): Promise<DataHomeReadResult>;
  /** Whether the current local envelope still needs primary-medium acknowledgement. */
  isPendingRemote(): Promise<boolean>;
  /** Persists the acknowledgement state without ever storing plaintext. */
  setPendingRemote(pending: boolean): Promise<void>;
}

/**
 * Offline encrypted cache. It persists only envelope bytes and authenticated,
 * non-sensitive sync metadata. It deliberately has no decrypt/key API.
 */
export function createLocalDataHome(options: LocalDataHomeOptions): LocalDataHome {
  const storage = options.storage ?? createIndexedDbLocalDataHomeStorage();

  return {
    medium: 'local',

    async read(): Promise<DataHomeReadResult> {
      let record: LocalVaultRecord | null;
      try {
        record = await storage.read(options.scope);
      } catch (cause) {
        return transportFailure('Could not read the encrypted local vault cache.', cause);
      }
      if (record == null) return { status: 'absent', medium: 'local' };
      const envelope = new Uint8Array(record.envelope.slice(0));
      const parsed = inspect(envelope, record.version, record.updatedAt);
      if ('status' in parsed) {
        return { ...parsed, updatedAt: record.updatedAt };
      }
      if (parsed.version !== record.version) {
        return corrupt(
          envelope,
          record.version,
          'version-mismatch',
          'Local sync metadata does not match the authenticated envelope version.',
        );
      }
      return { status: 'ok', medium: 'local', envelope, info: parsed };
    },

    async write(
      envelope: Uint8Array,
      { ifVersion }: DataHomeWriteOptions,
    ): Promise<DataHomeWriteResult> {
      const parsed = inspect(envelope, null, null);
      if ('status' in parsed) return parsed;

      const bytes = envelope.slice();
      let outcome: Awaited<ReturnType<LocalDataHomeStorage['compareAndSwap']>>;
      try {
        outcome = await storage.compareAndSwap(options.scope, ifVersion, (current) => ({
          recordVersion: RECORD_VERSION,
          envelope: toArrayBuffer(bytes),
          version: parsed.version,
          updatedAt: parsed.updatedAt ?? new Date().toISOString(),
          // The incoming blob is authenticated structurally; the sync coordinator
          // promotes it to active only after decryption. Preserve a separate last
          // known good record across a failed future activation.
          lastKnownGood: current?.lastKnownGood.slice(0) ?? toArrayBuffer(bytes),
          lastKnownGoodVersion: current?.lastKnownGoodVersion ?? parsed.version,
          lastKnownGoodUpdatedAt:
            current?.lastKnownGoodUpdatedAt ?? parsed.updatedAt ?? new Date().toISOString(),
          pendingRemote: current?.pendingRemote ?? false,
        }));
      } catch (cause) {
        return transportFailure('Could not write the encrypted local vault cache.', cause);
      }
      if (outcome.status === 'conflict') {
        return {
          status: 'conflict',
          medium: 'local',
          currentVersion: outcome.currentVersion,
        };
      }

      return { status: 'ok', medium: 'local', info: parsed };
    },

    async info(): Promise<DataHomeInfoResult> {
      const result = await this.read();
      switch (result.status) {
        case 'ok':
          return { status: 'ok', medium: 'local', info: result.info };
        case 'absent':
          return result;
        case 'corrupt':
          return result;
        case 'transport-failure':
          return result;
      }
    },

    async markLastKnownGood(envelope): Promise<void> {
      const parsed = inspect(envelope, null, null);
      if ('status' in parsed) throw new Error(parsed.message);
      const bytes = toArrayBuffer(envelope);
      const updated = await storage.update(options.scope, (current) => ({
        ...current,
        lastKnownGood: bytes,
        lastKnownGoodVersion: parsed.version,
        lastKnownGoodUpdatedAt: parsed.updatedAt ?? new Date().toISOString(),
      }));
      if (!updated) throw new Error('No encrypted local cache exists.');
    },

    async isPendingRemote(): Promise<boolean> {
      const current = await storage.read(options.scope);
      return current?.pendingRemote ?? false;
    },

    async setPendingRemote(pending): Promise<void> {
      const updated = await storage.update(options.scope, (current) => ({
        ...current,
        pendingRemote: pending,
      }));
      if (!updated) throw new Error('No encrypted local cache exists.');
    },

    async readLastKnownGood(): Promise<DataHomeReadResult> {
      let record: LocalVaultRecord | null;
      try {
        record = await storage.read(options.scope);
      } catch (cause) {
        return transportFailure('Could not read the encrypted local vault cache.', cause);
      }
      if (record == null) return { status: 'absent', medium: 'local' };
      const envelope = new Uint8Array(record.lastKnownGood.slice(0));
      const parsed = inspect(envelope, record.lastKnownGoodVersion, record.lastKnownGoodUpdatedAt);
      if ('status' in parsed) {
        return { ...parsed, updatedAt: record.lastKnownGoodUpdatedAt };
      }
      if (parsed.version !== record.lastKnownGoodVersion) {
        return corrupt(
          envelope,
          record.lastKnownGoodVersion,
          'version-mismatch',
          'Last known-good local metadata does not match the authenticated envelope version.',
        );
      }
      return { status: 'ok', medium: 'local', envelope, info: parsed };
    },
  };
}

/** Public named adapter matching the architecture note nomenclature. */
export const localDataHome = createLocalDataHome;

export function createIndexedDbLocalDataHomeStorage(): LocalDataHomeStorage {
  return {
    async read(scope) {
      const db = await openDb();
      try {
        const record = await request<LocalVaultRecord | undefined>(
          db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(scope),
        );
        if (record == null || record.recordVersion !== RECORD_VERSION) return null;
        return record;
      } finally {
        db.close();
      }
    },
    async compareAndSwap(scope, ifVersion, build) {
      return mutateIndexedDbRecord<LocalDataHomeCompareAndSwapResult>(scope, (current) => {
        const currentVersion = current?.version ?? null;
        if (currentVersion !== ifVersion) {
          return {
            write: null,
            result: { status: 'conflict' as const, currentVersion },
          };
        }
        return { write: build(current), result: { status: 'ok' as const } };
      });
    },
    async update(scope, update) {
      return mutateIndexedDbRecord(scope, (current) =>
        current == null ? { write: null, result: false } : { write: update(current), result: true },
      );
    },
  };
}

async function mutateIndexedDbRecord<T>(
  scope: string,
  mutate: (current: LocalVaultRecord | null) => {
    write: LocalVaultRecord | null;
    result: T;
  },
): Promise<T> {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const completion = transactionCompletion(transaction);
  try {
    const store = transaction.objectStore(STORE_NAME);
    const current = await request<LocalVaultRecord | undefined>(store.get(scope));
    const mutation = mutate(
      current == null || current.recordVersion !== RECORD_VERSION ? null : current,
    );
    if (mutation.write != null) store.put(mutation.write, scope);
    await completion;
    return mutation.result;
  } catch (cause) {
    try {
      transaction.abort();
    } catch {
      // The transaction already failed or committed; preserve the original error.
    }
    await completion.catch(() => undefined);
    throw cause;
  } finally {
    db.close();
  }
}

function toArrayBuffer(envelope: Uint8Array): ArrayBuffer {
  return envelope.buffer.slice(
    envelope.byteOffset,
    envelope.byteOffset + envelope.byteLength,
  ) as ArrayBuffer;
}

function inspect(
  envelope: Uint8Array,
  metadataVersion: number | null,
  metadataUpdatedAt: string | null,
): DataHomeInfo | DataHomeCorruptCandidate {
  try {
    const result = inspectVaultEnvelope(envelope);
    if (result.status === 'update-required') {
      return corrupt(
        envelope,
        metadataVersion,
        'unsupported-version',
        'The local vault was written by a newer app version.',
      );
    }
    return {
      medium: 'local',
      version: result.envelope.header.vaultVersion,
      sizeBytes: envelope.byteLength,
      updatedAt: metadataUpdatedAt ?? result.envelope.header.writtenAt,
    };
  } catch (cause) {
    return corrupt(
      envelope,
      metadataVersion,
      'malformed-envelope',
      cause instanceof Error ? cause.message : 'The local vault envelope is malformed.',
    );
  }
}

function corrupt(
  envelope: Uint8Array | undefined,
  version: number | null,
  reason: DataHomeCorruptCandidate['reason'],
  message: string,
): DataHomeCorruptCandidate {
  return {
    status: 'corrupt',
    medium: 'local',
    envelope,
    version,
    updatedAt: null,
    reason,
    message,
  };
}

function transportFailure(
  message: string,
  cause: unknown,
): Extract<DataHomeWriteResult, { status: 'transport-failure' }> {
  return { status: 'transport-failure', medium: 'local', failure: { message, cause } };
}

function openDb(): Promise<IDBDatabase> {
  if (globalThis.indexedDB == null) return Promise.reject(new Error('IndexedDB is unavailable.'));
  return new Promise((resolve, reject) => {
    const open = globalThis.indexedDB.open(VAULT_CACHE_DATABASE_NAME, VAULT_CACHE_DATABASE_VERSION);
    open.onupgradeneeded = () => {
      ensureVaultCacheStores(open.result);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB could not open.'));
  });
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

/**
 * The local cache and quarantine share one coordinated schema upgrade so either
 * adapter can initialize first without making the other adapter's open fail.
 */
export function ensureVaultCacheStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(VAULT_CACHE_VAULTS_STORE)) {
    db.createObjectStore(VAULT_CACHE_VAULTS_STORE);
  }
  if (!db.objectStoreNames.contains(VAULT_CACHE_QUARANTINE_STORE)) {
    db.createObjectStore(VAULT_CACHE_QUARANTINE_STORE, { keyPath: 'id' });
  }
}

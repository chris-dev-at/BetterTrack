import { equalBytes } from './bytes';
import type {
  DataHome,
  DataHomeCorruptCandidate,
  DataHomeInfo,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from './dataHome';
import { inspectVaultEnvelope } from './envelope';

export const VAULT_CACHE_DATABASE_NAME = 'bettertrack-vault-cache';
export const VAULT_CACHE_DATABASE_VERSION = 2;
export const VAULT_CACHE_VAULTS_STORE = 'vaults';
export const VAULT_CACHE_QUARANTINE_STORE = 'quarantine';

const STORE_NAME = VAULT_CACHE_VAULTS_STORE;
const RECORD_VERSION = 1;

/**
 * The complete persisted local shape. Every byte field is an encrypted envelope;
 * the remaining fields are non-sensitive synchronization metadata.
 */
export interface LocalVaultRecord {
  recordVersion: number;
  envelope: ArrayBuffer;
  version: number;
  updatedAt: string;
  lastKnownGood?: ArrayBuffer;
  lastKnownGoodVersion?: number;
  lastKnownGoodUpdatedAt?: string;
  pendingRemote: boolean;
}

export interface LocalDataHomeOptions {
  scope: string;
  /** IndexedDB today; OPFS-compatible implementations can provide this seam. */
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
}

export interface LocalDataHome extends DataHome {
  /**
   * Promote bytes already decrypted and validated by the caller. The candidate
   * must still be the exact current local version.
   */
  markLastKnownGood(
    envelope: Uint8Array,
    options: DataHomeWriteOptions,
  ): Promise<DataHomeWriteResult>;
  readLastKnownGood(): Promise<DataHomeReadResult>;
  /**
   * Versioned pending/acknowledgement update. A stale tab cannot clear a newer
   * local candidate's pending bit.
   */
  setPendingRemote(pending: boolean, options: DataHomeWriteOptions): Promise<DataHomeWriteResult>;
}

/** Offline encrypted cache with no plaintext or vault-key API. */
export function createLocalDataHome(options: LocalDataHomeOptions): LocalDataHome {
  const storage = options.storage ?? createIndexedDbLocalDataHomeStorage();

  return {
    medium: 'local',

    async read(): Promise<DataHomeReadResult> {
      const result = await readRecord(storage, options.scope);
      if (result === null) return { status: 'absent', medium: 'local' };
      if ('status' in result) return result;
      return readCurrent(result);
    },

    async write(
      envelope: Uint8Array,
      { ifVersion }: DataHomeWriteOptions,
    ): Promise<DataHomeWriteResult> {
      const parsed = inspect(envelope, null, null);
      if ('status' in parsed) return parsed;
      if (ifVersion !== null && parsed.version <= ifVersion) {
        return corrupt(
          envelope,
          parsed.version,
          'version-mismatch',
          'A local vault write must advance the expected version.',
        );
      }

      const bytes = envelope.slice();
      const outcome = await compareAndSwap(
        storage,
        options.scope,
        ifVersion,
        'Could not write the encrypted local vault cache.',
        (current) => ({
          recordVersion: RECORD_VERSION,
          envelope: toArrayBuffer(bytes),
          version: parsed.version,
          updatedAt: parsed.updatedAt ?? new Date().toISOString(),
          lastKnownGood: cloneBuffer(current?.lastKnownGood),
          lastKnownGoodVersion: current?.lastKnownGoodVersion,
          lastKnownGoodUpdatedAt: current?.lastKnownGoodUpdatedAt,
          pendingRemote: true,
        }),
      );
      if (outcome.status !== 'ok') return outcome;
      return { status: 'ok', medium: 'local', info: { ...parsed, pendingRemote: true } };
    },

    async info(): Promise<DataHomeInfoResult> {
      const result = await this.read();
      return result.status === 'ok' ? { status: 'ok', medium: 'local', info: result.info } : result;
    },

    async markLastKnownGood(envelope, { ifVersion }) {
      if (ifVersion === null) {
        return {
          status: 'conflict',
          medium: 'local',
          currentVersion: (await currentVersion(storage, options.scope)) ?? null,
        };
      }
      const parsed = inspect(envelope, ifVersion, null);
      if ('status' in parsed) return parsed;
      if (parsed.version !== ifVersion) {
        return corrupt(
          envelope,
          parsed.version,
          'version-mismatch',
          'Last-known-good bytes do not match the expected local version.',
        );
      }
      const bytes = envelope.slice();
      let pendingRemote = false;
      const outcome = await compareAndSwap(
        storage,
        options.scope,
        ifVersion,
        'Could not preserve the encrypted rollback snapshot.',
        (current) => {
          if (current == null || !equalBytes(new Uint8Array(current.envelope), bytes)) {
            throw new Error('Last-known-good bytes are not the current local candidate.');
          }
          pendingRemote = current.pendingRemote;
          return {
            ...current,
            lastKnownGood: toArrayBuffer(bytes),
            lastKnownGoodVersion: parsed.version,
            lastKnownGoodUpdatedAt: parsed.updatedAt ?? current.updatedAt,
          };
        },
      );
      if (outcome.status !== 'ok') return outcome;
      return {
        status: 'ok',
        medium: 'local',
        info: { ...parsed, pendingRemote },
      };
    },

    async setPendingRemote(pending, { ifVersion }) {
      if (ifVersion === null) {
        return {
          status: 'conflict',
          medium: 'local',
          currentVersion: (await currentVersion(storage, options.scope)) ?? null,
        };
      }
      let info: DataHomeInfo | null = null;
      const outcome = await compareAndSwap(
        storage,
        options.scope,
        ifVersion,
        'Could not update local vault acknowledgement state.',
        (current) => {
          if (current == null) throw new Error('No encrypted local cache exists.');
          info = infoForRecord(current);
          return { ...current, pendingRemote: pending };
        },
      );
      if (outcome.status !== 'ok') return outcome;
      return {
        status: 'ok',
        medium: 'local',
        info: { ...info!, pendingRemote: pending },
      };
    },

    async readLastKnownGood(): Promise<DataHomeReadResult> {
      const result = await readRecord(storage, options.scope);
      if (result === null) return { status: 'absent', medium: 'local' };
      if ('status' in result) return result;
      if (result.lastKnownGood == null || result.lastKnownGoodVersion == null) {
        return { status: 'absent', medium: 'local' };
      }
      const envelope = new Uint8Array(result.lastKnownGood.slice(0));
      const parsed = inspect(
        envelope,
        result.lastKnownGoodVersion,
        result.lastKnownGoodUpdatedAt ?? null,
      );
      if ('status' in parsed) {
        return { ...parsed, updatedAt: result.lastKnownGoodUpdatedAt ?? null };
      }
      if (parsed.version !== result.lastKnownGoodVersion) {
        return corrupt(
          envelope,
          result.lastKnownGoodVersion,
          'version-mismatch',
          'Last-known-good metadata does not match its encrypted envelope.',
        );
      }
      return {
        status: 'ok',
        medium: 'local',
        envelope,
        info: { ...parsed, pendingRemote: false },
      };
    },
  };
}

export const localDataHome = createLocalDataHome;

export function createIndexedDbLocalDataHomeStorage(): LocalDataHomeStorage {
  return {
    async read(scope) {
      const db = await openDb();
      try {
        return (
          (await request<LocalVaultRecord | undefined>(
            db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(scope),
          )) ?? null
        );
      } finally {
        db.close();
      }
    },

    async compareAndSwap(scope, ifVersion, build) {
      return mutateIndexedDbRecord<LocalDataHomeCompareAndSwapResult>(scope, (current) => {
        if (current != null && !isRecord(current)) {
          return {
            write: null,
            result: { status: 'conflict' as const, currentVersion: safeVersion(current) },
          };
        }
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
  };
}

async function readRecord(
  storage: LocalDataHomeStorage,
  scope: string,
): Promise<
  LocalVaultRecord | null | Extract<DataHomeReadResult, { status: 'corrupt' | 'transport-failure' }>
> {
  let record: LocalVaultRecord | null;
  try {
    record = await storage.read(scope);
  } catch (cause) {
    return transportFailure('Could not read the encrypted local vault cache.', cause);
  }
  if (record == null) return null;
  const untrusted: unknown = record;
  if (!isRecord(untrusted)) {
    const value =
      typeof untrusted === 'object' && untrusted !== null
        ? (untrusted as { envelope?: unknown })
        : {};
    const envelope = isArrayBuffer(value.envelope)
      ? new Uint8Array(value.envelope.slice(0))
      : undefined;
    return corrupt(
      envelope,
      safeVersion(untrusted),
      'invalid-response',
      'The local vault cache record is malformed.',
    );
  }
  return untrusted;
}

function readCurrent(record: LocalVaultRecord): DataHomeReadResult {
  const envelope = new Uint8Array(record.envelope.slice(0));
  const parsed = inspect(envelope, record.version, record.updatedAt);
  if ('status' in parsed) return { ...parsed, updatedAt: record.updatedAt };
  if (parsed.version !== record.version) {
    return corrupt(
      envelope,
      record.version,
      'version-mismatch',
      'Local sync metadata does not match the encrypted envelope version.',
    );
  }
  return {
    status: 'ok',
    medium: 'local',
    envelope,
    info: { ...parsed, pendingRemote: record.pendingRemote },
  };
}

async function compareAndSwap(
  storage: LocalDataHomeStorage,
  scope: string,
  ifVersion: number | null,
  message: string,
  build: (current: LocalVaultRecord | null) => LocalVaultRecord,
): Promise<DataHomeWriteResult> {
  try {
    const outcome = await storage.compareAndSwap(scope, ifVersion, build);
    return outcome.status === 'ok'
      ? {
          status: 'ok',
          medium: 'local',
          info: {
            medium: 'local',
            version: ifVersion ?? 1,
            sizeBytes: 0,
            updatedAt: null,
          },
        }
      : { status: 'conflict', medium: 'local', currentVersion: outcome.currentVersion };
  } catch (cause) {
    return transportFailure(message, cause);
  }
}

async function currentVersion(
  storage: LocalDataHomeStorage,
  scope: string,
): Promise<number | null> {
  try {
    return safeVersion(await storage.read(scope));
  } catch {
    return null;
  }
}

function infoForRecord(record: LocalVaultRecord): DataHomeInfo {
  return {
    medium: 'local',
    version: record.version,
    sizeBytes: record.envelope.byteLength,
    updatedAt: record.updatedAt,
    pendingRemote: record.pendingRemote,
  };
}

function inspect(
  envelope: Uint8Array,
  metadataVersion: number | null,
  metadataUpdatedAt: string | null,
): DataHomeInfo | DataHomeCorruptCandidate {
  try {
    const inspected = inspectVaultEnvelope(envelope);
    if (inspected.status === 'update-required') {
      return corrupt(
        envelope,
        metadataVersion,
        'unsupported-version',
        'The local vault was written by a newer app version.',
      );
    }
    return {
      medium: 'local',
      version: inspected.envelope.header.vaultVersion,
      sizeBytes: envelope.byteLength,
      updatedAt: metadataUpdatedAt ?? inspected.envelope.header.writtenAt,
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

function isRecord(value: unknown): value is LocalVaultRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<LocalVaultRecord>;
  return (
    record.recordVersion === RECORD_VERSION &&
    isArrayBuffer(record.envelope) &&
    Number.isSafeInteger(record.version) &&
    Number(record.version) >= 1 &&
    typeof record.updatedAt === 'string' &&
    typeof record.pendingRemote === 'boolean' &&
    (record.lastKnownGood === undefined || isArrayBuffer(record.lastKnownGood)) &&
    (record.lastKnownGoodVersion === undefined ||
      (Number.isSafeInteger(record.lastKnownGoodVersion) &&
        Number(record.lastKnownGoodVersion) >= 1)) &&
    (record.lastKnownGoodUpdatedAt === undefined ||
      typeof record.lastKnownGoodUpdatedAt === 'string')
  );
}

function safeVersion(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const version = (value as { version?: unknown }).version;
  return Number.isSafeInteger(version) && Number(version) >= 1 ? Number(version) : null;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  );
}

function cloneBuffer(value: ArrayBuffer | undefined): ArrayBuffer | undefined {
  return value?.slice(0);
}

function toArrayBuffer(envelope: Uint8Array): ArrayBuffer {
  return envelope.buffer.slice(
    envelope.byteOffset,
    envelope.byteOffset + envelope.byteLength,
  ) as ArrayBuffer;
}

async function mutateIndexedDbRecord<T>(
  scope: string,
  mutate: (current: LocalVaultRecord | null) => { write: LocalVaultRecord | null; result: T },
): Promise<T> {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const completion = transactionCompletion(transaction);
  try {
    const store = transaction.objectStore(STORE_NAME);
    const current = (await request<LocalVaultRecord | undefined>(store.get(scope))) ?? null;
    const mutation = mutate(current);
    if (mutation.write != null) store.put(mutation.write, scope);
    await completion;
    return mutation.result;
  } catch (cause) {
    try {
      transaction.abort();
    } catch {
      // Preserve the original failure when the transaction already completed.
    }
    await completion.catch(() => undefined);
    throw cause;
  } finally {
    db.close();
  }
}

function openDb(): Promise<IDBDatabase> {
  if (globalThis.indexedDB == null) return Promise.reject(new Error('IndexedDB is unavailable.'));
  return new Promise((resolve, reject) => {
    const open = globalThis.indexedDB.open(VAULT_CACHE_DATABASE_NAME, VAULT_CACHE_DATABASE_VERSION);
    open.onupgradeneeded = () => ensureVaultCacheStores(open.result);
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

export function ensureVaultCacheStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(VAULT_CACHE_VAULTS_STORE)) {
    db.createObjectStore(VAULT_CACHE_VAULTS_STORE);
  }
  if (!db.objectStoreNames.contains(VAULT_CACHE_QUARANTINE_STORE)) {
    db.createObjectStore(VAULT_CACHE_QUARANTINE_STORE, { keyPath: 'id' });
  }
}

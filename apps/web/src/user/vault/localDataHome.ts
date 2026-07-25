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

const DATABASE_NAME = 'bettertrack-vault-cache';
const STORE_NAME = 'vaults';
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
}

export interface LocalDataHomeOptions {
  /** A stable per-account/device scope; it prevents one account reading another account's cache. */
  scope: string;
  /** Test seam and a future OPFS-backed implementation seam. */
  storage?: LocalDataHomeStorage;
}

export interface LocalDataHomeStorage {
  read(scope: string): Promise<LocalVaultRecord | null>;
  write(scope: string, record: LocalVaultRecord): Promise<void>;
}

export interface LocalDataHome extends DataHome {
  /** Promotes an already-decrypted envelope to the rollback-safe local snapshot. */
  markLastKnownGood(envelope: Uint8Array): Promise<void>;
  /** Returns the rollback-safe encrypted bytes without exposing decrypted data. */
  readLastKnownGood(): Promise<DataHomeReadResult>;
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

      let current: LocalVaultRecord | null;
      try {
        current = await storage.read(options.scope);
      } catch (cause) {
        return transportFailure('Could not read the encrypted local vault cache.', cause);
      }
      const currentVersion = current?.version ?? null;
      if (currentVersion !== ifVersion) {
        return { status: 'conflict', medium: 'local', currentVersion };
      }

      const bytes = envelope.slice();
      const next: LocalVaultRecord = {
        recordVersion: RECORD_VERSION,
        envelope: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        version: parsed.version,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        // The incoming blob is authenticated structurally; the sync coordinator
        // promotes it to active only after decryption. Preserve a separate last
        // known good record across a failed future activation.
        lastKnownGood:
          current?.lastKnownGood.slice(0) ??
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        lastKnownGoodVersion: current?.lastKnownGoodVersion ?? parsed.version,
        lastKnownGoodUpdatedAt:
          current?.lastKnownGoodUpdatedAt ?? parsed.updatedAt ?? new Date().toISOString(),
      };
      try {
        await storage.write(options.scope, next);
      } catch (cause) {
        return transportFailure('Could not write the encrypted local vault cache.', cause);
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
      const current = await storage.read(options.scope);
      if (current == null) throw new Error('No encrypted local cache exists.');
      const bytes = toArrayBuffer(envelope);
      await storage.write(options.scope, {
        ...current,
        lastKnownGood: bytes,
        lastKnownGoodVersion: parsed.version,
        lastKnownGoodUpdatedAt: parsed.updatedAt ?? new Date().toISOString(),
      });
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
    async write(scope, record) {
      const db = await openDb();
      try {
        await complete(
          db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record, scope),
        );
      } finally {
        db.close();
      }
    },
  };
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
    const open = globalThis.indexedDB.open(DATABASE_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE_NAME))
        open.result.createObjectStore(STORE_NAME);
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

function complete<T>(value: IDBRequest<T>): Promise<void> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve();
    value.onerror = () => reject(value.error ?? new Error('IndexedDB write failed.'));
  });
}

import type { DataHomeMedium } from './dataHome';
import {
  ensureVaultCacheStores,
  VAULT_CACHE_DATABASE_NAME,
  VAULT_CACHE_DATABASE_VERSION,
  VAULT_CACHE_QUARANTINE_STORE,
} from './localDataHome';

const STORE_NAME = VAULT_CACHE_QUARANTINE_STORE;
const MAX_QUARANTINED_CANDIDATES = 50;

/** Opaque candidate retained after structural, authentication, schema, or version failure. */
export interface QuarantinedVaultCandidate {
  id: string;
  medium: DataHomeMedium;
  envelope: Uint8Array;
  version: number | null;
  updatedAt: string | null;
  capturedAt: string;
  /** Diagnostic only; never contains decrypted portfolio data. */
  status: 'corrupt' | 'unreadable' | 'unsupported';
  reason: string;
}

export interface VaultQuarantineStore {
  put(candidate: Omit<QuarantinedVaultCandidate, 'id'>): Promise<QuarantinedVaultCandidate>;
  list(): Promise<QuarantinedVaultCandidate[]>;
}

export interface IndexedDbVaultQuarantineStoreOptions {
  scope: string;
  now?: () => string;
  id?: () => string;
}

interface StoredQuarantineCandidate extends Omit<QuarantinedVaultCandidate, 'envelope'> {
  scope: string;
  envelope: ArrayBuffer;
}

/**
 * Quarantine is an encrypted-byte-only local diagnostic/history store. Failure
 * to decode a candidate never deletes it or replaces a previously good vault.
 */
export function createIndexedDbVaultQuarantineStore(
  options: IndexedDbVaultQuarantineStoreOptions,
): VaultQuarantineStore {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? createId;
  return {
    async put(candidate) {
      const stored: StoredQuarantineCandidate = {
        ...candidate,
        id: id(),
        scope: options.scope,
        capturedAt: candidate.capturedAt || now(),
        envelope: toArrayBuffer(candidate.envelope),
      };
      const db = await openDb();
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        await request(store.put(stored));
        const all = await request<StoredQuarantineCandidate[]>(store.getAll());
        const excess = all
          .filter((entry) => entry.scope === options.scope)
          .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
          .slice(0, -MAX_QUARANTINED_CANDIDATES);
        await Promise.all(excess.map((entry) => request(store.delete(entry.id))));
        await transactionComplete(transaction);
      } finally {
        db.close();
      }
      return {
        ...candidate,
        id: stored.id,
        capturedAt: stored.capturedAt,
        envelope: candidate.envelope.slice(),
      };
    },

    async list() {
      const db = await openDb();
      try {
        const all = await request<StoredQuarantineCandidate[]>(
          db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll(),
        );
        return all
          .filter((entry) => entry.scope === options.scope)
          .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
          .map(({ scope: _scope, envelope, ...entry }) => ({
            ...entry,
            envelope: new Uint8Array(envelope.slice(0)),
          }));
      } finally {
        db.close();
      }
    },
  };
}

/** Small deterministic test double; production code uses the IndexedDB store above. */
export function createMemoryVaultQuarantineStore(
  now: () => string = () => new Date().toISOString(),
): VaultQuarantineStore {
  const candidates: QuarantinedVaultCandidate[] = [];
  let next = 0;
  return {
    async put(candidate) {
      const stored: QuarantinedVaultCandidate = {
        ...candidate,
        id: `quarantine-${next++}`,
        capturedAt: candidate.capturedAt || now(),
        envelope: candidate.envelope.slice(),
      };
      candidates.unshift(stored);
      candidates.splice(MAX_QUARANTINED_CANDIDATES);
      return { ...stored, envelope: stored.envelope.slice() };
    },
    async list() {
      return candidates.map((candidate) => ({
        ...candidate,
        envelope: candidate.envelope.slice(),
      }));
    },
  };
}

function createId(): string {
  if (globalThis.crypto?.randomUUID == null) throw new Error('crypto.randomUUID is unavailable.');
  return globalThis.crypto.randomUUID();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

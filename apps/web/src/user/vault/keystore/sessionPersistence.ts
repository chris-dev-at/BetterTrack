import { isShareableDeviceKey } from './sessionChannel';

/**
 * Endpoint-session persistence — the owner's 2026-09-03 amendment to §12.
 *
 * ── WHAT CHANGED AND WHY ──────────────────────────────────────────────────
 *
 * §12 originally scoped a wrapped-custody session to process memory: a full
 * page load ended it, so every reload, every OAuth round-trip (Drive consent)
 * and every mobile-browser tab eviction asked for the device password again.
 * The owner ruled that out on 2026-09-03 ("central unlock that stays for the
 * rest of the session … no need to lock the vault after every time a subsite
 * has been opened"). A session now belongs to the DEVICE for a bounded time:
 * it survives reloads and tab closes and ends at an explicit lock, sign-out,
 * the PIN idle lock, an account switch, or the absolute TTL below.
 *
 * ── WHAT IS STORED ────────────────────────────────────────────────────────
 *
 * K_dev only, as a NON-EXTRACTABLE AES-256-GCM `CryptoKey` — the same shape the
 * cross-tab channel already carries (`sessionChannel.ts`). IndexedDB stores a
 * CryptoKey by structured clone and hands back a handle that can decrypt but
 * whose bytes no script on this origin can read out. No password, no mnemonic,
 * no entropy, no content key and no derived plaintext is ever written here.
 *
 * ── HOW IT STAYS SAFE ─────────────────────────────────────────────────────
 *
 *   • The resume path treats a persisted key exactly like a sibling tab's
 *     grant: it is refused while the §12 device-locked marker is set, and it
 *     opens nothing until the wrap-check (`verifyEndpointPassword`) proves it
 *     was derived from THIS endpoint's password.
 *   • Every user-intended lock writes the marker synchronously BEFORE anything
 *     else and then deletes the record. Even if the delete is slow or fails, the
 *     marker alone keeps the persisted key inert until the next password entry.
 *   • Records expire: `readPersistedSession` deletes an expired record and
 *     reports nothing.
 *   • Persistence is an optimization, never a dependency: every failure here
 *     resolves to "nothing persisted" and the password still works.
 */

const SESSION_DATABASE_NAME = 'bettertrack-paranoid-session-v1';
const SESSION_DATABASE_VERSION = 1;
const SESSION_STORE = 'sessions';
const SESSION_RECORD_VERSION = 1;

/**
 * Absolute lifetime of a persisted session, measured from the unlock that
 * created it. The owner asked for "the rest of the session"; seven days is the
 * "remember this device" window the rest of the product already uses, and a
 * shorter value is a one-line change here plus a §12 note.
 */
export const ENDPOINT_SESSION_PERSISTENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PersistedSessionRecord {
  version: typeof SESSION_RECORD_VERSION;
  accountId: string;
  deviceKey: CryptoKey;
  createdAt: number;
  expiresAt: number;
}

export interface EndpointSessionPersistence {
  /** Store K_dev for the account; replaces any earlier record. */
  persist(accountId: string, deviceKey: CryptoKey, expiresAt: number): Promise<void>;
  /** The persisted K_dev, or null when absent, expired, malformed or unreadable. */
  read(accountId: string, now: number): Promise<CryptoKey | null>;
  /** Forget the account's persisted session. Idempotent. */
  clear(accountId: string): Promise<void>;
}

/**
 * In-memory implementation for tests and for platforms without IndexedDB. It
 * models exactly the contract above, expiry included.
 */
export function createMemoryEndpointSessionPersistence(): EndpointSessionPersistence & {
  size(): number;
} {
  const records = new Map<string, PersistedSessionRecord>();
  return {
    async persist(accountId, deviceKey, expiresAt) {
      records.set(accountId, {
        version: SESSION_RECORD_VERSION,
        accountId,
        deviceKey,
        createdAt: expiresAt - ENDPOINT_SESSION_PERSISTENCE_TTL_MS,
        expiresAt,
      });
    },
    async read(accountId, now) {
      const record = records.get(accountId);
      if (record == null) return null;
      if (record.expiresAt <= now) {
        records.delete(accountId);
        return null;
      }
      return record.deviceKey;
    },
    async clear(accountId) {
      records.delete(accountId);
    },
    size() {
      return records.size;
    },
  };
}

/** No persistence at all — the pre-amendment §12 behaviour, for callers that opt out. */
export const NO_ENDPOINT_SESSION_PERSISTENCE: EndpointSessionPersistence = {
  persist: async () => undefined,
  read: async () => null,
  clear: async () => undefined,
};

export function createIndexedDbEndpointSessionPersistence(
  databaseName = SESSION_DATABASE_NAME,
): EndpointSessionPersistence {
  return {
    async persist(accountId, deviceKey, expiresAt) {
      // Refuse to persist anything but the shape the channel accepts. An
      // extractable key would put exportable K_dev bytes on disk.
      if (!isShareableDeviceKey(deviceKey)) return;
      const record: PersistedSessionRecord = {
        version: SESSION_RECORD_VERSION,
        accountId,
        deviceKey,
        createdAt: Date.now(),
        expiresAt,
      };
      await withStore(databaseName, 'readwrite', (store) => request(store.put(record))).catch(
        () => undefined,
      );
    },
    async read(accountId, now) {
      const record = await withStore(databaseName, 'readonly', (store) =>
        request<unknown>(store.get(accountId)),
      ).catch(() => null);
      if (!isPersistedSessionRecord(record, accountId)) return null;
      if (record.expiresAt <= now || !isShareableDeviceKey(record.deviceKey)) {
        await this.clear(accountId);
        return null;
      }
      return record.deviceKey;
    },
    async clear(accountId) {
      await withStore(databaseName, 'readwrite', (store) => request(store.delete(accountId))).catch(
        () => undefined,
      );
    },
  };
}

function isPersistedSessionRecord(
  value: unknown,
  accountId: string,
): value is PersistedSessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Record<keyof PersistedSessionRecord, unknown>>;
  return (
    record.version === SESSION_RECORD_VERSION &&
    record.accountId === accountId &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt) &&
    typeof record.createdAt === 'number' &&
    record.deviceKey != null
  );
}

async function withStore<T>(
  databaseName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const factory = globalThis.indexedDB;
  if (factory == null) throw new Error('IndexedDB is unavailable.');
  const db = await openDatabase(factory, databaseName);
  try {
    const transaction = db.transaction(SESSION_STORE, mode);
    const store = transaction.objectStore(SESSION_STORE);
    const result = await operation(store);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
    });
    return result;
  } finally {
    db.close();
  }
}

function openDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(databaseName, SESSION_DATABASE_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'accountId' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('open failed'));
    open.onblocked = () => reject(new Error('open blocked'));
  });
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error('request failed'));
  });
}

import { EndpointKeystoreError } from './errors';

/**
 * "Keep unlocked on this device", ported to the per-portfolio endpoint keystore.
 *
 * ── THE CONSTRUCTION IS THE LEGACY ONE, UNCHANGED ─────────────────────────
 *
 * `../custody.ts` already solved this for the account-level vault, and this
 * module is that file applied one layer down. Nothing here is new crypto:
 *
 *   • The persisted artifact is the session secret imported as a
 *     NON-EXTRACTABLE AES-256-GCM `CryptoKey`. The browser's own key store is
 *     the wrap; there is no second key, no KDF and no envelope. Once written,
 *     the bytes cannot be read back by any script on this origin — only used.
 *   • It is structured-cloned into its OWN IndexedDB database (the legacy
 *     custody lives in `bettertrack-vault-custody`, separate from vault data;
 *     this one lives beside, separate from `bettertrack-paranoid-keystore-v1`).
 *     Keeping it out of the keystore database also means no schema-version bump
 *     on a database other tabs hold open — on this estate a merge is a deploy.
 *   • Read-back is validated (`!extractable`, `type === 'secret'`, AES-GCM-256)
 *     and a record that fails is DELETED and treated as absent. A browser that
 *     cannot clone CryptoKeys therefore degrades to "no custody", never to raw
 *     key bytes at rest.
 *   • Revocation is the IndexedDB delete, plus the independent localStorage
 *     marker below.
 *
 * ── WHAT IS PERSISTED, AND WHY IT IS THE RIGHT SECRET ─────────────────────
 *
 * The legacy persists VK, the one secret its lock core holds. The endpoint
 * keystore's equivalent root is K_dev — the Argon2id-derived device key — because
 * `unlock()` re-derives EVERYTHING else from it: K_dev unwraps every stored
 * phrase entry into BIP39 entropy, the entropy becomes the mnemonic, and the
 * mnemonic opens the vault header into a content key. Persisting K_dev is
 * therefore persisting exactly one session, no more, and it is usable only as an
 * AES-GCM key — which is all `deviceCrypto` ever does with it.
 *
 * ── THE SECOND, INDEPENDENT LOCK ──────────────────────────────────────────
 *
 * `VaultRuntimeProvider`'s §12 marker, mirrored: every user-intended lock writes
 * `bettertrack:endpoint-device-locked:<accountId>` BEFORE it awaits anything, and
 * a restore refuses while it is set. A lock whose IndexedDB delete never landed
 * (quota, private mode, a tab killed mid-write) still fails closed, and an
 * unreadable localStorage reads as LOCKED.
 */

const CUSTODY_DATABASE_NAME = 'bettertrack-endpoint-custody-v1';
const CUSTODY_STORE_NAME = 'keys';
const CUSTODY_DEVICE_STORAGE_PREFIX = 'bettertrack:endpoint-custody-device:';
const DEVICE_LOCKED_STORAGE_PREFIX = 'bettertrack:endpoint-device-locked:';
const DEVICE_KEY_BITS = 256;

/**
 * What the keystore holds as K_dev. Raw bytes for a session derived in this tab;
 * an opaque CryptoKey for one restored from device custody — which is precisely
 * why a restored session can never be written back to custody.
 */
export type EndpointDeviceKeyMaterial = Uint8Array | CryptoKey;

export interface EndpointDeviceCustody {
  read(custodyId: string): Promise<CryptoKey | null>;
  persist(custodyId: string, deviceKey: Uint8Array): Promise<void>;
  clear(custodyId: string): Promise<void>;
}

export interface IndexedDbEndpointDeviceCustodyOptions {
  /** A distinct name models a distinct browser endpoint in tests and adapters. */
  databaseName?: string;
}

export function createIndexedDbEndpointDeviceCustody(
  options: IndexedDbEndpointDeviceCustodyOptions = {},
): EndpointDeviceCustody {
  const databaseName = options.databaseName ?? CUSTODY_DATABASE_NAME;

  return {
    async read(custodyId) {
      const db = await openCustodyDb(databaseName);
      try {
        const key = await request<CryptoKey | undefined>(store(db, 'readonly').get(custodyId));
        if (key == null || !isNonExtractableDeviceKey(key)) {
          if (key != null) await deleteKey(db, custodyId);
          return null;
        }
        return key;
      } finally {
        db.close();
      }
    },

    async persist(custodyId, deviceKey) {
      if (deviceKey.length !== DEVICE_KEY_BITS / 8) {
        throw new EndpointKeystoreError('custody-failed', 'Device key must be 256 bits.');
      }
      const subtle = globalThis.crypto?.subtle;
      if (subtle == null) {
        throw new EndpointKeystoreError(
          'crypto-failed',
          'WebCrypto is unavailable for device custody.',
        );
      }
      const key = await subtle.importKey('raw', deviceKey, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]);
      if (key.extractable) {
        throw new EndpointKeystoreError(
          'custody-failed',
          'Browser returned an extractable device key.',
        );
      }
      const db = await openCustodyDb(databaseName);
      try {
        await complete(store(db, 'readwrite').put(key, custodyId));
      } catch (cause) {
        throw new EndpointKeystoreError(
          'custody-failed',
          'Browser could not persist a non-extractable device key.',
          {},
          { cause },
        );
      } finally {
        db.close();
      }
    },

    async clear(custodyId) {
      const db = await openCustodyDb(databaseName);
      try {
        await deleteKey(db, custodyId);
      } finally {
        db.close();
      }
    },
  };
}

/**
 * The per-account custody id, mirroring `VaultRuntimeProvider.custodyDeviceId`:
 * a random UUID minted once per account and kept in localStorage, so one
 * account's custody record can never be read by another's session. A storage
 * failure yields a throwaway id — custody then finds nothing and the endpoint
 * simply asks for the password, which is the fail-closed direction.
 */
export function endpointCustodyId(accountId: string): string {
  const key = `${CUSTODY_DEVICE_STORAGE_PREFIX}${accountId}`;
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (stored) return stored;
    const created = globalThis.crypto.randomUUID();
    globalThis.localStorage?.setItem(key, created);
    return created;
  } catch {
    return globalThis.crypto.randomUUID();
  }
}

export function rememberEndpointDeviceLocked(accountId: string): void {
  try {
    globalThis.localStorage?.setItem(`${DEVICE_LOCKED_STORAGE_PREFIX}${accountId}`, '1');
  } catch {
    // If persistence is unavailable, custody is unavailable too; restore fails closed.
  }
}

export function forgetEndpointDeviceLocked(accountId: string): void {
  try {
    globalThis.localStorage?.removeItem(`${DEVICE_LOCKED_STORAGE_PREFIX}${accountId}`);
  } catch {
    // Keeping the marker is the fail-closed outcome.
  }
}

export function isEndpointDeviceLocked(accountId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(`${DEVICE_LOCKED_STORAGE_PREFIX}${accountId}`) === '1';
  } catch {
    return true;
  }
}

/**
 * The same predicate `crypto.ts` applies before it will use a CryptoKey as vault
 * key material. Checking it HERE as well means a junk record is deleted at the
 * custody layer instead of surfacing as an authentication failure later.
 */
function isNonExtractableDeviceKey(key: CryptoKey): boolean {
  return (
    !key.extractable &&
    key.type === 'secret' &&
    key.algorithm.name === 'AES-GCM' &&
    (key.algorithm as AesKeyAlgorithm).length === DEVICE_KEY_BITS
  );
}

function openCustodyDb(databaseName: string): Promise<IDBDatabase> {
  if (globalThis.indexedDB == null) {
    return Promise.reject(new EndpointKeystoreError('custody-failed', 'IndexedDB is unavailable.'));
  }
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(CUSTODY_STORE_NAME)) {
        open.result.createObjectStore(CUSTODY_STORE_NAME);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(
        new EndpointKeystoreError(
          'custody-failed',
          'IndexedDB could not open.',
          {},
          {
            cause: open.error,
          },
        ),
      );
    open.onblocked = () =>
      reject(new EndpointKeystoreError('custody-failed', 'IndexedDB open was blocked.'));
  });
}

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(CUSTODY_STORE_NAME, mode).objectStore(CUSTODY_STORE_NAME);
}

function deleteKey(db: IDBDatabase, custodyId: string): Promise<void> {
  return complete(store(db, 'readwrite').delete(custodyId));
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

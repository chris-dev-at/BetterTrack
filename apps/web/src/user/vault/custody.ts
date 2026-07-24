import { zeroBytes } from './bytes';
import { VaultCryptoError } from './errors';

const DATABASE_NAME = 'bettertrack-vault-custody';
const STORE_NAME = 'keys';

export interface DeviceVaultCustody {
  read(deviceId: string): Promise<CryptoKey | null>;
  persist(deviceId: string, vaultKey: Uint8Array): Promise<void>;
  clear(deviceId: string): Promise<void>;
}

/**
 * IndexedDB custody only ever writes an AES-GCM CryptoKey imported as
 * non-extractable. A browser that cannot clone CryptoKeys rejects persistence;
 * it never falls back to raw VK bytes.
 */
export function createIndexedDbVaultCustody(): DeviceVaultCustody {
  return {
    async read(deviceId) {
      const db = await openCustodyDb();
      try {
        const key = await request<CryptoKey | undefined>(store(db, 'readonly').get(deviceId));
        if (key == null || key.extractable || key.type !== 'secret') {
          if (key != null) await deleteKey(db, deviceId);
          return null;
        }
        return key;
      } finally {
        db.close();
      }
    },
    async persist(deviceId, vaultKey) {
      if (vaultKey.length !== 32) {
        throw new VaultCryptoError('custody-failed', 'Vault key must be 256 bits.');
      }
      const subtle = globalThis.crypto?.subtle;
      if (subtle == null) {
        throw new VaultCryptoError(
          'unsupported-crypto',
          'WebCrypto is unavailable for device custody.',
        );
      }
      const key = await subtle.importKey('raw', vaultKey, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]);
      if (key.extractable) {
        throw new VaultCryptoError('custody-failed', 'Browser returned an extractable device key.');
      }
      const db = await openCustodyDb();
      try {
        await complete(store(db, 'readwrite').put(key, deviceId));
      } catch (cause) {
        throw new VaultCryptoError(
          'custody-failed',
          'Browser could not persist a non-extractable device key.',
          {
            cause,
          },
        );
      } finally {
        db.close();
      }
    },
    async clear(deviceId) {
      const db = await openCustodyDb();
      try {
        await deleteKey(db, deviceId);
      } finally {
        db.close();
      }
    },
  };
}

export async function exportDeviceKey(key: CryptoKey): Promise<Uint8Array> {
  if (key.extractable) {
    throw new VaultCryptoError('custody-failed', 'Extractable device keys are not accepted.');
  }
  throw new VaultCryptoError(
    'custody-failed',
    'Non-extractable device keys cannot expose raw vault bytes.',
  );
}

function openCustodyDb(): Promise<IDBDatabase> {
  if (globalThis.indexedDB == null) {
    return Promise.reject(new VaultCryptoError('custody-failed', 'IndexedDB is unavailable.'));
  }
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE_NAME))
        open.result.createObjectStore(STORE_NAME);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(
        new VaultCryptoError('custody-failed', 'IndexedDB could not open.', { cause: open.error }),
      );
  });
}

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function deleteKey(db: IDBDatabase, deviceId: string): Promise<void> {
  return complete(store(db, 'readwrite').delete(deviceId));
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function complete<T>(request: IDBRequest<T>): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('IndexedDB write failed.'));
  });
}

export function disposeVaultKey(vaultKey: Uint8Array | null): void {
  if (vaultKey != null) zeroBytes(vaultKey);
}

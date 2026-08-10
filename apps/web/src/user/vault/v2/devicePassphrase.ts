import { base64ToBytes, bytesToBase64, decodeUtf8, utf8, zeroBytes } from '../bytes';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveVaultKek,
  generateVaultSalt,
  secureRandomBytes,
  VAULT_ARGON2_PARAMS,
  VAULT_IV_BYTES,
  type RandomBytes,
  type VaultCryptoDeps,
} from '../crypto';
import { VaultCryptoError } from '../errors';

import { normalizeVaultPassphrase, requireVaultPassphrase } from './words';

/**
 * Device storage of the vault passphrase `P` (`docs/VAULTS_V2_DESIGN.md` §2).
 *
 * ```
 * device password D ──Argon2id(D, deviceSalt)──► K_d ──AES-GCM──► stored P
 * ```
 *
 * Two modes, and the difference is the whole security story the explainer page
 * has to tell:
 *
 * - `wrapped` (the DEFAULT): `P` is encrypted under a key derived from a
 *   password only the user knows. A stolen, unlocked device yields ciphertext.
 * - `raw` (explicit opt-in): `P` is stored in the clear so unlock is instant. A
 *   stolen, unlocked device opens the vault immediately. The UI gates this
 *   behind a typed confirmation, and this module refuses to write it unless the
 *   caller passes {@link RAW_STORAGE_ACKNOWLEDGEMENT}.
 *
 * Records live in IndexedDB (not `localStorage`) so they are not readable by a
 * synchronous `document.cookie`-style sweep and are cleared by the same
 * site-data reset as the v1 custody store.
 */

const DATABASE_NAME = 'bettertrack-vault2-devices';
const STORE_NAME = 'passphrases';
const DATABASE_VERSION = 1;

/**
 * The literal a caller must pass to persist an unencrypted passphrase. It makes
 * "store the secret in the clear" impossible to reach by passing a stray
 * boolean through a refactor.
 */
export const RAW_STORAGE_ACKNOWLEDGEMENT =
  'i-accept-that-a-stolen-device-opens-this-vault' as const;

export type StoredVaultPassphraseMode = 'wrapped' | 'raw';

interface WrappedRecord {
  vaultId: string;
  mode: 'wrapped';
  kdfSalt: string;
  /** `iv ‖ AES-GCM(K_d, P)` with the vault id as additional authenticated data. */
  payload: string;
  storedAt: string;
}

interface RawRecord {
  vaultId: string;
  mode: 'raw';
  passphrase: string;
  storedAt: string;
}

export type StoredVaultPassphrase = WrappedRecord | RawRecord;

export interface VaultPassphraseVaultStore {
  list(): Promise<StoredVaultPassphrase[]>;
  read(vaultId: string): Promise<StoredVaultPassphrase | null>;
  putWrapped(input: {
    vaultId: string;
    passphrase: string;
    devicePassword: string;
    randomBytes?: RandomBytes;
    deps?: VaultCryptoDeps;
    now?: () => Date;
  }): Promise<void>;
  putRaw(input: {
    vaultId: string;
    passphrase: string;
    acknowledgement: typeof RAW_STORAGE_ACKNOWLEDGEMENT;
    now?: () => Date;
  }): Promise<void>;
  open(input: {
    vaultId: string;
    devicePassword?: string;
    deps?: VaultCryptoDeps;
  }): Promise<string>;
  forget(vaultId: string): Promise<void>;
  forgetAll(): Promise<void>;
}

/**
 * In-memory backing so unit tests and IndexedDB-less environments still work.
 * `seed` accepts pre-built records, which is how tests exercise a store whose
 * rows were tampered with underneath the app.
 */
export function createMemoryVaultPassphraseStore(
  seed: StoredVaultPassphrase[] = [],
): VaultPassphraseVaultStore {
  const records = new Map<string, StoredVaultPassphrase>(
    seed.map((record) => [record.vaultId, record]),
  );
  return buildStore({
    read: (vaultId) => Promise.resolve(records.get(vaultId) ?? null),
    list: () => Promise.resolve([...records.values()]),
    write: (record) => {
      records.set(record.vaultId, record);
      return Promise.resolve();
    },
    remove: (vaultId) => {
      records.delete(vaultId);
      return Promise.resolve();
    },
    clear: () => {
      records.clear();
      return Promise.resolve();
    },
  });
}

export function createIndexedDbVaultPassphraseStore(): VaultPassphraseVaultStore {
  return buildStore({
    async read(vaultId) {
      const db = await openDb();
      try {
        const value = await request<StoredVaultPassphrase | undefined>(
          store(db, 'readonly').get(vaultId),
        );
        return value ?? null;
      } finally {
        db.close();
      }
    },
    async list() {
      const db = await openDb();
      try {
        return await request<StoredVaultPassphrase[]>(store(db, 'readonly').getAll());
      } finally {
        db.close();
      }
    },
    async write(record) {
      const db = await openDb();
      try {
        await complete(store(db, 'readwrite').put(record, record.vaultId));
      } finally {
        db.close();
      }
    },
    async remove(vaultId) {
      const db = await openDb();
      try {
        await complete(store(db, 'readwrite').delete(vaultId));
      } finally {
        db.close();
      }
    },
    async clear() {
      const db = await openDb();
      try {
        await complete(store(db, 'readwrite').clear());
      } finally {
        db.close();
      }
    },
  });
}

interface Backing {
  read(vaultId: string): Promise<StoredVaultPassphrase | null>;
  list(): Promise<StoredVaultPassphrase[]>;
  write(record: StoredVaultPassphrase): Promise<void>;
  remove(vaultId: string): Promise<void>;
  clear(): Promise<void>;
}

function buildStore(backing: Backing): VaultPassphraseVaultStore {
  return {
    list: () => backing.list(),
    read: (vaultId) => backing.read(vaultId),

    async putWrapped({ vaultId, passphrase, devicePassword, randomBytes, deps, now }) {
      const normalized = requireVaultPassphrase(passphrase);
      if (devicePassword.length === 0) {
        throw new VaultCryptoError('storage-failed', 'A device password is required.');
      }
      const random = randomBytes ?? secureRandomBytes;
      const kdfSalt = bytesToBase64(generateVaultSalt(random));
      let deviceKey: Uint8Array | undefined;
      let plaintext: Uint8Array | undefined;
      const iv = random(VAULT_IV_BYTES);
      try {
        deviceKey = await deriveVaultKek(
          devicePassword,
          { ...VAULT_ARGON2_PARAMS, salt: kdfSalt },
          deps,
        );
        plaintext = utf8(normalized);
        const ciphertext = await aesGcmEncrypt(deviceKey, iv, plaintext, utf8(vaultId));
        const payload = new Uint8Array(iv.length + ciphertext.length);
        payload.set(iv);
        payload.set(ciphertext, iv.length);
        await backing.write({
          vaultId,
          mode: 'wrapped',
          kdfSalt,
          payload: bytesToBase64(payload),
          storedAt: (now?.() ?? new Date()).toISOString(),
        });
      } finally {
        zeroBytes(iv);
        if (deviceKey != null) zeroBytes(deviceKey);
        if (plaintext != null) zeroBytes(plaintext);
      }
    },

    async putRaw({ vaultId, passphrase, acknowledgement, now }) {
      if (acknowledgement !== RAW_STORAGE_ACKNOWLEDGEMENT) {
        throw new VaultCryptoError(
          'storage-failed',
          'Unencrypted passphrase storage requires the explicit acknowledgement.',
        );
      }
      await backing.write({
        vaultId,
        mode: 'raw',
        passphrase: requireVaultPassphrase(passphrase),
        storedAt: (now?.() ?? new Date()).toISOString(),
      });
    },

    async open({ vaultId, devicePassword, deps }) {
      const record = await backing.read(vaultId);
      if (record == null) {
        throw new VaultCryptoError('locked', 'This device has no stored passphrase for the vault.');
      }
      if (record.mode === 'raw') return normalizeVaultPassphrase(record.passphrase);
      if (devicePassword == null || devicePassword.length === 0) {
        throw new VaultCryptoError('locked', 'The device password is required.');
      }

      let deviceKey: Uint8Array | undefined;
      let payload: Uint8Array | undefined;
      let plaintext: Uint8Array | undefined;
      try {
        payload = base64ToBytes(record.payload, 'envelope-invalid');
        if (payload.length <= VAULT_IV_BYTES + 16) {
          throw new VaultCryptoError('storage-failed', 'The stored passphrase record is invalid.');
        }
        deviceKey = await deriveVaultKek(
          devicePassword,
          { ...VAULT_ARGON2_PARAMS, salt: record.kdfSalt },
          deps,
        );
        plaintext = await aesGcmDecrypt(
          deviceKey,
          payload.subarray(0, VAULT_IV_BYTES),
          payload.subarray(VAULT_IV_BYTES),
          utf8(vaultId),
        );
        return normalizeVaultPassphrase(decodeUtf8(plaintext, 'document-invalid'));
      } finally {
        if (deviceKey != null) zeroBytes(deviceKey);
        if (payload != null) zeroBytes(payload);
        if (plaintext != null) zeroBytes(plaintext);
      }
    },

    forget: (vaultId) => backing.remove(vaultId),
    forgetAll: () => backing.clear(),
  };
}

function openDb(): Promise<IDBDatabase> {
  if (globalThis.indexedDB == null) {
    return Promise.reject(new VaultCryptoError('storage-failed', 'IndexedDB is unavailable.'));
  }
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE_NAME)) {
        open.result.createObjectStore(STORE_NAME);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(
        new VaultCryptoError('storage-failed', 'IndexedDB could not open.', { cause: open.error }),
      );
  });
}

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function request<T>(idbRequest: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error ?? new Error('IndexedDB request failed.'));
  });
}

function complete<T>(idbRequest: IDBRequest<T>): Promise<void> {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve();
    idbRequest.onerror = () => reject(idbRequest.error ?? new Error('IndexedDB write failed.'));
  });
}

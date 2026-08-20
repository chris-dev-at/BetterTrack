export const ENDPOINT_KEYSTORE_DATABASE_NAME = 'bettertrack-paranoid-keystore-v1';
export const ENDPOINT_KEYSTORE_DATABASE_VERSION = 2;
export const ENDPOINT_KEYSTORE_CONTROL_STORE = 'control';
export const ENDPOINT_KEYSTORE_METADATA_STORE = 'metadata';
export const ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE = 'phrase-entries';

const CONTROL_RECORD_KEY = 'endpoint';
const CONTROL_RECORD_VERSION = 1;
// Avoid an ABA match with any realistic stale tab revision when corruption
// destroys the prior counter and reset must establish a fresh CAS epoch.
const CORRUPT_CONTROL_RECOVERY_REVISION = 2 ** 52;
const METADATA_RECORD_KEY = 'endpoint';

interface EndpointControlRecord {
  version: typeof CONTROL_RECORD_VERSION;
  revision: number;
}

export interface EndpointKeystoreSnapshot {
  revision: number;
  metadata: unknown | null;
}

export interface EndpointKeystoreEntryRecord {
  vaultId: string;
  value: unknown;
}

export type EndpointKeystoreEntriesResult =
  | { status: 'current'; revision: number; entries: EndpointKeystoreEntryRecord[] }
  | { status: 'stale'; revision: number };

export type EndpointMetadataInitializationResult = {
  status: 'created' | 'exists' | 'stale';
  revision: number;
};

export type EndpointMetadataUpdateResult<T> =
  | { status: 'updated'; revision: number; result: T }
  | { status: 'stale'; revision: number };

type EndpointEntryMutationResult<TSuccess extends 'written' | 'deleted'> =
  | { status: TSuccess; revision: number }
  | { status: 'stale'; revision: number };

export type EndpointEntryWriteResult = EndpointEntryMutationResult<'written'>;

export type EndpointEntryDeleteResult = EndpointEntryMutationResult<'deleted'>;

export interface EndpointKeystoreStorage {
  /** Atomically read the untrusted metadata together with its CAS revision. */
  readEndpointSnapshot(): Promise<EndpointKeystoreSnapshot>;
  initializeMetadata(
    expectedRevision: number,
    value: unknown,
  ): Promise<EndpointMetadataInitializationResult>;
  /** The updater must be synchronous so its read and write stay in one IDB transaction. */
  updateMetadata<T>(
    expectedRevision: number,
    updater: (current: unknown | null) => { value: unknown; result: T },
  ): Promise<EndpointMetadataUpdateResult<T>>;
  /** Compatibility read only; mutation sequences use the revision-checked APIs. */
  readEntry(vaultId: string): Promise<unknown | null>;
  /** Atomically list keyed, untrusted entries if the caller's snapshot is current. */
  listEntries(expectedRevision: number): Promise<EndpointKeystoreEntriesResult>;
  /** Returns stale without writing when expectedRevision no longer matches. */
  writeEntry(
    expectedRevision: number,
    vaultId: string,
    value: unknown,
  ): Promise<EndpointEntryWriteResult>;
  /** Returns stale without deleting when expectedRevision no longer matches. */
  deleteEntry(expectedRevision: number, vaultId: string): Promise<EndpointEntryDeleteResult>;
  /**
   * Atomically remove this endpoint's metadata and phrases while advancing the
   * internal revision. Remote server/Drive ciphertext is outside this database.
   */
  reset(): Promise<{ revision: number }>;
}

export type EndpointKeystoreStorageErrorCode =
  | 'unavailable'
  | 'open-failed'
  | 'read-failed'
  | 'write-failed'
  | 'reset-failed';

/** A fail-closed endpoint keystore persistence failure. */
export class EndpointKeystoreStorageError extends Error {
  constructor(
    public readonly code: EndpointKeystoreStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EndpointKeystoreStorageError';
  }
}

export interface IndexedDbEndpointKeystoreStorageOptions {
  /** A distinct name models a distinct browser/native endpoint in tests and adapters. */
  databaseName?: string;
}

/**
 * IndexedDB persistence for the new per-endpoint paranoid keystore. This is a
 * separate database from v1 custody and never stores volatile unlock state.
 */
export function createIndexedDbEndpointKeystoreStorage(
  options: IndexedDbEndpointKeystoreStorageOptions = {},
): EndpointKeystoreStorage {
  const databaseName = options.databaseName ?? ENDPOINT_KEYSTORE_DATABASE_NAME;

  return {
    async readEndpointSnapshot() {
      return perform(
        databaseName,
        'read-failed',
        'Could not read the endpoint keystore snapshot.',
        async (db) =>
          runTransaction(
            db,
            [ENDPOINT_KEYSTORE_CONTROL_STORE, ENDPOINT_KEYSTORE_METADATA_STORE],
            'readonly',
            async (transaction) => {
              const [control, metadata] = await Promise.all([
                readControl(transaction),
                request<unknown | undefined>(
                  transaction
                    .objectStore(ENDPOINT_KEYSTORE_METADATA_STORE)
                    .get(METADATA_RECORD_KEY),
                ),
              ]);
              return { revision: control.revision, metadata: nullableResult(metadata) };
            },
          ),
      );
    },

    async initializeMetadata(expectedRevision, value) {
      requireRevision(expectedRevision, 'Expected endpoint revision');
      return perform(
        databaseName,
        'write-failed',
        'Could not initialize endpoint keystore metadata.',
        async (db) =>
          runTransaction(
            db,
            [ENDPOINT_KEYSTORE_CONTROL_STORE, ENDPOINT_KEYSTORE_METADATA_STORE],
            'readwrite',
            async (transaction) => {
              const metadata = transaction.objectStore(ENDPOINT_KEYSTORE_METADATA_STORE);
              const [control, existingKey] = await Promise.all([
                readControl(transaction),
                request<IDBValidKey | undefined>(metadata.getKey(METADATA_RECORD_KEY)),
              ]);
              if (control.revision !== expectedRevision) {
                return { status: 'stale', revision: control.revision } as const;
              }
              if (existingKey !== undefined) {
                return { status: 'exists', revision: control.revision } as const;
              }
              const next = advanceControl(control);
              await Promise.all([
                request(metadata.put(value, METADATA_RECORD_KEY)),
                writeControl(transaction, next),
              ]);
              return { status: 'created', revision: next.revision } as const;
            },
          ),
      );
    },

    async updateMetadata<T>(
      expectedRevision: number,
      updater: (current: unknown | null) => { value: unknown; result: T },
    ) {
      requireRevision(expectedRevision, 'Expected endpoint revision');
      return perform(
        databaseName,
        'write-failed',
        'Could not update endpoint keystore metadata.',
        async (db) =>
          runTransaction<EndpointMetadataUpdateResult<T>>(
            db,
            [ENDPOINT_KEYSTORE_CONTROL_STORE, ENDPOINT_KEYSTORE_METADATA_STORE],
            'readwrite',
            async (transaction) => {
              const metadata = transaction.objectStore(ENDPOINT_KEYSTORE_METADATA_STORE);
              const [control, current] = await Promise.all([
                readControl(transaction),
                request<unknown | undefined>(metadata.get(METADATA_RECORD_KEY)),
              ]);
              if (control.revision !== expectedRevision) {
                return { status: 'stale', revision: control.revision };
              }
              const update = updater(nullableResult(current));
              const next = advanceControl(control);
              await Promise.all([
                request(metadata.put(update.value, METADATA_RECORD_KEY)),
                writeControl(transaction, next),
              ]);
              return { status: 'updated', revision: next.revision, result: update.result };
            },
          ),
      );
    },

    async readEntry(vaultId) {
      return perform(
        databaseName,
        'read-failed',
        'Could not read an endpoint keystore phrase entry.',
        async (db) =>
          runTransaction(
            db,
            ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE,
            'readonly',
            async (transaction) =>
              nullableResult(
                await request<unknown | undefined>(
                  transaction.objectStore(ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE).get(vaultId),
                ),
              ),
          ),
      );
    },

    async listEntries(expectedRevision) {
      requireRevision(expectedRevision, 'Expected endpoint revision');
      return perform(
        databaseName,
        'read-failed',
        'Could not list endpoint keystore phrase entries.',
        async (db) =>
          runTransaction<EndpointKeystoreEntriesResult>(
            db,
            [ENDPOINT_KEYSTORE_CONTROL_STORE, ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE],
            'readonly',
            async (transaction) => {
              const entries = transaction.objectStore(ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE);
              const [control, keys, values] = await Promise.all([
                readControl(transaction),
                request<IDBValidKey[]>(entries.getAllKeys()),
                request<unknown[]>(entries.getAll()),
              ]);
              if (control.revision !== expectedRevision) {
                return { status: 'stale', revision: control.revision };
              }
              if (keys.length !== values.length || keys.some((key) => typeof key !== 'string')) {
                throw new Error('Endpoint keystore phrase-entry keys are invalid.');
              }
              return {
                status: 'current',
                revision: control.revision,
                entries: keys.map((vaultId, index) => ({
                  vaultId: vaultId as string,
                  value: values[index],
                })),
              };
            },
          ),
      );
    },

    async writeEntry(expectedRevision, vaultId, value) {
      requireRevision(expectedRevision, 'Expected endpoint revision');
      return perform(
        databaseName,
        'write-failed',
        'Could not write an endpoint keystore phrase entry.',
        async (db) =>
          mutateEntry(db, expectedRevision, 'written', (entries) =>
            request(entries.put(value, vaultId)),
          ),
      );
    },

    async deleteEntry(expectedRevision, vaultId) {
      requireRevision(expectedRevision, 'Expected endpoint revision');
      return perform(
        databaseName,
        'write-failed',
        'Could not delete an endpoint keystore phrase entry.',
        async (db) =>
          mutateEntry(db, expectedRevision, 'deleted', (entries) =>
            request(entries.delete(vaultId)),
          ),
      );
    },

    async reset() {
      return perform(
        databaseName,
        'reset-failed',
        'Could not reset the endpoint keystore.',
        async (db) =>
          runTransaction(
            db,
            [
              ENDPOINT_KEYSTORE_CONTROL_STORE,
              ENDPOINT_KEYSTORE_METADATA_STORE,
              ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE,
            ],
            'readwrite',
            async (transaction) => {
              // Reset is the recovery path for an untrusted/corrupt local
              // keystore, so it must not depend on a valid control record.
              const control = await readControlForReset(transaction);
              const next = advanceControl(control);
              await Promise.all([
                request(transaction.objectStore(ENDPOINT_KEYSTORE_METADATA_STORE).clear()),
                request(transaction.objectStore(ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE).clear()),
                writeControl(transaction, next),
              ]);
              return { revision: next.revision };
            },
          ),
      );
    },
  };
}

async function mutateEntry<TSuccess extends 'written' | 'deleted'>(
  db: IDBDatabase,
  expectedRevision: number,
  success: TSuccess,
  mutate: (entries: IDBObjectStore) => Promise<unknown>,
): Promise<EndpointEntryMutationResult<TSuccess>> {
  return runTransaction(
    db,
    [ENDPOINT_KEYSTORE_CONTROL_STORE, ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE],
    'readwrite',
    async (transaction) => {
      const control = await readControl(transaction);
      if (control.revision !== expectedRevision) {
        return { status: 'stale', revision: control.revision };
      }
      const entries = transaction.objectStore(ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE);
      const next = advanceControl(control);
      await Promise.all([mutate(entries), writeControl(transaction, next)]);
      return { status: success, revision: next.revision };
    },
  );
}

async function readControl(transaction: IDBTransaction): Promise<EndpointControlRecord> {
  const value: unknown = await request(
    transaction.objectStore(ENDPOINT_KEYSTORE_CONTROL_STORE).get(CONTROL_RECORD_KEY),
  );
  if (!isControlRecord(value)) {
    throw new Error('Endpoint keystore revision control is missing or malformed.');
  }
  return value;
}

async function readControlForReset(transaction: IDBTransaction): Promise<EndpointControlRecord> {
  const value: unknown = await request(
    transaction.objectStore(ENDPOINT_KEYSTORE_CONTROL_STORE).get(CONTROL_RECORD_KEY),
  );
  return isControlRecord(value)
    ? value
    : { version: CONTROL_RECORD_VERSION, revision: CORRUPT_CONTROL_RECOVERY_REVISION };
}

function writeControl(
  transaction: IDBTransaction,
  value: EndpointControlRecord,
): Promise<IDBValidKey> {
  return request(
    transaction.objectStore(ENDPOINT_KEYSTORE_CONTROL_STORE).put(value, CONTROL_RECORD_KEY),
  );
}

function advanceControl(control: EndpointControlRecord): EndpointControlRecord {
  if (control.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Endpoint keystore revision is exhausted.');
  }
  return { version: CONTROL_RECORD_VERSION, revision: control.revision + 1 };
}

function isControlRecord(value: unknown): value is EndpointControlRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { version?: unknown; revision?: unknown };
  return (
    Object.keys(value).length === 2 &&
    record.version === CONTROL_RECORD_VERSION &&
    Number.isSafeInteger(record.revision) &&
    Number(record.revision) >= 0
  );
}

function requireRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
}

async function perform<T>(
  databaseName: string,
  errorCode: Exclude<EndpointKeystoreStorageErrorCode, 'unavailable' | 'open-failed'>,
  message: string,
  operation: (db: IDBDatabase) => Promise<T>,
): Promise<T> {
  let db: IDBDatabase;
  try {
    db = await openDatabase(databaseName);
  } catch (cause) {
    throw asStorageError('open-failed', 'Could not open the endpoint keystore.', cause);
  }

  try {
    return await operation(db);
  } catch (cause) {
    throw asStorageError(errorCode, message, cause);
  } finally {
    db.close();
  }
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  if (factory == null) {
    return Promise.reject(
      new EndpointKeystoreStorageError('unavailable', 'IndexedDB is unavailable.'),
    );
  }

  return new Promise((resolve, reject) => {
    const open = factory.open(databaseName, ENDPOINT_KEYSTORE_DATABASE_VERSION);
    let settled = false;

    open.onupgradeneeded = () => ensureSchema(open.result);
    open.onsuccess = () => {
      if (settled) {
        open.result.close();
        return;
      }
      settled = true;
      resolve(open.result);
    };
    open.onerror = () => {
      if (settled) return;
      settled = true;
      reject(
        new EndpointKeystoreStorageError('open-failed', 'IndexedDB could not open.', {
          cause: open.error,
        }),
      );
    };
    open.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(
        new EndpointKeystoreStorageError('open-failed', 'IndexedDB schema upgrade was blocked.'),
      );
    };
  });
}

function ensureSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(ENDPOINT_KEYSTORE_CONTROL_STORE)) {
    const control = db.createObjectStore(ENDPOINT_KEYSTORE_CONTROL_STORE);
    control.put(
      { version: CONTROL_RECORD_VERSION, revision: 0 } satisfies EndpointControlRecord,
      CONTROL_RECORD_KEY,
    );
  }
  if (!db.objectStoreNames.contains(ENDPOINT_KEYSTORE_METADATA_STORE)) {
    db.createObjectStore(ENDPOINT_KEYSTORE_METADATA_STORE);
  }
  if (!db.objectStoreNames.contains(ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE)) {
    db.createObjectStore(ENDPOINT_KEYSTORE_PHRASE_ENTRIES_STORE);
  }
}

async function runTransaction<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const transaction = db.transaction(storeNames, mode);
  const completion = transactionCompletion(transaction);

  try {
    const result = await operation(transaction);
    await completion;
    return result;
  } catch (cause) {
    try {
      transaction.abort();
    } catch {
      // Preserve the original failure if IndexedDB already finished the transaction.
    }
    await completion.catch(() => undefined);
    throw cause;
  }
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

function nullableResult(value: unknown | undefined): unknown | null {
  return value === undefined ? null : value;
}

function asStorageError(
  code: EndpointKeystoreStorageErrorCode,
  message: string,
  cause: unknown,
): EndpointKeystoreStorageError {
  return cause instanceof EndpointKeystoreStorageError
    ? cause
    : new EndpointKeystoreStorageError(code, message, { cause });
}

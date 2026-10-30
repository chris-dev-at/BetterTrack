import {
  createVaultResponseSchema,
  driveConnectionListResponseSchema,
  vaultIdParamSchema,
  vaultListResponseSchema,
  type VaultConfig,
} from '@bettertrack/contracts';

import { apiRequest } from '../../../lib/apiClient';
import { apiBaseUrl, getGoogleDriveClientId } from '../../../lib/runtimeConfig';
import { VAULT_LOCK_REQUEST_EVENT, vaultLockSignalStorageKey } from '../lockSignal';
import type { EndpointVaultKeystore } from '../keystore/core';
import { bindEndpointKeystoreAccount, endpointVaultKeystore } from '../keystore/runtime';
import type { FetchVaultHeaderEnvelope, OpenedVault } from '../keystore/types';
import { createVaultDriveHeaderReader, type VaultDriveHeaderReader } from './driveHeader';

export interface VaultTransferRuntime {
  keystore: EndpointVaultKeystore;
  /**
   * True when the keystore behind this runtime is revoked by the shared
   * logout/PIN signal — either because this runtime bound the listeners itself
   * or because the keystore already owns them (`keystore/runtime.ts` binds
   * `bindToVaultLockSignal()` for the app singleton). `VaultRuntimeProvider`
   * reads it to suppress its own echo of the same signal.
   */
  readonly lockSignalBound: boolean;
  listVaults(): Promise<readonly VaultConfig[]>;
  fetchHeaderEnvelope: FetchVaultHeaderEnvelope;
  /** Installs a receiver's verified-open receipt in this endpoint-wide app session. */
  registerOpenedVault(opened: OpenedVault): void;
  isVaultOpen(vaultId: string): boolean;
  /**
   * Binds the account this transfer surface belongs to: the keystore's §12
   * session boundary, Drive document addressing and the cross-tab lock key.
   */
  setAccountId(accountId: string | null): void;
  /** The shared synchronous revocation seam used by every app lock path. */
  endSession(): void;
  /** Focused adapters/tests release global listeners and memory capabilities. */
  dispose(): void;
}

export interface CreateVaultTransferRuntimeOptions {
  /**
   * The endpoint keystore this runtime drives. Defaults to the app's ONE
   * endpoint-scoped keystore — see the note on `createVaultTransferRuntime`.
   * Focused tests and adapters hand in their own.
   */
  keystore?: EndpointVaultKeystore;
  /**
   * How that keystore learns which account it belongs to. Defaults to the
   * shared endpoint binding for the app singleton (which also drops the
   * per-tab resume memo) and to the keystore's own `bindAccount` otherwise.
   */
  bindAccount?: (accountId: string | null) => void;
  requestJson?: (path: string, init?: { signal?: AbortSignal }) => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
  /**
   * Drive addressing only, for focused tests that never sign in. The §12
   * account binding is an EDGE, not a constructor argument — it is
   * `setAccountId` (the app's sign-in/sign-out/switch seam) that binds, so a
   * module singleton built at import time can never bind the shared keystore
   * behind the shell's back.
   */
  accountId?: string | null;
  driveHeaderReader?: VaultDriveHeaderReader;
  /** Tests and non-window adapters can bind their own lock signal. */
  bindLockSignal?: boolean;
}

/**
 * Live E7 bridge between the transfer surfaces, the E3 endpoint keystore and
 * E1's authenticated per-vault blind store.
 *
 * ONE KEYSTORE PER ENDPOINT (#2013). This runtime used to default to a private
 * `new EndpointVaultKeystore()`, which nothing ever bound to an account — so
 * every §12 session edge inside it was a silent no-op (`ensureDeviceKey` and
 * `unlock` guard `rememberSession()`/`forgetEndpointDeviceLocked()` behind a
 * bound account), and a phrase received here left the device LOCKED: the
 * password the user had just proven established no device session, and the
 * manager, chip and locked stubs — which read the app singleton — never saw it.
 *
 * Two instances were never a boundary, only a divergence: §12 scopes a session
 * to the DEVICE, and both instances sat on the SAME IndexedDB, the same
 * account `BroadcastChannel`, the same device-locked marker and the same single
 * device-session record. So this runtime mounts the one endpoint-scoped
 * keystore the rest of the app reads (`keystore/runtime.ts`), which is what E7
 * meant when it noted that "the settings entry points do not need to invent a
 * second keystore or header transport".
 */
export function createVaultTransferRuntime(
  options: CreateVaultTransferRuntimeOptions = {},
): VaultTransferRuntime {
  const keystore = options.keystore ?? endpointVaultKeystore;
  const sharesAppKeystore = keystore === endpointVaultKeystore;
  const bindAccount =
    options.bindAccount ??
    (sharesAppKeystore
      ? bindEndpointKeystoreAccount
      : (next: string | null) => keystore.bindAccount(next));
  const openedVaults = new Map<string, OpenedVault>();
  const requestJson =
    options.requestJson ??
    ((path: string, init?: { signal?: AbortSignal }) => apiRequest<unknown>(path, init));
  const requestRaw =
    options.fetch ??
    ((input: URL | RequestInfo, init?: RequestInit) => globalThis.fetch(input, init));
  const base = options.apiBase ?? apiBaseUrl();
  const driveHeader =
    options.driveHeaderReader ??
    createVaultDriveHeaderReader({
      clientId: getGoogleDriveClientId(),
      fetch: requestRaw,
    });
  let accountId = options.accountId ?? null;
  let disposed = false;
  const lockSignalBound =
    options.bindLockSignal !== false && typeof globalThis.addEventListener === 'function';
  // The app singleton is ALREADY bound to the lock signal by
  // `keystore/runtime.ts` (`releaseEndpointKeystoreLockSignal`), and that
  // binding is the stronger one: it writes the §12 device-locked marker and
  // drops the device-session record (`lockDevice`/`applyRemoteLock`), where the
  // listeners below only end the in-memory session. A second listener on the
  // same events for the same object would add nothing and could only race, so
  // this runtime binds its own only for a keystore it was handed.
  const bindsOwnLockSignal = lockSignalBound && !sharesAppKeystore;

  let unbindLocalLock = () => undefined;
  const onStorageLock = (event: Event) => {
    const storage = event as StorageEvent;
    if (accountId != null && storage.key === vaultLockSignalStorageKey(accountId)) {
      keystore.endSession();
    }
  };
  if (bindsOwnLockSignal) {
    const onLocalLock = () => keystore.endSession();
    globalThis.addEventListener(VAULT_LOCK_REQUEST_EVENT, onLocalLock);
    globalThis.addEventListener('storage', onStorageLock);
    unbindLocalLock = () => {
      globalThis.removeEventListener(VAULT_LOCK_REQUEST_EVENT, onLocalLock);
      globalThis.removeEventListener('storage', onStorageLock);
    };
  }

  // Keystore revocation is authoritative even when a lower-level caller ends
  // it directly (logout/PIN signal, reset, custody replacement).
  const unsubscribeSessionEnd = keystore.subscribeToSessionEnd(() => {
    openedVaults.clear();
    driveHeader.clear();
  });

  return {
    keystore,
    lockSignalBound,

    registerOpenedVault(opened) {
      openedVaults.set(opened.vaultId, opened);
    },

    isVaultOpen(vaultId) {
      return openedVaults.has(vaultId);
    },

    /**
     * The §12 account edge, not bookkeeping (#2013).
     *
     * `bindAccount` owns the revocation half and owns it better than a bare
     * `endSession()` did: a CHANGE of account ends the live session, drops the
     * PREVIOUS account's device-session record — which `endSession()` left on
     * disk for the next sign-in to resume from — and reopens the session
     * channel on the new account's name. The FIRST bind of a tab is not a
     * change and deliberately fires no session end, so binding here cannot
     * revoke the session the shell has just resumed.
     *
     * The one case `bindAccount` cannot see: material this runtime collected
     * while NO account was bound belongs to nobody, and must not be carried
     * into the next one.
     */
    setAccountId(nextAccountId) {
      const next = nextAccountId?.trim() || null;
      if (accountId === next) return;
      if (accountId == null && openedVaults.size > 0) keystore.endSession();
      accountId = next;
      openedVaults.clear();
      driveHeader.clear();
      bindAccount(next);
    },

    endSession() {
      keystore.endSession();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // A disposal is a teardown of THIS adapter, never a lock the user asked
      // for. Ending the app's endpoint session from here would revoke a §12
      // session no one locked; the app singleton's lifetime is the tab's, and
      // the real lock paths (`endSession`, the lock signal) are unaffected.
      if (!sharesAppKeystore) keystore.endSession();
      openedVaults.clear();
      driveHeader.clear();
      unsubscribeSessionEnd();
      unbindLocalLock();
    },

    async listVaults() {
      const response = vaultListResponseSchema.parse(await requestJson('/vaults'));
      return response.vaults;
    },

    async fetchHeaderEnvelope({ vaultId, signal }) {
      const parsedVaultId = vaultIdParamSchema.parse({ vaultId }).vaultId;
      const configResponse = createVaultResponseSchema.parse(
        await requestJsonWithSignal(
          requestJson,
          `/vaults/${encodeURIComponent(parsedVaultId)}`,
          signal,
        ),
      );
      const failures: unknown[] = [];
      for (const medium of configResponse.vault.media) {
        assertNotAborted(signal);
        try {
          if (medium === 'server') {
            const response = await requestRaw(
              `${base}/vaults/${encodeURIComponent(parsedVaultId)}/docs/${encodeURIComponent(configResponse.vault.headerDocId)}`,
              {
                credentials: 'include',
                cache: 'no-store',
                ...(signal ? { signal } : {}),
              },
            );
            if (!response.ok) {
              throw new Error(`Vault header request failed with status ${response.status}.`);
            }
            const envelope = new Uint8Array(await response.arrayBuffer());
            if (envelope.length === 0) throw new Error('Vault header response was empty.');
            return envelope;
          }
          if (medium === 'drive') {
            if (accountId == null) throw new Error('The authenticated account is unavailable.');
            const connectionId = configResponse.vault.driveConnectionId;
            if (connectionId == null) throw new Error('The vault has no bound Drive connection.');
            const connections = driveConnectionListResponseSchema.parse(
              await requestJsonWithSignal(requestJson, '/drive-connections', signal),
            ).connections;
            const connection = connections.find(({ id }) => id === connectionId);
            if (connection == null) throw new Error('The bound Drive connection is unavailable.');
            const envelope = await driveHeader.readHeader({
              accountId,
              connection,
              vaultId: parsedVaultId,
              docId: configResponse.vault.headerDocId,
              ...(signal ? { signal } : {}),
            });
            if (envelope.length === 0) throw new Error('Drive vault header response was empty.');
            return envelope;
          }
          failures.push(new Error(`Vault medium ${medium} is not supported by this client.`));
        } catch (cause) {
          assertNotAborted(signal);
          failures.push(cause);
        }
      }
      throw new AggregateError(failures, 'No configured vault medium returned the header.');
    },
  };
}

function requestJsonWithSignal(
  requestJson: NonNullable<CreateVaultTransferRuntimeOptions['requestJson']>,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return signal == null ? requestJson(path) : requestJson(path, { signal });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The vault header request was canceled.', 'AbortError');
}

/**
 * Endpoint-wide session for the normal (per-vault) app branch. The legacy
 * vault provider references this same instance by default and routes its direct
 * lock paths through the same runtime seam.
 *
 * Its keystore IS `endpointVaultKeystore` (#2013): the transfer surfaces, the
 * manager, the shield chip and the locked stubs are one endpoint and therefore
 * one §12 session.
 */
export const vaultTransferRuntime = createVaultTransferRuntime();

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
import { EndpointVaultKeystore } from '../keystore/core';
import type { FetchVaultHeaderEnvelope, OpenedVault } from '../keystore/types';
import { createVaultDriveHeaderReader, type VaultDriveHeaderReader } from './driveHeader';

export interface VaultTransferRuntime {
  keystore: EndpointVaultKeystore;
  /** True when this runtime itself listens for the shared logout/PIN signal. */
  readonly lockSignalBound: boolean;
  listVaults(): Promise<readonly VaultConfig[]>;
  fetchHeaderEnvelope: FetchVaultHeaderEnvelope;
  /** Installs a receiver's verified-open receipt in this endpoint-wide app session. */
  registerOpenedVault(opened: OpenedVault): void;
  isVaultOpen(vaultId: string): boolean;
  /** Binds Drive document addressing and cross-tab locks to this auth account. */
  setAccountId(accountId: string | null): void;
  /** The shared synchronous revocation seam used by every app lock path. */
  endSession(): void;
  /** Focused adapters/tests release global listeners and memory capabilities. */
  dispose(): void;
}

export interface CreateVaultTransferRuntimeOptions {
  keystore?: EndpointVaultKeystore;
  requestJson?: (path: string, init?: { signal?: AbortSignal }) => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
  accountId?: string | null;
  driveHeaderReader?: VaultDriveHeaderReader;
  /** Tests and non-window adapters can bind their own lock signal. */
  bindLockSignal?: boolean;
}

/**
 * Live E7 bridge between the transfer surfaces, the E3 endpoint keystore and
 * E1's authenticated per-vault blind store. E8 can reuse this runtime when it
 * adds the full manager; the settings entry points do not need to invent a
 * second keystore or header transport in the meantime.
 */
export function createVaultTransferRuntime(
  options: CreateVaultTransferRuntimeOptions = {},
): VaultTransferRuntime {
  const keystore = options.keystore ?? new EndpointVaultKeystore();
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

  let unbindLocalLock = () => undefined;
  const onStorageLock = (event: Event) => {
    const storage = event as StorageEvent;
    if (accountId != null && storage.key === vaultLockSignalStorageKey(accountId)) {
      keystore.endSession();
    }
  };
  if (lockSignalBound) {
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

    setAccountId(nextAccountId) {
      const next = nextAccountId?.trim() || null;
      if (accountId === next) return;
      if (accountId != null || openedVaults.size > 0) keystore.endSession();
      else driveHeader.clear();
      accountId = next;
    },

    endSession() {
      keystore.endSession();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      keystore.endSession();
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
 */
export const vaultTransferRuntime = createVaultTransferRuntime();

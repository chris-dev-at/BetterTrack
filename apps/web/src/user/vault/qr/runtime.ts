import {
  createVaultResponseSchema,
  vaultIdParamSchema,
  vaultListResponseSchema,
  type VaultConfig,
} from '@bettertrack/contracts';

import { apiRequest } from '../../../lib/apiClient';
import { apiBaseUrl } from '../../../lib/runtimeConfig';
import { EndpointVaultKeystore } from '../keystore/core';
import type { FetchVaultHeaderEnvelope, OpenedVault } from '../keystore/types';

export interface VaultTransferRuntime {
  keystore: EndpointVaultKeystore;
  /** True when this runtime itself listens for the shared logout/PIN signal. */
  readonly lockSignalBound: boolean;
  listVaults(): Promise<readonly VaultConfig[]>;
  fetchHeaderEnvelope: FetchVaultHeaderEnvelope;
  /** Installs a receiver's verified-open receipt in this endpoint-wide app session. */
  registerOpenedVault(opened: OpenedVault): void;
  isVaultOpen(vaultId: string): boolean;
  /** The shared synchronous revocation seam used by every app lock path. */
  endSession(): void;
}

export interface CreateVaultTransferRuntimeOptions {
  keystore?: EndpointVaultKeystore;
  requestJson?: (path: string) => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
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
  const requestJson = options.requestJson ?? ((path: string) => apiRequest<unknown>(path));
  const requestRaw =
    options.fetch ??
    ((input: URL | RequestInfo, init?: RequestInit) => globalThis.fetch(input, init));
  const base = options.apiBase ?? apiBaseUrl();
  const lockSignalBound =
    options.bindLockSignal !== false && typeof globalThis.addEventListener === 'function';

  if (lockSignalBound) {
    keystore.bindToVaultLockSignal(globalThis);
  }

  // Keystore revocation is authoritative even when a lower-level caller ends
  // it directly (logout/PIN signal, reset, custody replacement).
  keystore.subscribeToSessionEnd(() => openedVaults.clear());

  return {
    keystore,
    lockSignalBound,

    registerOpenedVault(opened) {
      openedVaults.set(opened.vaultId, opened);
    },

    isVaultOpen(vaultId) {
      return openedVaults.has(vaultId);
    },

    endSession() {
      keystore.endSession();
    },

    async listVaults() {
      const response = vaultListResponseSchema.parse(await requestJson('/vaults'));
      return response.vaults;
    },

    async fetchHeaderEnvelope({ vaultId }) {
      const parsedVaultId = vaultIdParamSchema.parse({ vaultId }).vaultId;
      const configResponse = createVaultResponseSchema.parse(
        await requestJson(`/vaults/${encodeURIComponent(parsedVaultId)}`),
      );
      const response = await requestRaw(
        `${base}/vaults/${encodeURIComponent(parsedVaultId)}/docs/${encodeURIComponent(configResponse.vault.headerDocId)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!response.ok) {
        throw new Error(`Vault header request failed with status ${response.status}.`);
      }
      const envelope = new Uint8Array(await response.arrayBuffer());
      if (envelope.length === 0) throw new Error('Vault header response was empty.');
      return envelope;
    },
  };
}

/**
 * Endpoint-wide session for the normal (per-vault) app branch. The legacy
 * vault provider references this same instance by default and routes its direct
 * lock paths through the same runtime seam.
 */
export const vaultTransferRuntime = createVaultTransferRuntime();

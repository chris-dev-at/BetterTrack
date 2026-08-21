import {
  createVaultResponseSchema,
  vaultIdParamSchema,
  vaultListResponseSchema,
  type VaultConfig,
} from '@bettertrack/contracts';

import { apiRequest } from '../../../lib/apiClient';
import { apiBaseUrl } from '../../../lib/runtimeConfig';
import { EndpointVaultKeystore } from '../keystore/core';
import type { FetchVaultHeaderEnvelope } from '../keystore/types';

export interface VaultTransferRuntime {
  keystore: EndpointVaultKeystore;
  listVaults(): Promise<readonly VaultConfig[]>;
  fetchHeaderEnvelope: FetchVaultHeaderEnvelope;
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
  const requestJson = options.requestJson ?? ((path: string) => apiRequest<unknown>(path));
  const requestRaw =
    options.fetch ??
    ((input: URL | RequestInfo, init?: RequestInit) => globalThis.fetch(input, init));
  const base = options.apiBase ?? apiBaseUrl();

  if (options.bindLockSignal !== false && typeof globalThis.addEventListener === 'function') {
    keystore.bindToVaultLockSignal(globalThis);
  }

  return {
    keystore,

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

/** One endpoint-wide session, synchronously revoked by the app's shared lock signal. */
export const vaultTransferRuntime = createVaultTransferRuntime();

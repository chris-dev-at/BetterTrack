import {
  createVaultResponseSchema,
  deleteVaultResponseSchema,
  driveConnectionListResponseSchema,
  patchVaultResponseSchema,
  perVaultMediaStateResponseSchema,
  perVaultMediaTransitionResponseSchema,
  portfolioVaultMoveInResponseSchema,
  portfolioVaultMoveOutChallengeResponseSchema,
  portfolioVaultMoveOutResponseSchema,
  portfolioVaultRevisionResponseSchema,
  vaultListResponseSchema,
  type DeleteVaultRequest,
  type DriveConnection,
  type PatchVaultRequest,
  type PerVaultMediaState,
  type PerVaultMediaTransitionRequest,
  type PortfolioVaultMoveInRequest,
  type PortfolioVaultMoveInResponse,
  type PortfolioVaultMoveOutChallengeRequest,
  type PortfolioVaultMoveOutChallengeResponse,
  type PortfolioVaultMoveOutRequest,
  type PortfolioVaultMoveOutResponse,
  type PortfolioVaultRevisionResponse,
  type VaultConfig,
  type CreateVaultRequest,
} from '@bettertrack/contracts';

import { ApiError, apiRequest } from './apiClient';
import { apiBaseUrl } from './runtimeConfig';

export const VAULTS_QUERY_KEY = ['vaults', 'configs'] as const;
export const DRIVE_CONNECTIONS_QUERY_KEY = ['vaults', 'drive-connections'] as const;

function segment(value: string): string {
  return encodeURIComponent(value);
}

export async function listVaults(signal?: AbortSignal): Promise<VaultConfig[]> {
  const data = await apiRequest<unknown>('/vaults', { signal });
  return vaultListResponseSchema.parse(data).vaults;
}

export async function createVault(body: CreateVaultRequest): Promise<VaultConfig> {
  const data = await apiRequest<unknown>('/vaults', { method: 'POST', body });
  return createVaultResponseSchema.parse(data).vault;
}

export async function renameVault(vaultId: string, body: PatchVaultRequest): Promise<VaultConfig> {
  const data = await apiRequest<unknown>(`/vaults/${segment(vaultId)}`, {
    method: 'PATCH',
    body,
  });
  return patchVaultResponseSchema.parse(data).vault;
}

export async function deleteVault(vaultId: string, body: DeleteVaultRequest): Promise<void> {
  const data = await apiRequest<unknown>(`/vaults/${segment(vaultId)}`, {
    method: 'DELETE',
    body,
  });
  deleteVaultResponseSchema.parse(data);
}

export async function listVaultDriveConnections(signal?: AbortSignal): Promise<DriveConnection[]> {
  const data = await apiRequest<unknown>('/drive-connections', { signal });
  return driveConnectionListResponseSchema.parse(data).connections;
}

export async function getVaultMediaState(
  vaultId: string,
  signal?: AbortSignal,
): Promise<PerVaultMediaState> {
  const data = await apiRequest<unknown>(`/vaults/${segment(vaultId)}/media`, { signal });
  return perVaultMediaStateResponseSchema.parse(data);
}

export async function transitionVaultMedia(
  vaultId: string,
  body: PerVaultMediaTransitionRequest,
): Promise<PerVaultMediaState> {
  const data = await apiRequest<unknown>(`/vaults/${segment(vaultId)}/media`, {
    method: 'PATCH',
    body,
  });
  return perVaultMediaTransitionResponseSchema.parse(data);
}

export async function getPortfolioVaultRevision(
  portfolioId: string,
  signal?: AbortSignal,
): Promise<PortfolioVaultRevisionResponse> {
  const data = await apiRequest<unknown>(`/portfolios/${segment(portfolioId)}/vault/revision`, {
    signal,
  });
  return portfolioVaultRevisionResponseSchema.parse(data);
}

export async function movePortfolioIntoVault(
  portfolioId: string,
  body: PortfolioVaultMoveInRequest,
): Promise<PortfolioVaultMoveInResponse> {
  const data = await apiRequest<unknown>(`/portfolios/${segment(portfolioId)}/vault/move-in`, {
    method: 'POST',
    body,
  });
  return portfolioVaultMoveInResponseSchema.parse(data);
}

export async function requestPortfolioMoveOutChallenge(
  portfolioId: string,
  body: PortfolioVaultMoveOutChallengeRequest,
): Promise<PortfolioVaultMoveOutChallengeResponse> {
  const data = await apiRequest<unknown>(
    `/portfolios/${segment(portfolioId)}/vault/move-out/challenge`,
    { method: 'POST', body },
  );
  return portfolioVaultMoveOutChallengeResponseSchema.parse(data);
}

export async function movePortfolioOutOfVault(
  portfolioId: string,
  body: PortfolioVaultMoveOutRequest,
): Promise<PortfolioVaultMoveOutResponse> {
  const data = await apiRequest<unknown>(`/portfolios/${segment(portfolioId)}/vault/move-out`, {
    method: 'POST',
    body,
  });
  return portfolioVaultMoveOutResponseSchema.parse(data);
}

/** Fetch opaque header bytes for E3's verified-open boundary. */
export async function readVaultHeaderDocument(
  vaultId: string,
  headerDocId: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(
      `${apiBaseUrl()}/vaults/${segment(vaultId)}/docs/${segment(headerDocId)}`,
      { credentials: 'include', signal },
    );
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the vault store.');
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      'VAULT_DOCUMENT_READ_FAILED',
      'Vault document read failed.',
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Initial opaque per-vault document write. The API validates only envelope metadata. */
export async function createVaultDocument(
  vaultId: string,
  docId: string,
  envelope: Uint8Array,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/vaults/${segment(vaultId)}/docs/${segment(docId)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/vnd.bettertrack.vault+octet-stream',
        'If-None-Match': '*',
        'X-Requested-With': 'BetterTrack',
      },
      body: envelope.slice(),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the vault store.');
  }
  if (!response.ok) {
    throw new ApiError(response.status, 'VAULT_DOCUMENT_WRITE_FAILED', 'Vault write failed.');
  }
}

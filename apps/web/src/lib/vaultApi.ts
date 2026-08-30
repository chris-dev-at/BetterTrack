import {
  createVaultResponseSchema,
  deleteVaultResponseSchema,
  driveConnectionListResponseSchema,
  parseVaultEtag,
  patchVaultResponseSchema,
  perVaultMediaStateResponseSchema,
  perVaultMediaTransitionResponseSchema,
  perVaultRetiredServerPurgeChallengeResponseSchema,
  perVaultRetiredServerPurgeResponseSchema,
  portfolioVaultLifecycleResponseSchema,
  portfolioVaultMoveInResponseSchema,
  portfolioVaultMoveOutChallengeResponseSchema,
  portfolioVaultMoveOutResponseSchema,
  portfolioVaultRevisionResponseSchema,
  vaultEtag,
  vaultListResponseSchema,
  type DeleteVaultRequest,
  type DriveConnection,
  type PatchVaultRequest,
  type PerVaultMediaState,
  type PerVaultMediaTransitionRequest,
  type PerVaultRetiredServerPurgeChallengeRequest,
  type PerVaultRetiredServerPurgeChallengeResponse,
  type PerVaultRetiredServerPurgeRequest,
  type PerVaultRetiredServerPurgeResponse,
  type PortfolioVaultLifecycleResponse,
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

/**
 * §16 (2026-07-28) retired-bytes destruction, per vault (#1520). Retiring the
 * server medium leaves the ciphertext RETAINED, never purged: destroying it is
 * a separate, deliberate action the user takes, and it is authenticated by a
 * fresh client readback of the surviving medium — the server has no Drive
 * capability and can never confirm the copy is live on its own (§8/§22).
 *
 * Step one of two: exchange the retirement identity the client just read from
 * `GET /vaults/:id/media` for a short-lived server nonce. A stale generation or
 * versionSetHash is a 409 here rather than a signature that would fail later.
 */
export async function requestVaultRetiredPurgeChallenge(
  vaultId: string,
  body: PerVaultRetiredServerPurgeChallengeRequest,
): Promise<PerVaultRetiredServerPurgeChallengeResponse> {
  const data = await apiRequest<unknown>(
    `/vaults/${segment(vaultId)}/media/retired/purge/challenge`,
    { method: 'POST', body },
  );
  return perVaultRetiredServerPurgeChallengeResponseSchema.parse(data);
}

/**
 * Step two: the nonce, the freshly observed full doc roster on the surviving
 * medium, and the Ed25519 signature over that transcript. Only this call ever
 * destroys retired bytes; nothing on the server purges them on a timer.
 */
export async function purgeVaultRetiredServer(
  vaultId: string,
  body: PerVaultRetiredServerPurgeRequest,
): Promise<PerVaultRetiredServerPurgeResponse> {
  const data = await apiRequest<unknown>(`/vaults/${segment(vaultId)}/media/retired/purge`, {
    method: 'POST',
    body,
  });
  return perVaultRetiredServerPurgeResponseSchema.parse(data);
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

/**
 * §10 exit metadata (E6 residual, #1525): the server-minted lifecycle
 * generation the move-out challenge and commit proofs bind to. Any owning
 * session may read it — the device performing the exit is rarely the device
 * that saw the move-in response.
 */
export async function getPortfolioVaultLifecycle(
  portfolioId: string,
  signal?: AbortSignal,
): Promise<PortfolioVaultLifecycleResponse> {
  const data = await apiRequest<unknown>(`/portfolios/${segment(portfolioId)}/vault/lifecycle`, {
    signal,
  });
  return portfolioVaultLifecycleResponseSchema.parse(data);
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
  await writeVaultDocument(vaultId, docId, envelope, { ifVersion: null });
}

/**
 * One opaque per-vault document write under the E1 HTTP CAS: `If-None-Match: *`
 * for the first version, `If-Match: <etag>` for every replacement. A 412 means
 * the store moved underneath the caller — surfaced as its own code so the E6
 * capture can refuse cleanly instead of retry-clobbering a concurrent writer.
 */
export async function writeVaultDocument(
  vaultId: string,
  docId: string,
  envelope: Uint8Array,
  options: { ifVersion: number | null },
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/vaults/${segment(vaultId)}/docs/${segment(docId)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/vnd.bettertrack.vault+octet-stream',
        ...(options.ifVersion === null
          ? { 'If-None-Match': '*' }
          : { 'If-Match': vaultEtag(options.ifVersion) }),
        'X-Requested-With': 'BetterTrack',
      },
      body: envelope.slice(),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the vault store.');
  }
  if (response.status === 412) {
    throw new ApiError(
      412,
      'VAULT_DOCUMENT_CAS_CONFLICT',
      'The vault document changed underneath this write.',
      { currentVersion: parseVaultEtag(response.headers.get('ETag')) },
    );
  }
  if (!response.ok) {
    throw new ApiError(response.status, 'VAULT_DOCUMENT_WRITE_FAILED', 'Vault write failed.');
  }
}

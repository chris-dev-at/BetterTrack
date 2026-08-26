import {
  apiErrorSchema,
  inspectVaultDocEnvelope,
  parseVaultEtag,
  vaultDocParamsSchema,
  vaultListResponseSchema,
  type VaultDocEnvelopeHeader,
  type VaultListResponse,
} from '@bettertrack/contracts';

import { ApiError, apiRequest } from './apiClient';
import { apiBaseUrl } from './runtimeConfig';

export type VaultsApiErrorKind =
  | 'http'
  | 'network'
  | 'invalid-request'
  | 'invalid-response'
  | 'malformed-envelope'
  | 'update-required'
  | 'address-mismatch'
  | 'invalid-etag'
  | 'version-mismatch';

/**
 * Typed failure for the per-vault read boundary. `kind` separates transport,
 * API, contract and envelope-integrity failures without asking callers to
 * parse error copy; `status`/`code` retain the regular {@link ApiError} seam.
 */
export class VaultsApiError extends ApiError {
  constructor(
    public readonly kind: VaultsApiErrorKind,
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(status, code, message, details);
    this.name = 'VaultsApiError';
  }
}

/** The exact raw bytes and supported address header passed to the decryptor. */
export interface VaultDocEnvelopeRead {
  envelope: Uint8Array;
  header: VaultDocEnvelopeHeader;
}

/** Structural reader seam consumed by the per-portfolio document-set engine. */
export interface VaultDocEnvelopeReader {
  read(vaultId: string, docId: string, signal?: AbortSignal): Promise<VaultDocEnvelopeRead>;
}

/** Read and contract-validate the caller's cleartext vault configuration list. */
export async function listVaults(signal?: AbortSignal): Promise<VaultListResponse> {
  try {
    const payload = await apiRequest<unknown>('/vaults', { signal });
    const parsed = vaultListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new VaultsApiError(
        'invalid-response',
        200,
        'VAULT_LIST_RESPONSE_INVALID',
        'The server returned an invalid vault list.',
        parsed.error.flatten(),
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof VaultsApiError || isAbortError(error)) throw error;
    if (error instanceof ApiError) {
      throw new VaultsApiError(
        error.status === 0 ? 'network' : 'http',
        error.status,
        error.code,
        error.message,
        error.details,
      );
    }
    throw new VaultsApiError(
      'invalid-response',
      0,
      'VAULT_LIST_RESPONSE_INVALID',
      'The server returned an invalid vault list.',
    );
  }
}

/**
 * Read one opaque document and bind the server CAS token to the envelope's
 * address and version before any ciphertext is offered to the decryptor.
 */
export async function readVaultDoc(
  vaultId: string,
  docId: string,
  signal?: AbortSignal,
): Promise<VaultDocEnvelopeRead> {
  const params = vaultDocParamsSchema.safeParse({ vaultId, docId });
  if (!params.success) {
    throw new VaultsApiError(
      'invalid-request',
      0,
      'VAULT_DOC_ADDRESS_INVALID',
      'The requested vault document address is invalid.',
      params.error.flatten(),
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `${apiBaseUrl()}/vaults/${encodeURIComponent(vaultId)}/docs/${encodeURIComponent(docId)}`,
      { method: 'GET', credentials: 'include', signal },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new VaultsApiError(
      'network',
      0,
      'NETWORK_ERROR',
      'Unable to reach the server. Check your connection.',
    );
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = apiErrorSchema.safeParse(payload);
    throw parsed.success
      ? new VaultsApiError(
          'http',
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
        )
      : new VaultsApiError('http', response.status, 'UNKNOWN', 'Request failed.');
  }

  let envelope: Uint8Array;
  try {
    envelope = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new VaultsApiError(
      'malformed-envelope',
      response.status,
      'VAULT_DOC_ENVELOPE_MALFORMED',
      'The server returned unreadable vault document bytes.',
    );
  }

  let inspected: ReturnType<typeof inspectVaultDocEnvelope>;
  try {
    inspected = inspectVaultDocEnvelope(envelope);
  } catch {
    throw new VaultsApiError(
      'malformed-envelope',
      response.status,
      'VAULT_DOC_ENVELOPE_MALFORMED',
      'The server returned a malformed vault document envelope.',
    );
  }

  if (inspected.status === 'update-required') {
    throw new VaultsApiError(
      'update-required',
      response.status,
      'VAULT_DOC_UPDATE_REQUIRED',
      'This vault document was written by a newer app version.',
      {
        formatVersion: inspected.formatVersion,
        schemaVersion: inspected.schemaVersion,
      },
    );
  }

  if (inspected.header.vaultId !== vaultId || inspected.header.docId !== docId) {
    throw new VaultsApiError(
      'address-mismatch',
      response.status,
      'VAULT_DOC_ADDRESS_MISMATCH',
      'The vault document envelope does not match the requested address.',
    );
  }

  const responseVersion = parseVaultEtag(response.headers.get('ETag'));
  if (responseVersion === null) {
    throw new VaultsApiError(
      'invalid-etag',
      response.status,
      'VAULT_DOC_ETAG_INVALID',
      'The server returned vault document bytes without a valid ETag.',
    );
  }
  if (responseVersion !== inspected.header.docVersion) {
    throw new VaultsApiError(
      'version-mismatch',
      response.status,
      'VAULT_DOC_VERSION_MISMATCH',
      'The server ETag does not match the vault document envelope version.',
      { etagVersion: responseVersion, envelopeVersion: inspected.header.docVersion },
    );
  }

  return { envelope, header: inspected.header };
}

/** Ready-made structural adapter for document-set loaders. */
export const apiVaultDocEnvelopeReader: VaultDocEnvelopeReader = { read: readVaultDoc };

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

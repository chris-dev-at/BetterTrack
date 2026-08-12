import {
  parseVaultEtag,
  VAULT_CONTENT_TYPE,
  VAULT_DOC_MAX_BYTES,
  VAULT2_ERROR_CODES,
  vaultEtag,
  vaultHeaderDocSchema,
  vaultCreateResponseSchema,
  vaultJoinResponseSchema,
  vaultLeaveResponseSchema,
  vaultListResponseSchema,
  vaultSchema,
  vaultVersionConflictResponseSchema,
  type Vault,
  type VaultBackends,
  type VaultCreateResponse,
  type VaultHeaderDoc,
  type VaultJoinResponse,
  type VaultLeaveResponse,
  type VaultPortfolioRestoreDocument,
} from '@bettertrack/contracts';

import { ApiError, apiRequest } from '../../../lib/apiClient';
import { apiBaseUrl } from '../../../lib/runtimeConfig';
import { bytesToBase64 } from '../bytes';

/**
 * Client adapter for the Vaults v2 server surface
 * (`docs/VAULTS_V2_DESIGN.md` §3).
 *
 * The server PR (P2) is being built in parallel, so every path this file talks
 * to is collected in {@link VAULT2_ROUTES}. If the shipped server names a route
 * differently, reconciliation is an edit to that one object and nothing else —
 * no call site hardcodes a path.
 *
 * Two families, exactly as §3 splits them:
 *  - **session routes** (vault CRUD, backend config, join, leave) go through
 *    `apiRequest`, which carries the session cookie and the CSRF header;
 *  - **doc routes** (header/blob GET+PUT under `If-Match` CAS) move opaque
 *    bytes, so they use raw `fetch` with `credentials: 'include'` — the same
 *    escape hatch the v1 `/vault` blob endpoint already uses.
 */

/**
 * Every §3 path in one place. These are the shapes the server PR (#1176)
 * shipped — its census, OpenAPI document and bearer allowlist are wired to
 * them — so they are authoritative for both clients.
 */
export const VAULT2_ROUTES = {
  vaults: '/vaults',
  vault: (vaultId: string) => `/vaults/${encodeURIComponent(vaultId)}`,
  headerDoc: (vaultId: string) => `/vaults/${encodeURIComponent(vaultId)}/header`,
  portfolioDoc: (vaultId: string, portfolioId: string) =>
    `/vaults/${encodeURIComponent(vaultId)}/portfolios/${encodeURIComponent(portfolioId)}`,
  commonDoc: (vaultId: string) => `/vaults/${encodeURIComponent(vaultId)}/common`,
  join: (portfolioId: string) => `/portfolios/${encodeURIComponent(portfolioId)}/vault`,
  leave: (portfolioId: string) => `/portfolios/${encodeURIComponent(portfolioId)}/vault`,
  /**
   * The cleartext display alias a locked row renders (§2 portfolio index). The
   * server owns it so the label survives independently of the header doc.
   */
  alias: (portfolioId: string) => `/portfolios/${encodeURIComponent(portfolioId)}/alias`,
  /**
   * §4 requires the QR share to be re-auth-gated, and the repo had no generic
   * step-up verifier — every existing re-auth rode on the destructive endpoint
   * it protected. This route was agreed with the server PR: session-only,
   * `{ password }`, login-class rate limit, 204, audited. It FAILS CLOSED —
   * if it is ever missing, the QR is refused rather than shown ungated.
   */
  reauth: '/auth/reauth',
} as const;

export const VAULT2_QUERY_KEY = ['vaults', 'v2'] as const;

// ── Session routes ───────────────────────────────────────────────────────────

export async function listVaults(signal?: AbortSignal): Promise<Vault[]> {
  const data = await apiRequest<unknown>(VAULT2_ROUTES.vaults, { signal });
  return vaultListResponseSchema.parse(data).vaults;
}

export interface CreateVaultInput {
  id: string;
  name: string;
  backends: VaultBackends;
  /** The client-built header doc; the server stores it blindly. */
  header: VaultHeaderDoc;
}

/**
 * Create a vault. The client mints the id so the header it just built (which
 * binds `vaultId` under its seal) is the exact bytes the server stores.
 *
 * If a server nonetheless assigns its own id, the caller is told via the
 * returned summary and must re-seal — {@link createVault} does not silently
 * accept a header/vault id mismatch, because a header sealed for another id
 * would fail every later open.
 */
export async function createVault(input: CreateVaultInput): Promise<VaultCreateResponse> {
  return vaultCreateResponseSchema.parse(
    await apiRequest<unknown>(VAULT2_ROUTES.vaults, {
      method: 'POST',
      body: {
        id: input.id,
        name: input.name,
        backends: input.backends,
        // A drive-only vault keeps NO ciphertext server-side, so it must not
        // send a header — the create schema refuses one.
        ...(input.backends === 'drive'
          ? {}
          : { header: bytesToBase64(encodeHeaderDoc(input.header)) }),
      },
    }),
  );
}

/**
 * Set a vaulted portfolio's cleartext display alias. Kept server-side rather
 * than only in the header index so a locked row still has a label when the
 * header doc has not been fetched.
 */
export async function setPortfolioAlias(portfolioId: string, alias: string): Promise<void> {
  await apiRequest<unknown>(VAULT2_ROUTES.alias(portfolioId), {
    method: 'PATCH',
    body: { alias },
  });
}

export async function updateVaultBackends(
  vaultId: string,
  backends: VaultBackends,
): Promise<Vault> {
  const data = await apiRequest<unknown>(VAULT2_ROUTES.vault(vaultId), {
    method: 'PATCH',
    body: { backends },
  });
  return vaultSchema.parse(data);
}

export async function renameVault(vaultId: string, name: string): Promise<Vault> {
  const data = await apiRequest<unknown>(VAULT2_ROUTES.vault(vaultId), {
    method: 'PATCH',
    body: { name },
  });
  return vaultSchema.parse(data);
}

export async function deleteVault(vaultId: string): Promise<void> {
  await apiRequest<unknown>(VAULT2_ROUTES.vault(vaultId), { method: 'DELETE' });
}

// ── Join / leave ─────────────────────────────────────────────────────────────

/**
 * `POST /portfolios/{id}/vault` — one server transaction: store the blob, purge
 * that portfolio's cleartext rows, set `vaultId` (§3).
 *
 * Irreversible in the sense that matters to the UI: after it returns, the
 * server no longer holds the cleartext, so the caller must have verified it can
 * decrypt its own blob BEFORE calling. `joinPortfolioToVault` therefore takes
 * finished ciphertext, never a document.
 */
export async function joinPortfolioToVault(input: {
  portfolioId: string;
  vaultId: string;
  blob: Uint8Array;
}): Promise<VaultJoinResponse> {
  const data = await apiRequest<unknown>(VAULT2_ROUTES.join(input.portfolioId), {
    method: 'POST',
    body: { vaultId: input.vaultId, blob: bytesToBase64(input.blob) },
  });
  return vaultJoinResponseSchema.parse(data);
}

/**
 * `DELETE /portfolios/{id}/vault` — the reverse: the client posts the decrypted
 * rows back, the server repopulates, clears `vaultId` and retires the blob.
 */
export async function leavePortfolioVault(input: {
  portfolioId: string;
  /**
   * The client-minted idempotency key. It must SURVIVE a retry: the server
   * records it in `vault_leave_receipts` and replays the original receipt
   * rather than re-inserting rows, so a caller that mints a fresh id on retry
   * would restore the portfolio twice.
   */
  restoreId: string;
  document: VaultPortfolioRestoreDocument;
}): Promise<VaultLeaveResponse> {
  const data = await apiRequest<unknown>(VAULT2_ROUTES.leave(input.portfolioId), {
    method: 'DELETE',
    body: { restoreId: input.restoreId, document: input.document },
  });
  return vaultLeaveResponseSchema.parse(data);
}

// ── Doc transport (opaque bytes + CAS) ───────────────────────────────────────

export type VaultDocReadResult =
  | { status: 'ok'; bytes: Uint8Array; version: number }
  | { status: 'absent' };

export type VaultDocWriteResult =
  | { status: 'ok'; version: number }
  | { status: 'conflict'; currentVersion: number | null };

const CSRF_HEADER = 'X-Requested-With';
const CSRF_VALUE = 'BetterTrack';

export interface VaultDocTransportOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** r2 §8 per-doc-kind ciphertext cap, checked before the request is sent. */
  sizeCap?: number;
}

/**
 * Read the current version out of a 412. r2 §15 puts it in the body; the ETag
 * is accepted as a fallback so a server that only sets the header still works.
 */
async function conflictVersion(response: Response): Promise<number | null> {
  const fromEtag = parseVaultEtag(response.headers.get('ETag'));
  if (fromEtag !== null) return fromEtag;
  try {
    const body: unknown = await response.clone().json();
    const parsed = vaultVersionConflictResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.currentVersion : null;
  } catch {
    return null;
  }
}

function docUrl(path: string, options: VaultDocTransportOptions): string {
  return `${options.baseUrl ?? apiBaseUrl()}${path}`;
}

/** `GET` one vault doc. A 404 is `absent`, never an error — a new vault has none. */
export async function readVaultDoc(
  path: string,
  options: VaultDocTransportOptions = {},
): Promise<VaultDocReadResult> {
  const request = options.fetch ?? globalThis.fetch;
  const response = await request(docUrl(path, options), { credentials: 'include' });
  if (response.status === 404) return { status: 'absent' };
  if (!response.ok) {
    throw new ApiError(response.status, 'VAULT_DOC_READ_FAILED', 'Could not read the vault doc.');
  }
  const version = parseVaultEtag(response.headers.get('ETag'));
  if (version === null) {
    throw new ApiError(
      response.status,
      'VAULT_DOC_MISSING_ETAG',
      'The server returned vault bytes without a version.',
    );
  }
  return { status: 'ok', bytes: new Uint8Array(await response.arrayBuffer()), version };
}

/**
 * `PUT` one vault doc under mandatory compare-and-swap: `If-None-Match: *` to
 * create, `If-Match: "<version>"` to replace. A lost race returns `conflict`
 * with the current version rather than throwing, because the caller's response
 * is always "re-read, re-apply, retry" — never "overwrite".
 */
export async function writeVaultDoc(
  path: string,
  bytes: Uint8Array,
  ifVersion: number | null,
  options: VaultDocTransportOptions = {},
): Promise<VaultDocWriteResult> {
  const request = options.fetch ?? globalThis.fetch;
  // r2 §8 caps: fail here rather than spending a round trip and a rejection on
  // bytes we already know the server will refuse.
  const cap = options.sizeCap;
  if (cap != null && bytes.byteLength > cap) {
    throw new ApiError(
      413,
      VAULT2_ERROR_CODES.docTooLarge,
      'This vault document is larger than its size cap.',
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': VAULT_CONTENT_TYPE,
    [CSRF_HEADER]: CSRF_VALUE,
  };
  if (ifVersion === null) headers['If-None-Match'] = '*';
  else headers['If-Match'] = vaultEtag(ifVersion);

  const response = await request(docUrl(path, options), {
    method: 'PUT',
    headers,
    credentials: 'include',
    body: bytes.slice(),
  });

  if (response.status === 412 || response.status === 409) {
    // r2 §15: every CAS surface returns the current version. Prefer the body,
    // fall back to the ETag, so this works against either shape.
    return { status: 'conflict', currentVersion: await conflictVersion(response) };
  }
  if (!response.ok) {
    throw new ApiError(response.status, 'VAULT_DOC_WRITE_FAILED', 'Could not write the vault doc.');
  }
  const version = parseVaultEtag(response.headers.get('ETag'));
  if (version === null) {
    throw new ApiError(
      response.status,
      'VAULT_DOC_MISSING_ETAG',
      'The server acknowledged a vault write without a version.',
    );
  }
  return { status: 'ok', version };
}

// ── Header doc codec ─────────────────────────────────────────────────────────

/**
 * The header doc rides the same opaque-bytes transport as the content blobs.
 * It is UTF-8 JSON rather than ciphertext by necessity — `kdfSalt` and the
 * wrapped key slots must be readable before any key exists — and it is
 * integrity-protected by its own r3 §21 `mac`, not by the transport.
 */
export function encodeHeaderDoc(header: VaultHeaderDoc): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(vaultHeaderDocSchema.parse(header)));
}

export function decodeHeaderDoc(bytes: Uint8Array): VaultHeaderDoc {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return vaultHeaderDocSchema.parse(JSON.parse(text));
}

export async function readVaultHeaderDoc(
  vaultId: string,
  options: VaultDocTransportOptions = {},
): Promise<{ header: VaultHeaderDoc; version: number } | null> {
  const result = await readVaultDoc(VAULT2_ROUTES.headerDoc(vaultId), options);
  if (result.status === 'absent') return null;
  return { header: decodeHeaderDoc(result.bytes), version: result.version };
}

export function writeVaultHeaderDoc(
  vaultId: string,
  header: VaultHeaderDoc,
  ifVersion: number | null,
  options: VaultDocTransportOptions = {},
): Promise<VaultDocWriteResult> {
  return writeVaultDoc(VAULT2_ROUTES.headerDoc(vaultId), encodeHeaderDoc(header), ifVersion, {
    sizeCap: VAULT_DOC_MAX_BYTES.header,
    ...options,
  });
}

/** Write one portfolio blob under its r2 §8 cap. */
export function writeVaultPortfolioDoc(
  vaultId: string,
  portfolioId: string,
  bytes: Uint8Array,
  ifVersion: number | null,
  options: VaultDocTransportOptions = {},
): Promise<VaultDocWriteResult> {
  return writeVaultDoc(VAULT2_ROUTES.portfolioDoc(vaultId, portfolioId), bytes, ifVersion, {
    sizeCap: VAULT_DOC_MAX_BYTES.portfolio,
    ...options,
  });
}

/** Write the vault's `common` blob under its r2 §8 cap. */
export function writeVaultCommonDoc(
  vaultId: string,
  bytes: Uint8Array,
  ifVersion: number | null,
  options: VaultDocTransportOptions = {},
): Promise<VaultDocWriteResult> {
  return writeVaultDoc(VAULT2_ROUTES.commonDoc(vaultId), bytes, ifVersion, {
    sizeCap: VAULT_DOC_MAX_BYTES.common,
    ...options,
  });
}

// ── Re-authentication ────────────────────────────────────────────────────────

export type ReauthResult =
  | { status: 'ok' }
  | { status: 'invalid' }
  | { status: 'rate-limited'; retryAfterSeconds: number | null }
  | { status: 'unavailable' };

/**
 * Verify the account password before revealing a vault passphrase (§4 "QR
 * share (re-auth-gated)").
 *
 * `unavailable` is returned when the server has no such route. Callers MUST
 * treat it as a refusal: an unimplemented verifier is not permission to skip
 * the gate.
 */
export async function reauthenticate(password: string): Promise<ReauthResult> {
  try {
    await apiRequest<unknown>(VAULT2_ROUTES.reauth, {
      method: 'POST',
      body: { password },
      suppressAuthRedirect: true,
    });
    return { status: 'ok' };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401 || error.status === 403) return { status: 'invalid' };
    if (error.status === 429) {
      return { status: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds ?? null };
    }
    if (error.status === 404 || error.status === 501) return { status: 'unavailable' };
    throw error;
  }
}

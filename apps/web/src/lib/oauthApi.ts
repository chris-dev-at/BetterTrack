import {
  createOAuthClientResponseSchema,
  oauthApproveResponseSchema,
  oauthAuthorizationDetailsResponseSchema,
  oauthClientListResponseSchema,
  oauthGrantListResponseSchema,
  type CreateOAuthClientRequest,
  type CreateOAuthClientResponse,
  type OAuthApproveResponse,
  type OAuthAuthorizationDetailsResponse,
  type OAuthClientListResponse,
  type OAuthGrantListResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the OAuth "API access as a product" surface (PROJECTPLAN.md
 * §6.13 part 2). Mirrors `apiKeysApi.ts`: every response is validated with its
 * zod schema. Two audiences share this file — the Settings → API Access page
 * (developer: register apps, manage authorized apps) and the standalone consent
 * screen (end user: authorize a third-party app). A confidential client's
 * `clientSecret` rides the `POST` response exactly once and is never re-fetched.
 */

/**
 * The standard OAuth authorize request as it arrives on the consent screen URL.
 * Carried verbatim from `GET`-details through `POST`-authorize so PKCE (`state`,
 * `code_challenge`) survives a login round-trip untouched.
 */
export interface OAuthAuthorizeParams {
  response_type?: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

// ── OAuth apps (registered clients) ─────────────────────────────────────────
/** `GET /settings/oauth-clients` — the developer's registered apps. */
export async function listOAuthClients(signal?: AbortSignal): Promise<OAuthClientListResponse> {
  const data = await apiRequest<unknown>('/settings/oauth-clients', { signal });
  return oauthClientListResponseSchema.parse(data);
}

/** `POST /settings/oauth-clients` — register an app; the response carries the one-time secret. */
export async function createOAuthClient(
  input: CreateOAuthClientRequest,
): Promise<CreateOAuthClientResponse> {
  const data = await apiRequest<unknown>('/settings/oauth-clients', {
    method: 'POST',
    body: input,
  });
  return createOAuthClientResponseSchema.parse(data);
}

/** `DELETE /settings/oauth-clients/:id` — delete an app (cascades its grants). */
export async function deleteOAuthClient(id: string): Promise<void> {
  await apiRequest<void>(`/settings/oauth-clients/${id}`, { method: 'DELETE' });
}

// ── Authorized apps (grants) ────────────────────────────────────────────────
/** `GET /settings/oauth-grants` — apps the user has authorized. */
export async function listOAuthGrants(signal?: AbortSignal): Promise<OAuthGrantListResponse> {
  const data = await apiRequest<unknown>('/settings/oauth-grants', { signal });
  return oauthGrantListResponseSchema.parse(data);
}

/** `DELETE /settings/oauth-grants/:id` — revoke an authorized app (kills its tokens). */
export async function revokeOAuthGrant(id: string): Promise<void> {
  await apiRequest<void>(`/settings/oauth-grants/${id}`, { method: 'DELETE' });
}

// ── Consent (authorize) ─────────────────────────────────────────────────────
/**
 * `GET /oauth/authorization-details` — read the pending authorize request so the
 * consent screen can render "App X wants to …". Session-required; a 400 here
 * (unknown client / bad redirect_uri) must be shown as an error, never redirected.
 */
export async function getAuthorizationDetails(
  params: OAuthAuthorizeParams,
  signal?: AbortSignal,
): Promise<OAuthAuthorizationDetailsResponse> {
  const data = await apiRequest<unknown>('/oauth/authorization-details', {
    query: { ...params },
    signal,
  });
  return oauthAuthorizationDetailsResponseSchema.parse(data);
}

/**
 * `POST /oauth/authorize` — the user approved. The service mints a single-use
 * code and returns where to send the browser (the registered redirect URI,
 * custom scheme included).
 */
export async function approveAuthorization(
  params: OAuthAuthorizeParams,
): Promise<OAuthApproveResponse> {
  const data = await apiRequest<unknown>('/oauth/authorize', { method: 'POST', body: params });
  return oauthApproveResponseSchema.parse(data);
}

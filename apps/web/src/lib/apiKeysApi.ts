import {
  apiKeyListResponseSchema,
  createApiKeyResponseSchema,
  type ApiKeyListResponse,
  type ApiKeyScope,
  type CreateApiKeyResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for personal API keys (PROJECTPLAN.md §6.13, V2-P12) — the
 * Settings → API Access surface. Mirrors `settingsApi.ts`. The plaintext token
 * is only ever present in the `POST` response and is shown to the user once.
 */

/** `GET /settings/api-keys` — the caller's active keys. */
export async function listApiKeys(signal?: AbortSignal): Promise<ApiKeyListResponse> {
  const data = await apiRequest<unknown>('/settings/api-keys', { signal });
  return apiKeyListResponseSchema.parse(data);
}

/** `POST /settings/api-keys` — mint a key; the response carries the one-time token. */
export async function createApiKey(input: {
  name: string;
  scopes: ApiKeyScope[];
}): Promise<CreateApiKeyResponse> {
  const data = await apiRequest<unknown>('/settings/api-keys', { method: 'POST', body: input });
  return createApiKeyResponseSchema.parse(data);
}

/** `DELETE /settings/api-keys/:id` — revoke a key. */
export async function revokeApiKey(id: string): Promise<void> {
  await apiRequest<void>(`/settings/api-keys/${id}`, { method: 'DELETE' });
}

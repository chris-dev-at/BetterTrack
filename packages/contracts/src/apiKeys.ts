import { z } from 'zod';

/**
 * Personal API keys (PROJECTPLAN.md §6.13, §14, V2-P12) — the "API access as a
 * product" surface. A user mints an opaque bearer token scoped to coarse
 * per-module read/write permissions; the token is shown exactly once at
 * creation and only its hash is stored. Keys are revoke-only (no expiry, §5.5).
 *
 * Scopes are deliberately coarse: one read/write pair per user-facing module,
 * plus read-only market/social. The bearer middleware maps each request to a
 * required scope; **admin endpoints are never reachable with an API key**
 * regardless of scopes, because account-kind separation holds independently.
 */

/** The bearer token prefix — recognizable and greppable in logs/leak scans. */
export const API_KEY_TOKEN_PREFIX = 'btk_';

/** The grantable scopes (coarse per-module read/write over the user API). */
export const API_KEY_SCOPES = [
  'portfolio:read',
  'portfolio:write',
  'workboard:read',
  'workboard:write',
  'market:read',
  'social:read',
] as const;

export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** `POST /settings/api-keys` — name + at least one scope. */
export const createApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(apiKeyScopeSchema).min(1).max(API_KEY_SCOPES.length),
  })
  .strict();
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

/** A key as listed in Settings → API Access (never carries the token). */
export const apiKeySummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    scopes: z.array(apiKeyScopeSchema),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();
export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;

export const apiKeyListResponseSchema = z.object({ keys: z.array(apiKeySummarySchema) }).strict();
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;

/**
 * `POST /settings/api-keys` response — the freshly-minted key plus its plaintext
 * `token`, returned **exactly once**. Re-fetching the key never includes it.
 */
export const createApiKeyResponseSchema = z
  .object({ key: apiKeySummarySchema, token: z.string() })
  .strict();
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;

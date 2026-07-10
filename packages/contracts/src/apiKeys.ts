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

/**
 * The grantable scopes (coarse per-module read/write over the user API).
 *
 * Strictly additive over time: new scopes are appended, never reordered or
 * removed, so a token minted before a scope existed keeps exactly the grants it
 * was issued with (#361). The `social:write`, `notifications:*`, `chat:*` and
 * `account:security` scopes were added for the unified web+mobile platform
 * surface (#361); `chat:*` gates the friend-chat module (V3-P8) under `/chat/*`
 * (#396 — the module-policy row was missed when chat shipped, leaving these
 * scopes granted but unusable by bearers).
 */
export const API_KEY_SCOPES = [
  'portfolio:read',
  'portfolio:write',
  'workboard:read',
  'workboard:write',
  'market:read',
  'social:read',
  // #361 additions — unified web+mobile platform surface. Appended so existing
  // tokens/grants are unaffected.
  'social:write',
  'notifications:read',
  'notifications:write',
  'chat:read',
  'chat:write',
  'account:security',
] as const;

export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Write-implies-read (#371, owner refinement 2026-07-09). A `<module>:write`
 * scope always confers its `<module>:read` — granting or holding the write can
 * never leave the read unreachable. The map is derived from the taxonomy itself:
 * each `:write` pairs with the `:read` of the same module when that read exists
 * in {@link API_KEY_SCOPES}. `account:security` is a single combined scope (no
 * read/write split) and therefore has no implied partner.
 */
export const IMPLIED_READ_SCOPE: Readonly<Partial<Record<ApiKeyScope, ApiKeyScope>>> =
  Object.freeze(
    Object.fromEntries(
      API_KEY_SCOPES.filter((s) => s.endsWith(':write'))
        .map((write) => [write, write.replace(/:write$/, ':read')] as const)
        .filter(([, read]) => (API_KEY_SCOPES as readonly string[]).includes(read)),
    ) as Partial<Record<ApiKeyScope, ApiKeyScope>>,
  );

/** The `:read` scope implied by holding `scope` (a `:write`), or `undefined`. */
export function impliedReadScope(scope: ApiKeyScope): ApiKeyScope | undefined {
  return IMPLIED_READ_SCOPE[scope];
}

/** The `:write` scope whose grant would imply `scope` (a `:read`), or `undefined`. */
export function writeScopeForRead(scope: ApiKeyScope): ApiKeyScope | undefined {
  for (const [write, read] of Object.entries(IMPLIED_READ_SCOPE)) {
    if (read === scope) return write as ApiKeyScope;
  }
  return undefined;
}

/**
 * Expand a granted/held scope set with every implied read, deduped and returned
 * in canonical {@link API_KEY_SCOPES} order. Grant-time normalization so a stored
 * or displayed set never carries a `:write` without its `:read`.
 */
export function withImpliedReadScopes(scopes: readonly ApiKeyScope[]): ApiKeyScope[] {
  const set = new Set<ApiKeyScope>(scopes);
  for (const scope of scopes) {
    const read = IMPLIED_READ_SCOPE[scope];
    if (read) set.add(read);
  }
  return API_KEY_SCOPES.filter((s) => set.has(s));
}

/**
 * Check-time rule for write-implies-read (#371): does a held scope set satisfy a
 * required scope? True when the set holds the scope directly, or holds the
 * `:write` that implies a required `:read`. This is the authoritative
 * enforcement point — it covers even tokens minted before the rule existed, so
 * no data migration is needed. Operates on raw scope strings because the bearer
 * middleware gates some read-only modules with a sentinel `:write` no key holds.
 */
export function scopeSatisfies(held: readonly string[], required: string): boolean {
  if (held.includes(required)) return true;
  if (required.endsWith(':read')) {
    return held.includes(required.replace(/:read$/, ':write'));
  }
  return false;
}

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

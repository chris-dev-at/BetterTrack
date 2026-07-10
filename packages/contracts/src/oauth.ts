import { z } from 'zod';

import { API_KEY_SCOPES, apiKeyScopeSchema, type ApiKeyScope } from './apiKeys';

/**
 * OAuth 2.0 provider — "API access as a product" part 2 (PROJECTPLAN.md §6.13,
 * §14, V2-P12). A pragmatic authorization-code + PKCE slice built on the #302
 * personal-API-key infrastructure: the SAME coarse scope taxonomy
 * ({@link API_KEY_SCOPES}), the SAME bearer middleware, the SAME per-token
 * rate-limit + audit patterns. Third-party apps get delegated, scoped, revocable
 * access without ever seeing the user's credentials or a personal key.
 *
 * Out of scope for this slice (per the issue): client-credentials / implicit
 * grants, ID tokens / OIDC, outbound webhooks, an app marketplace.
 */

// ── Token prefixes ──────────────────────────────────────────────────────────
// Recognizable + greppable in logs/leak scans; each namespace disjoint from the
// personal-key `btk_` prefix so the bearer middleware can route by prefix.
/** OAuth client identifier (public, non-secret). */
export const OAUTH_CLIENT_ID_PREFIX = 'btc_';
/** OAuth client secret (confidential clients only; shown once, hash stored). */
export const OAUTH_CLIENT_SECRET_PREFIX = 'bts_';
/** OAuth access token (bearer; rides the #302 scope enforcement rail). */
export const OAUTH_ACCESS_TOKEN_PREFIX = 'bto_';
/** OAuth refresh token (rotating, revocable). */
export const OAUTH_REFRESH_TOKEN_PREFIX = 'btr_';

/** Access-token lifetime (seconds) — short-lived; refresh to renew. */
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;
/** Refresh-token lifetime (seconds) — 30 days, rotated on every use. */
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
/** Authorization-code lifetime (seconds) — very short, single-use. */
export const OAUTH_AUTH_CODE_TTL_SECONDS = 60;

/**
 * Human-readable scope descriptions rendered on the consent screen in plain
 * language (the issue's "listing the requested scopes in plain language").
 * Keyed by the shared #302 scope taxonomy.
 */
export const OAUTH_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'portfolio:read': 'View your portfolios, holdings, transactions and cash balances',
  'portfolio:write': 'Create and edit portfolios, transactions, custom assets and cash',
  'workboard:read': 'View your watchlist, conglomerates and backtests',
  'workboard:write': 'Create and edit your watchlist and conglomerates',
  'market:read': 'Search assets and read market data',
  'social:read': 'See your friends and the items shared with you',
  // #361 additions — plain-language consent copy for the new platform scopes.
  'social:write': 'Send and respond to friend requests and manage your friends',
  'notifications:read': 'View your notifications',
  'notifications:write': 'Mark your notifications as read and change your notification settings',
  'chat:read': 'Read your messages',
  'chat:write': 'Send messages on your behalf',
  'account:security':
    'Manage your account security: sign-in sessions, two-factor, password change and app PIN',
  // #405 — plain-language consent copy for the price-alerts scopes.
  'alerts:read': 'View your price alerts',
  'alerts:write': 'Create, edit, re-arm and delete your price alerts',
};

// ── Redirect URI validation ─────────────────────────────────────────────────
/** Schemes that must never be a redirect target regardless of shape. */
const FORBIDDEN_REDIRECT_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob']);

/**
 * Valid registrable redirect URI (RFC 6749 §3.1.2 + RFC 8252): https anywhere,
 * http only for loopback (native/mobile), or a custom-scheme deep link
 * (`myapp://callback`). Fragments are forbidden. Exact-match validation against
 * the registered set happens again at authorize/token time — this is only the
 * shape gate at registration.
 */
export function isValidRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // OAuth forbids a fragment component in a redirect URI.
  if (url.hash) return false;
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (FORBIDDEN_REDIRECT_SCHEMES.has(scheme)) return false;
  if (scheme === 'https') return true;
  if (scheme === 'http') {
    // Loopback only (RFC 8252 §7.3): never plain-http to a remote host.
    const host = url.hostname;
    return host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === 'localhost';
  }
  // Custom scheme (native deep link): must be a well-formed scheme with a body.
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && value.length > scheme.length + 3;
}

export const oauthRedirectUriSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(isValidRedirectUri, {
    message:
      'Redirect URI must be https, http loopback, or a custom-scheme deep link (no fragment).',
  });

// ── Client registration (Settings → API Access, "OAuth apps") ───────────────
/**
 * Optional app icon shown on the consent screen for a THIRD-party app (an
 * https image URL). First-party apps render the BetterTrack mark instead, so it
 * is ignored for them.
 */
export const oauthLogoUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((u) => u.toLowerCase().startsWith('https://'), 'Logo URL must be https.');

export const createOAuthClientRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    redirectUris: z.array(oauthRedirectUriSchema).min(1).max(10),
    scopes: z.array(apiKeyScopeSchema).min(1).max(API_KEY_SCOPES.length),
    /** Public clients hold no secret and MUST use PKCE (native/mobile/SPA apps). */
    public: z.boolean().optional().default(false),
    /** Optional consent-screen icon (third-party apps). */
    logoUrl: oauthLogoUrlSchema.nullish(),
  })
  .strict();
export type CreateOAuthClientRequest = z.infer<typeof createOAuthClientRequestSchema>;

/**
 * `PATCH /admin/oauth-clients/:id` — edit an existing (first-party) app: its
 * name, redirect URIs and allowed scopes, with the SAME validation as creation.
 * Full-replacement semantics: the caller sends the complete desired redirect-URI
 * and scope sets. The `client_id`, the public/confidential nature and the client
 * secret are intentionally NOT editable here — issued tokens reference the
 * `client_id`, and flipping the client type would force a secret rotation (a
 * separate, deliberately un-bundled concern).
 *
 * Consent-safety (enforced at the token/resource layer, not just the UI):
 * widening `scopes` NEVER silently widens an existing user grant — the effective
 * scope of a live access token is the intersection of the scopes the user
 * originally consented to and the app's *current* allowed scopes, so a user only
 * gains a newly-added scope through a fresh consent. Narrowing (removing a scope
 * or a redirect URI) takes effect immediately for every existing token/grant.
 */
export const updateOAuthClientRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    redirectUris: z.array(oauthRedirectUriSchema).min(1).max(10),
    scopes: z.array(apiKeyScopeSchema).min(1).max(API_KEY_SCOPES.length),
    /** Optional consent-screen icon (third-party apps; ignored for first-party). */
    logoUrl: oauthLogoUrlSchema.nullish(),
  })
  .strict();
export type UpdateOAuthClientRequest = z.infer<typeof updateOAuthClientRequestSchema>;

/** A registered OAuth app as listed under API Access (never carries a secret). */
export const oauthClientSummarySchema = z
  .object({
    id: z.string().uuid(),
    clientId: z.string(),
    name: z.string(),
    redirectUris: z.array(z.string()),
    scopes: z.array(apiKeyScopeSchema),
    public: z.boolean(),
    /** Admin-managed official app (trusted; consent auto-approved, BT-branded). */
    firstParty: z.boolean(),
    /** Consent-screen icon for third-party apps; null for first-party. */
    logoUrl: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type OAuthClientSummary = z.infer<typeof oauthClientSummarySchema>;

export const oauthClientListResponseSchema = z
  .object({ clients: z.array(oauthClientSummarySchema) })
  .strict();
export type OAuthClientListResponse = z.infer<typeof oauthClientListResponseSchema>;

/**
 * `POST /settings/oauth-clients` response — the freshly-registered app plus its
 * plaintext `clientSecret`, returned **exactly once** (null for public clients).
 * Re-fetching the client never includes it (the #302 show-once pattern).
 */
export const createOAuthClientResponseSchema = z
  .object({ client: oauthClientSummarySchema, clientSecret: z.string().nullable() })
  .strict();
export type CreateOAuthClientResponse = z.infer<typeof createOAuthClientResponseSchema>;

// ── Grant management (apps the user has authorized) ─────────────────────────
export const oauthGrantSummarySchema = z
  .object({
    id: z.string().uuid(),
    clientId: z.string(),
    appName: z.string(),
    scopes: z.array(apiKeyScopeSchema),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();
export type OAuthGrantSummary = z.infer<typeof oauthGrantSummarySchema>;

export const oauthGrantListResponseSchema = z
  .object({ grants: z.array(oauthGrantSummarySchema) })
  .strict();
export type OAuthGrantListResponse = z.infer<typeof oauthGrantListResponseSchema>;

// ── Authorize + consent (user origin, session-authenticated) ────────────────
export const OAUTH_CODE_CHALLENGE_METHODS = ['S256'] as const;
export const oauthCodeChallengeMethodSchema = z.enum(OAUTH_CODE_CHALLENGE_METHODS);

/**
 * `GET /oauth/authorization-details` query — the SPA consent screen reads the
 * authorize request (standard OAuth param names) to render "App X wants to…".
 * PKCE fields are optional here and enforced by the service against the client.
 */
export const oauthAuthorizationDetailsQuerySchema = z
  .object({
    response_type: z.literal('code').optional(),
    client_id: z.string().trim().min(1),
    redirect_uri: z.string().trim().min(1),
    scope: z.string().trim().min(1),
    state: z.string().trim().max(1024).optional(),
    code_challenge: z.string().trim().max(256).optional(),
    code_challenge_method: oauthCodeChallengeMethodSchema.optional(),
  })
  .strip();
export type OAuthAuthorizationDetailsQuery = z.infer<typeof oauthAuthorizationDetailsQuerySchema>;

/** Consent-screen payload: the app + the requested scopes in plain language. */
export const oauthAuthorizationDetailsResponseSchema = z
  .object({
    client: z
      .object({
        clientId: z.string(),
        name: z.string(),
        /** Trusted official app: the consent screen shows BetterTrack branding
         * and auto-approves (no scope-approval prompt). */
        firstParty: z.boolean(),
        /** Third-party app icon for the consent screen; null for first-party. */
        logoUrl: z.string().nullable(),
      })
      .strict(),
    scopes: z.array(z.object({ scope: apiKeyScopeSchema, label: z.string() }).strict()).min(1),
    redirectUri: z.string(),
    state: z.string().nullable(),
  })
  .strict();
export type OAuthAuthorizationDetailsResponse = z.infer<
  typeof oauthAuthorizationDetailsResponseSchema
>;

/**
 * `POST /oauth/authorize` — the user approved consent. Same authorize params;
 * the service mints a single-use code and returns where to send the browser
 * (the registered redirect URI with `?code=…&state=…`, custom scheme included).
 */
export const oauthApproveRequestSchema = z
  .object({
    // The SPA forwards the whole authorize request it received; `response_type`
    // is accepted (and ignored) so it need not strip it before approving.
    response_type: z.literal('code').optional(),
    client_id: z.string().trim().min(1),
    redirect_uri: z.string().trim().min(1),
    scope: z.string().trim().min(1),
    state: z.string().trim().max(1024).optional(),
    code_challenge: z.string().trim().max(256).optional(),
    code_challenge_method: oauthCodeChallengeMethodSchema.optional(),
  })
  .strict();
export type OAuthApproveRequest = z.infer<typeof oauthApproveRequestSchema>;

export const oauthApproveResponseSchema = z.object({ redirectTo: z.string() }).strict();
export type OAuthApproveResponse = z.infer<typeof oauthApproveResponseSchema>;

// ── Token endpoint (public, machine-to-machine) ─────────────────────────────
export const oauthTokenRequestSchema = z.discriminatedUnion('grant_type', [
  z
    .object({
      grant_type: z.literal('authorization_code'),
      code: z.string().trim().min(1),
      redirect_uri: z.string().trim().min(1),
      client_id: z.string().trim().min(1),
      client_secret: z.string().trim().min(1).optional(),
      code_verifier: z.string().trim().min(43).max(128).optional(),
    })
    .strict(),
  z
    .object({
      grant_type: z.literal('refresh_token'),
      refresh_token: z.string().trim().min(1),
      client_id: z.string().trim().min(1),
      client_secret: z.string().trim().min(1).optional(),
    })
    .strict(),
]);
export type OAuthTokenRequest = z.infer<typeof oauthTokenRequestSchema>;

export const oauthTokenResponseSchema = z
  .object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    refresh_token: z.string(),
    scope: z.string(),
  })
  .strict();
export type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>;

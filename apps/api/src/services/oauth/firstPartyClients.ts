import { isValidRedirectUri, type ApiKeyScope } from '@bettertrack/contracts';

import type { OAuthRepository } from '../../data/repositories/oauthRepository';

/**
 * Canonical definition of a BetterTrack FIRST-PARTY OAuth client — the single
 * source of truth for the official apps we ship. Id, name, redirect URIs, the
 * public/PKCE flag and the intended allowed-scope ceiling all live HERE in code,
 * never in hand-maintained SQL nor as admin-UI-only row data (#395).
 */
export interface FirstPartyClientDefinition {
  /** The stable public `btc_…` identifier the app ships. This is the upsert key. */
  clientId: string;
  /** Consent-screen display name. */
  name: string;
  /** Exact-match redirect targets the app uses (RFC 6749 §3.1.2 / RFC 8252). */
  redirectUris: readonly string[];
  /** Public (PKCE, no client secret) vs confidential. First-party mobile = public. */
  public: boolean;
  /**
   * The intended ALLOWED-scope ceiling. The seed only ever WIDENS an existing
   * row toward this set (a union) — it never narrows and never drops a scope an
   * admin added manually. Adding a scope here is the deliberate config change
   * that lets the next seed reassert a wider ceiling.
   */
  scopeCeiling: readonly ApiKeyScope[];
}

/** Stable public identifier shipped by the official native client. */
export const BETTERTRACK_MOBILE_CLIENT_ID = 'btc_IbT1mzw_7kBiPHPkGfaE0Q';

/**
 * Native return target for the bearer-started Google LINK ceremony (#1328).
 * It is registered additively beside the ordinary OAuth authorization-code
 * callback and is never accepted from a request at runtime.
 */
export const BETTERTRACK_MOBILE_GOOGLE_LINK_REDIRECT_URI = 'bettertrack://oauth/google-link';

/**
 * The official first-party apps, seeded on every deploy (see
 * {@link seedFirstPartyClients}).
 *
 * Why this exists: the mobile client was originally hand-registered through the
 * admin panel and lived ONLY as a table row. On any truly fresh database (a new
 * environment, or a reset without a restore) that row was absent, the scope-grant
 * migrations (`0023_mobile_oauth_scopes`, `0027_mobile_chat_scopes`) no-oped
 * because they are UPDATEs, and mobile OAuth broke with "unknown client" — with
 * no deploy path to heal it. Seeding from this definition closes that gap
 * idempotently. Canonical field values mirror the production `oauth_clients` row
 * created via the admin UI on 2026-07-07 (public/PKCE, no secret, custom-scheme
 * deep link).
 */
export const FIRST_PARTY_CLIENTS: readonly FirstPartyClientDefinition[] = [
  {
    clientId: BETTERTRACK_MOBILE_CLIENT_ID,
    name: 'BetterTrackMobile',
    redirectUris: ['bettertrack://oauth/callback', BETTERTRACK_MOBILE_GOOGLE_LINK_REDIRECT_URI],
    public: true,
    // Full platform ceiling — mobile is the trusted
    // first-party surface. Listed in the canonical API_KEY_SCOPES order; adding a
    // new scope here is a deliberate widening a future seed will reassert. The
    // seed unions (never narrows) and re-runs on every deploy, so appending the
    // feedback scopes here keeps fresh installs aligned with the additive
    // migrations that widen existing mobile clients.
    scopeCeiling: [
      'portfolio:read',
      'portfolio:write',
      'workboard:read',
      'workboard:write',
      'market:read',
      'social:read',
      'social:write',
      'notifications:read',
      'notifications:write',
      'chat:read',
      'chat:write',
      'account:security',
      'alerts:read',
      'alerts:write',
      'cash:read',
      'cash:write',
      'mirrorchain:read',
      'mirrorchain:write',
      'vault:sync',
      'feedback:write',
      'feedback:read',
    ],
  },
];

/** What {@link seedFirstPartyClients} did to one client row (for the seed log + tests). */
export interface FirstPartyClientSeedResult {
  clientId: string;
  /** `created` (row was missing), `converged` (widened in place), `unchanged` (no-op). */
  action: 'created' | 'converged' | 'unchanged';
  scopes: ApiKeyScope[];
  redirectUris: string[];
}

/**
 * Merge `additions` into `existing` additively: keep every existing entry in its
 * current position (never drop, never reorder — this is what preserves an admin's
 * manual extras and ordering), then append only the entries from `additions` that
 * are missing. The never-narrow union both the scope ceiling and the redirect URIs
 * converge through.
 */
function unionPreservingOrder<T>(existing: readonly T[], additions: readonly T[]): T[] {
  const merged = [...existing];
  const seen = new Set<T>(existing);
  for (const item of additions) {
    if (!seen.has(item)) {
      seen.add(item);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Idempotently upsert every {@link FIRST_PARTY_CLIENTS} definition:
 *
 *  - Row MISSING → create it exactly as defined: system-owned (no user, so it
 *    survives any single account), first-party, public/PKCE with no secret, its
 *    canonical redirect URIs and the full intended scope ceiling.
 *  - Row EXISTS → converge WITHOUT NARROWING. The stored ceiling becomes
 *    `existing ∪ intended` and the redirect URIs become `existing ∪ canonical`,
 *    so an admin's manually-added extra scope or redirect URI is preserved (it is
 *    in `existing`, so the union keeps it) and a scope the admin removed but which
 *    is still in the ceiling is re-asserted. The `client_id`, secret, name and the
 *    public flag are never touched. When nothing is missing the CLIENT row is
 *    left exactly as-is, while active grants are still checked and unioned to the
 *    ceiling. Revoked grants and every client outside this definition list are
 *    untouched.
 *
 * Wired into the boot-time seed (`scripts/seed.ts`) alongside the first-admin
 * seed, so a fresh install has the mobile OAuth client without any manual admin
 * step (#395). Returns a per-client summary for the seed log + tests.
 */
export async function seedFirstPartyClients(
  repo: OAuthRepository,
  definitions: readonly FirstPartyClientDefinition[] = FIRST_PARTY_CLIENTS,
): Promise<FirstPartyClientSeedResult[]> {
  const results: FirstPartyClientSeedResult[] = [];
  for (const def of definitions) {
    // Defense in depth: a malformed redirect URI in a definition is a code bug —
    // fail loudly at seed time rather than persist an unusable client.
    for (const uri of def.redirectUris) {
      if (!isValidRedirectUri(uri)) {
        throw new Error(`First-party client "${def.clientId}" has an invalid redirect URI: ${uri}`);
      }
    }

    const existing = await repo.findClientByClientId(def.clientId);
    if (!existing) {
      const row = await repo.createClient({
        userId: null, // system-owned: no user account, survives any single account
        clientId: def.clientId,
        name: def.name,
        clientSecretHash: null, // public client — PKCE, never a secret
        redirectUris: [...def.redirectUris],
        scopes: [...def.scopeCeiling],
        isPublic: def.public,
        isFirstParty: true,
        logoUrl: null, // first-party apps render the BetterTrack mark
      });
      results.push({
        clientId: def.clientId,
        action: 'created',
        scopes: row.scopes as ApiKeyScope[],
        redirectUris: row.redirectUris,
      });
      continue;
    }

    const mergedScopes = unionPreservingOrder(existing.scopes as ApiKeyScope[], def.scopeCeiling);
    const mergedUris = unionPreservingOrder(existing.redirectUris, def.redirectUris);
    // A union can only add entries, so a length change is exactly "something was
    // missing" — cheap and sufficient to decide whether a write is needed.
    const changed =
      mergedScopes.length !== existing.scopes.length ||
      mergedUris.length !== existing.redirectUris.length;
    // Run even when the client row itself is already current: an older active
    // grant can still predate the latest first-party product scope addition.
    const row = await repo.reconcileFirstPartyClient(existing.id, {
      scopes: mergedScopes,
      redirectUris: mergedUris,
    });
    results.push({
      clientId: def.clientId,
      action: changed ? 'converged' : 'unchanged',
      scopes: (row?.scopes ?? mergedScopes) as ApiKeyScope[],
      redirectUris: row?.redirectUris ?? mergedUris,
    });
  }
  return results;
}

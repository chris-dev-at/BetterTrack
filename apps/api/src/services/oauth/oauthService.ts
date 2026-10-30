import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { Redis } from 'ioredis';
import { z } from 'zod';

import {
  API_KEY_SCOPES,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_AUTH_CODE_TTL_SECONDS,
  OAUTH_CLIENT_ID_PREFIX,
  OAUTH_CLIENT_SECRET_PREFIX,
  OAUTH_REFRESH_TOKEN_GRACE_SECONDS,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAUTH_SCOPE_LABELS,
  isValidRedirectUri,
  oauthRefreshReplayWindowSeconds,
  oauthRefreshTokenTtlSeconds,
  scopeSatisfies,
  withImpliedReadScopes,
  type ApiKeyScope,
  type CreateOAuthClientResponse,
  type OAuthApproveRequest,
  type OAuthApproveResponse,
  type OAuthAuthorizationDetailsQuery,
  type OAuthAuthorizationDetailsResponse,
  type OAuthClientSummary,
  type OAuthDenyRequest,
  type OAuthDenyResponse,
  type OAuthGrantSummary,
  type OAuthTokenRequest,
  type OAuthTokenResponse,
} from '@bettertrack/contracts';

import type {
  OAuthAuthorizationCodeExchange,
  OAuthClientListRow,
  OAuthClientLookupRow,
  OAuthRefreshRotationIds,
  OAuthRefreshTokenLookup,
  OAuthRepository,
} from '../../data/repositories/oauthRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { OAuthClientRow, OAuthGrantRow, UserRow } from '../../data/schema';
import { badRequest, notFound, type ApiError } from '../../errors';
import type { EventBus, RealtimePrincipalInvalidatedEvent } from '../../events';
import type { Logger } from '../../logger';
import {
  AuditAction,
  parseBearerScopeDeniedMeta,
  type AuditService,
  type BearerScopeDenialReason,
} from '../audit/auditService';
import { decryptSecret, encryptSecret, type SecretBoxKeyring } from '../crypto/secretBox';
import { hashToken, sha256Base64Url } from '../crypto/tokens';
import {
  createOAuthLogoFetcher,
  type OAuthLogoFetcher,
  type OAuthLogoContentType,
} from './oauthLogo';

/** The resolved principal behind a valid OAuth access token (mirrors the key one). */
export interface OAuthPrincipal {
  user: UserRow;
  grantId: string;
  /** The individual access-token row; the grant is the revocation unit. */
  accessTokenId: string;
  /** Absolute access-token deadline used to terminate an idle socket on time. */
  expiresAt: Date;
  scopes: ApiKeyScope[];
  /** Whether the already-joined client row is an official, trusted app. */
  firstParty: boolean;
}

export interface OAuthServiceDeps {
  repo: OAuthRepository;
  audit: AuditService;
  redis: Redis;
  /** Fresh user-status lookup for fail-closed realtime principal revalidation. */
  userRepo?: Pick<UserRepository, 'findById'>;
  /** Best-effort lifecycle fan-out to disconnect already-open realtime sockets. */
  events?: Pick<EventBus, 'publish'>;
  logger?: Pick<Logger, 'warn'>;
  /** Save-time remote-logo fetcher; defaults to the guard-pinned HTTPS implementation. */
  logoFetcher?: OAuthLogoFetcher;
  /**
   * The record-encryption keyring (`BT_DATA_ENCRYPTION_*`) that seals a rotated
   * refresh token's successor pair for the grace window. Required: without it
   * the grace path could not exist, and every lost refresh answer would sign
   * the user out again.
   */
  recordEncryption: SecretBoxKeyring;
  /** Clock seam so token/code TTLs are testable without wall-clock waits. */
  now?: () => Date;
}

export interface OAuthService {
  registerClient(input: {
    userId: string;
    name: string;
    redirectUris: string[];
    scopes: ApiKeyScope[];
    public: boolean;
    logoUrl?: string | null;
    ip?: string | null;
  }): Promise<CreateOAuthClientResponse>;
  listClients(userId: string): Promise<OAuthClientSummary[]>;
  deleteClient(input: { userId: string; id: string; ip?: string | null }): Promise<void>;
  /** Admin panel: register an official FIRST-PARTY app (system-owned, no user). */
  registerFirstPartyClient(input: {
    adminId: string;
    name: string;
    redirectUris: string[];
    scopes: ApiKeyScope[];
    public: boolean;
    logoUrl?: string | null;
    ip?: string | null;
  }): Promise<CreateOAuthClientResponse>;
  listFirstPartyClients(): Promise<OAuthClientSummary[]>;
  deleteFirstPartyClient(input: { adminId: string; id: string; ip?: string | null }): Promise<void>;
  /**
   * Admin panel: edit an existing first-party app's name, redirect URIs and
   * allowed scopes (consent-safe — see {@link clampToAllowed}). The client_id,
   * secret and public/confidential flag are immutable.
   */
  updateFirstPartyClient(input: {
    adminId: string;
    id: string;
    name: string;
    redirectUris: string[];
    scopes: ApiKeyScope[];
    logoUrl?: string | null;
    ip?: string | null;
  }): Promise<OAuthClientSummary>;
  listGrants(userId: string, currentGrantId: string | null): Promise<OAuthGrantSummary[]>;
  revokeGrant(input: { userId: string; id: string; ip?: string | null }): Promise<void>;
  /** Administrative suspension: revoke grants and invalidate pending auth codes. */
  revokeAllForUser(userId: string): Promise<void>;
  /**
   * Credential event (§16 2026-10-29): a password change or reset ends EVERY
   * OAuth grant of the user; "sign out everywhere" ends every FIRST-PARTY grant
   * except the caller's own (`exceptGrantId`). Pending auth codes for the same
   * client set are consumed. Each revoked grant is invalidated in realtime and
   * audited `oauth.grant_revoked` with `meta.reason`. Resolves to how many
   * grants it revoked; a replay revokes (and audits) nothing. An admin-driven
   * event (the temp-password reset) passes `actorId` (the admin, recorded as
   * the audit actor) and `source: 'admin'` (recorded in the meta).
   */
  revokeGrantsForCredentialEvent(input: {
    userId: string;
    reason: OAuthCredentialRevocationReason;
    firstPartyOnly: boolean;
    exceptGrantId: string | null;
    ip?: string | null;
    actorId?: string;
    source?: 'admin';
  }): Promise<number>;
  /** Consent-screen data: validates the authorize request, plain-language scopes. */
  getAuthorizationDetails(
    query: OAuthAuthorizationDetailsQuery,
  ): Promise<OAuthAuthorizationDetailsResponse>;
  /** Public raster endpoint reads only persisted bytes; it never contacts the source URL. */
  getClientLogo(
    clientId: string,
  ): Promise<{ bytes: Buffer; contentType: OAuthLogoContentType } | null>;
  /** User approved consent → mint a single-use code, return where to send them. */
  approve(input: {
    userId: string;
    body: OAuthApproveRequest;
    ip?: string | null;
  }): Promise<OAuthApproveResponse>;
  /** User denied consent → return the validated callback with an OAuth error. */
  deny(body: OAuthDenyRequest): Promise<OAuthDenyResponse>;
  /** Public token endpoint: authorization_code or refresh_token grant. */
  exchangeToken(input: {
    body: OAuthTokenRequest;
    ip?: string | null;
  }): Promise<OAuthTokenResponse>;
  /** Bearer-auth lookup: resolve an active OAuth access token, else null. */
  authenticateToken(token: string): Promise<OAuthPrincipal | null>;
  /** Revalidate a connected realtime OAuth principal without retaining its token. */
  revalidatePrincipal(input: {
    userId: string;
    grantId: string;
    accessTokenId: string;
    expiresAt: Date;
    scopes: ApiKeyScope[];
  }): Promise<OAuthPrincipal | null>;
  /**
   * Record a scope-denied OAuth bearer attempt (called by the scope middleware).
   * `reason` discriminates a genuine missing scope from a first-party-only
   * refusal of a grant that DOES hold the scope — i.e. a third-party app probing
   * another app's grants (#1365).
   */
  recordScopeDenied(input: {
    userId: string;
    grantId: string;
    requiredScope: string;
    reason: BearerScopeDenialReason;
    method: string;
    path: string;
    ip?: string | null;
  }): Promise<void>;
}

/** `meta.reason` of an `oauth.grant_revoked` row written by a credential event. */
export type OAuthCredentialRevocationReason =
  | 'password_change'
  | 'password_reset'
  | 'sign_out_everywhere';

/**
 * `meta.evidence` of an `oauth.grant_revoked` row with `reason: refresh_reuse` —
 * which check of the re-serve rule the re-presented refresh token failed:
 *  - `window_passed`         — consumed longer ago than the client's window
 *                              (60 s third-party; 24 h first-party);
 *  - `legacy_envelope`       — first-party, past the strict window, but the pair
 *                              was sealed before first-use tracking existed
 *                              (envelope v1), so "never used" cannot be proven;
 *  - `successor_rotated`     — its successor has itself been rotated: the token
 *                              is a grandparent (or older) in the chain;
 *  - `no_successor`          — consumed with no successor recorded (rotated
 *                              before the grace rule existed);
 *  - `successor_access_used` — first-party, past the strict window: the
 *                              successor ACCESS token has already authenticated
 *                              a request, so somebody holds and uses that pair.
 * Per-install token families (the follow-up) move this row to
 * `oauth.token_family_revoked`.
 */
export type OAuthRefreshReuseEvidence =
  | 'window_passed'
  | 'legacy_envelope'
  | 'successor_rotated'
  | 'no_successor'
  | 'successor_access_used';

const VALID_SCOPES = new Set<string>(API_KEY_SCOPES);
const LAST_USED_THROTTLE_SEC = 60;

/** The token-row writer shared by ordinary refreshes and locked code exchanges. */
type OAuthTokenStore = Pick<
  OAuthAuthorizationCodeExchange,
  'createAccessToken' | 'createRefreshToken'
>;

interface PreparedTokenPair {
  issuedAt: Date;
  accessToken: {
    tokenHash: string;
    scopes: ApiKeyScope[];
    expiresAt: Date;
  };
  refreshToken: {
    tokenHash: string;
    expiresAt: Date;
  };
  response: OAuthTokenResponse;
}

const REFRESH_GRACE_MS = OAUTH_REFRESH_TOKEN_GRACE_SECONDS * 1000;

/** Envelopes one successful rotation clears, best-effort, on its way out. */
export const POST_ROTATION_ENVELOPE_SWEEP_BATCH = 100;

/**
 * The plaintext sealed into `oauth_refresh_tokens.successor_envelope`: the exact
 * successor response, plus the row ids it belongs to so an envelope can only
 * ever be honoured on the row it was written for (it is re-checked against the
 * successor's stored hash and the access row before anything is served).
 */
const refreshGraceEnvelopeSchema = z
  .object({
    // 1 = sealed by the 60 s grace code (#2065; no first-use tracking yet): only ever
    // honoured inside the strict 60 s window. 2 = sealed by code that stamps
    // `oauth_access_tokens.first_used_at` on every authentication, so its
    // "never used" signal is trustworthy for the first-party 24 h extension.
    v: z.union([z.literal(1), z.literal(2)]),
    tokenId: z.string().min(1),
    successorId: z.string().min(1),
    accessTokenId: z.string().min(1),
    accessToken: z.string().startsWith(OAUTH_ACCESS_TOKEN_PREFIX),
    refreshToken: z.string().startsWith(OAUTH_REFRESH_TOKEN_PREFIX),
    scope: z.string(),
  })
  .strict();
type RefreshGraceEnvelope = z.infer<typeof refreshGraceEnvelopeSchema>;

/**
 * What the grace rule decided for a consumed refresh token.
 *  - `served`      — the identical successor tokens, `expires_in` + `scope`
 *                    recomputed. `extended` marks a first-party re-serve made
 *                    past the strict 60 s window (the 24 h unused-successor rule).
 *  - `reuse`       — evidence of reuse ({@link OAuthRefreshReuseEvidence}): the
 *                    window has passed, the successor has itself been rotated
 *                    (an older token in the chain), no successor was ever
 *                    recorded (rotated before this rule), or — first-party, past
 *                    the strict window — the successor access token was used.
 *  - `unavailable` — no evidence of reuse, but the server cannot re-serve the
 *                    pair (envelope gone or unreadable, access row gone, grant or
 *                    user no longer active). Refused WITHOUT revoking.
 */
type RefreshGraceOutcome =
  | { kind: 'served'; response: OAuthTokenResponse; extended: boolean }
  | { kind: 'reuse'; evidence: OAuthRefreshReuseEvidence }
  | { kind: 'unavailable' };

function mint(prefix: string): { token: string; tokenHash: string } {
  const token = `${prefix}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashToken(token) };
}

/** Constant-time compare of two same-purpose hex/base64url strings. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function toClientSummary(row: OAuthClientRow | OAuthClientListRow): OAuthClientSummary {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    redirectUris: row.redirectUris,
    scopes: row.scopes as ApiKeyScope[],
    public: row.isPublic,
    firstParty: row.isFirstParty,
    logoPath: logoPathFor(row),
    createdAt: row.createdAt.toISOString(),
  };
}

type OAuthClientLogoState =
  | Pick<OAuthClientRow, 'clientId' | 'isFirstParty' | 'logoBytes' | 'logoContentType'>
  | (Pick<OAuthClientRow, 'clientId' | 'isFirstParty'> & { hasLogo: boolean });

function logoPathFor(row: OAuthClientLogoState): string | null {
  const hasLogo = 'hasLogo' in row ? row.hasLogo : Boolean(row.logoBytes && row.logoContentType);
  if (row.isFirstParty || !hasLogo) return null;
  return `/oauth/client-logos/${row.clientId}`;
}

/**
 * Parse the space-delimited `scope` param into a validated, client-allowed,
 * write⇒read-closed set.
 *
 * Two uses of the ONE implication rule (#1740, V5-P0b), both deliberate:
 *
 *  - The ceiling test is `scopeSatisfies`, not raw set membership. A client
 *    whose ceiling holds `x:write` permits `x:read`, because a token minted from
 *    that client already reaches every `x:read` route through the very same
 *    `scopeSatisfies` in the bearer middleware. Refusing the read here was a
 *    spurious `INVALID_SCOPE`, never a real authorization boundary. Nothing that
 *    was refusable before stops being refused: an unknown scope and a scope
 *    outside the ceiling under this rule still throw.
 *  - The RESULT is normalized, so the auth code, the grant and the access token
 *    all store exactly the set the consent screen showed the user (it renders
 *    `withImpliedReadScopes` too). This is the grant-time half of the rule.
 */
function parseScopes(scope: string, client: Pick<OAuthClientRow, 'scopes'>): ApiKeyScope[] {
  const requested = scope.split(/\s+/).filter(Boolean);
  if (requested.length === 0) {
    throw badRequest('At least one scope is required.', 'INVALID_SCOPE');
  }
  const out: ApiKeyScope[] = [];
  const seen = new Set<string>();
  for (const s of requested) {
    if (!VALID_SCOPES.has(s)) {
      throw badRequest(`Unknown scope "${s}".`, 'INVALID_SCOPE');
    }
    if (!scopeSatisfies(client.scopes, s)) {
      throw badRequest(`Scope "${s}" is not permitted for this app.`, 'INVALID_SCOPE');
    }
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s as ApiKeyScope);
    }
  }
  return withImpliedReadScopes(out);
}

/**
 * The consent-safety rule, in one place: an OAuth grant/token's EFFECTIVE scope
 * is the set the user actually consented to (recorded on the grant + stamped on
 * the token at issue time) intersected with the app's CURRENT allowed-scope
 * ceiling. This single `min()` makes both required behaviours fall out for free:
 *
 *  - Ordinary app widening (an admin adds a scope) can NEVER silently widen a
 *    live grant — the token never consented to the new scope, so the intersection
 *    omits it; the user gains it only by running the consent flow again. The
 *    deliberate product-owned exception is the boot reconcile for official
 *    first-party apps: it widens their active grants, but issued access tokens
 *    remain immutable snapshots and gain the scope only after refresh.
 *  - Narrowing the app (admin removes a scope, or a redirect URI) applies
 *    IMMEDIATELY — the removed scope drops out of every existing token/grant the
 *    next time it is used, without re-issuing or revoking anything. The ONE
 *    exception is a narrowing that leaves the effective set EMPTY: that grant is
 *    retired on its next refresh rather than kept alive with no scopes at all
 *    (#1985, §16 2026-09-16 — see `retireEmptyScopeGrant`).
 *
 * Enforced at the token/resource layer ({@link OAuthService.authenticateToken})
 * so it holds for every bearer request, not merely in the admin UI.
 */
function clampToAllowed(
  consented: readonly ApiKeyScope[],
  allowed: readonly string[],
): ApiKeyScope[] {
  // The ceiling test is `scopeSatisfies`, not raw set membership (#1740): a
  // ceiling that holds `x:write` permits `x:read`, so a consented read is kept
  // rather than silently dropped from the grant list, the consent payload and
  // the token principal. This can only RETAIN a scope the user already consented
  // to under a ceiling that already permits it — it never adds one, and the two
  // behaviours above are untouched: a scope removed from the app entirely (both
  // halves) still disappears immediately, and a scope the user never consented
  // to is still absent no matter how wide the ceiling grows.
  return consented.filter((s) => scopeSatisfies(allowed, s));
}

/**
 * The ONE refusal both token exchanges give when {@link clampToAllowed} leaves
 * the effective set EMPTY — the app was narrowed to nothing, or to a set
 * disjoint from what this user consented to (#1985).
 *
 * Shared rather than duplicated so the code and refresh paths cannot drift: a
 * client must not be able to tell which exchange it ran from the refusal it got
 * back, and a zero-scope token — which satisfies no scope check anywhere — must
 * never be minted by either.
 */
function emptyEffectiveScope(): ApiError {
  return badRequest('No requested scope is still permitted for this app.', 'INVALID_SCOPE');
}

/**
 * OAuth 2.0 provider service (PROJECTPLAN.md §6.13, §14, V2-P12). Owns client
 * registration, the authorize/consent + token exchange flows, grant management,
 * and access-token resolution for the bearer middleware. Security invariants:
 * redirect URIs are exact-matched (never redirected to an unvalidated target),
 * public clients MUST use PKCE, codes are single-use + short-lived, refresh
 * tokens rotate on every use, and revoking a grant cuts off every token because
 * the token lookup joins through the grant.
 *
 * Refresh reuse (RFC 6819 §5.2.2.3, RFC 9700 §4.14.2) has a grace window of
 * {@link OAUTH_REFRESH_TOKEN_GRACE_SECONDS}: re-presenting the token that was
 * JUST rotated — a lost response, or the losing side of two concurrent
 * refreshes — returns the identical successor pair (with `expires_in` and
 * `scope` recomputed), as long as that successor has not itself been rotated and the
 * same client authenticates. For an official first-party app (§16 2026-10-29)
 * the re-serve extends to `OAUTH_FIRST_PARTY_REFRESH_REPLAY_MAX_SECONDS`
 * (24 h) as long as the successor pair was never used — successor refresh
 * unconsumed AND successor access token never authenticated — so a lost answer
 * retried hours later (a killed process, a dead network) never signs the phone
 * out. Any other reuse — past the window, of an older token in the chain, or of
 * a token whose successor somebody already used — is treated as theft and
 * revokes the whole grant, audited `oauth.grant_revoked` reason
 * `refresh_reuse` (one grant per client+user; per-install token families are a
 * later change). A concurrent loser never revokes: it either receives the
 * winner's pair or a plain INVALID_GRANT. Refresh expiry slides on every
 * rotation: 90 days first-party, 30 days third-party.
 */
export function createOAuthService(deps: OAuthServiceDeps): OAuthService {
  const { repo, audit, redis, userRepo, events, logger, recordEncryption } = deps;
  const now = deps.now ?? (() => new Date());
  const logoFetcher = deps.logoFetcher ?? createOAuthLogoFetcher({ logger });

  async function publishInvalidation(
    event: Omit<RealtimePrincipalInvalidatedEvent, 'type' | 'occurredAt'>,
  ): Promise<void> {
    if (!events) return;
    try {
      await events.publish({
        type: 'realtime.principal.invalidated',
        ...event,
        occurredAt: now().toISOString(),
      });
    } catch (err) {
      // The grant is already revoked. Socket revalidation remains the
      // fail-closed backstop if this ephemeral cross-process signal is lost.
      logger?.warn(
        { err, userId: event.userId, kind: event.kind },
        'oauth realtime invalidation publish failed',
      );
    }
  }

  /**
   * Retire a grant whose effective scope set has clamped to EMPTY (#1985) — the
   * app was narrowed to nothing, or to a ceiling that permits NONE of this
   * user's consented scopes. "Permits" is `scopeSatisfies`, not raw set
   * membership: a `portfolio:write` ceiling still permits a consented
   * `portfolio:read`, so that grant refreshes normally and never reaches here.
   *
   * What the revoke costs, measured rather than assumed. Every access token
   * under this grant clamps to the same empty set at
   * {@link OAuthService.authenticateToken}, so every scope-gated route refuses
   * it (403) and the refresh token can only ever mint another of those. It is
   * NOT inert, though: `/auth/me` and `/auth/logout` resolve `{ kind: 'allow' }`
   * for any valid bearer with no scope at all (`bearerAuth.ts`,
   * `resolveAuthPolicy`). Before the revoke that token still answered `/auth/me`
   * with 200 and the user's id, email, username and role; after it, 401. So the
   * revoke does destroy one real capability: a scopeless identity echo.
   *
   * That is the deliberate choice, not an oversight. An identity echo on a grant
   * that can do nothing else is not worth preserving, the client cannot refresh
   * it into anything more, and re-consent restores it in full. Both the 403/401
   * scoped pair and the 200/401 `/auth/me` pair are pinned in
   * `oauthRefreshZeroScope.test.ts`.
   *
   * Only the EMPTY case is retired. A non-empty narrowing still merely drops the
   * removed scopes from the next token, exactly as {@link clampToAllowed} says.
   *
   * Accepted trade-off: an admin who empties a ceiling and later restores it
   * does not resurrect these grants — the affected users re-consent (§16
   * 2026-09-16). That is the conservative direction, and the only one that keeps
   * the refusal terminal.
   *
   * IDEMPOTENCY KEY: the grant id. `repo.revokeGrant` matches only a row whose
   * `revoked_at IS NULL`, so two concurrent refreshes of the same dead grant
   * produce exactly one revocation — one audit row, one invalidation fan-out.
   * The two callers do NOT answer alike, and nothing here promises they will:
   * the winner refuses with {@link emptyEffectiveScope}, while the loser re-reads
   * the now-revoked grant and is refused `INVALID_GRANT` earlier in the exchange.
   * Both are terminal refusals that mint no token.
   */
  async function retireEmptyScopeGrant(input: {
    grant: OAuthGrantRow;
    client: OAuthClientLookupRow;
    ip: string | null;
  }): Promise<void> {
    const revoked = await repo.revokeGrant(input.grant.userId, input.grant.id);
    if (!revoked) return;
    await publishInvalidation({
      userId: input.grant.userId,
      kind: 'oauth',
      credentialId: input.grant.id,
      exceptCredentialId: null,
    });
    try {
      await audit.record({
        actorId: input.grant.userId,
        action: AuditAction.OAuthGrantRevoked,
        targetType: 'oauth_grant',
        targetId: input.grant.id,
        ip: input.ip,
        meta: { clientId: input.client.clientId, reason: 'scope_ceiling_empty' },
      });
    } catch (err) {
      // Swallowed on purpose, mirroring `publishInvalidation` above. The
      // revocation is ALREADY committed at this point, so the security action
      // succeeded and only its record failed; letting the write escape would
      // turn the shared 400 into a 500 and break the one property this change
      // exists to establish — that both exchanges answer an empty effective set
      // identically. Emitted at warn because this service's logger dep is
      // deliberately `Pick<Logger, 'warn'>`; a lost revocation record is a real
      // audit gap, so the message says so explicitly rather than relying on a
      // level this service is not wired to emit.
      logger?.warn(
        { err, userId: input.grant.userId, grantId: input.grant.id },
        'oauth zero-scope grant revocation AUDIT GAP: grant revoked but audit write failed',
      );
    }
  }

  /** Fan out a client cascade to the exact OAuth grants it removed. */
  async function invalidateDeletedClientGrants(
    grants: readonly { id: string; userId: string }[],
  ): Promise<void> {
    await Promise.all(
      grants.map(({ id, userId }) =>
        publishInvalidation({
          userId,
          kind: 'oauth',
          credentialId: id,
          exceptCredentialId: null,
        }),
      ),
    );
  }

  /** Shared authorize-request validation for the consent read, approve and deny paths. */
  async function validateAuthorize(input: {
    clientId: string;
    redirectUri: string;
    scope: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  }): Promise<{ client: OAuthClientLookupRow; scopes: ApiKeyScope[] }> {
    const client = await repo.findClientByClientId(input.clientId);
    if (!client) {
      throw badRequest('Unknown client.', 'INVALID_CLIENT');
    }
    // Exact-match the redirect URI against the registered set — never redirect
    // to (or reflect) an unvalidated target.
    if (!client.redirectUris.includes(input.redirectUri)) {
      throw badRequest('redirect_uri does not match a registered URI.', 'INVALID_REDIRECT_URI');
    }
    const scopes = parseScopes(input.scope, client);
    // PKCE: mandatory for public clients (no secret to prove identity); when a
    // challenge is supplied at all it must be the S256 method we support.
    if (input.codeChallenge) {
      if (input.codeChallengeMethod && input.codeChallengeMethod !== 'S256') {
        throw badRequest('Only the S256 PKCE method is supported.', 'INVALID_REQUEST');
      }
    } else if (client.isPublic) {
      throw badRequest(
        'Public clients must use PKCE (code_challenge required).',
        'INVALID_REQUEST',
      );
    } else if (input.codeChallengeMethod) {
      throw badRequest('code_challenge_method requires a code_challenge.', 'INVALID_REQUEST');
    }
    return { client, scopes };
  }

  /**
   * Mint a fresh pair. The refresh expiry SLIDES: every pair — the code
   * exchange and every rotation — gets a full fresh idle lifetime from now,
   * 90 days for an official first-party app and 30 days for a third-party one
   * ({@link oauthRefreshTokenTtlSeconds}, §16 2026-10-29).
   */
  function prepareTokenPair(scopes: ApiKeyScope[], firstParty: boolean): PreparedTokenPair {
    const issued = now();
    const access = mint(OAUTH_ACCESS_TOKEN_PREFIX);
    const refresh = mint(OAUTH_REFRESH_TOKEN_PREFIX);
    const accessExpires = new Date(issued.getTime() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshExpires = new Date(
      issued.getTime() + oauthRefreshTokenTtlSeconds(firstParty) * 1000,
    );
    return {
      issuedAt: issued,
      accessToken: {
        tokenHash: access.tokenHash,
        scopes,
        expiresAt: accessExpires,
      },
      refreshToken: {
        tokenHash: refresh.tokenHash,
        expiresAt: refreshExpires,
      },
      response: {
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refresh.token,
        scope: scopes.join(' '),
      },
    };
  }

  /** Seal a rotation's successor response for the grace window (secretBox v2). */
  function sealRefreshGrace(pair: PreparedTokenPair, ids: OAuthRefreshRotationIds): string {
    const envelope: RefreshGraceEnvelope = {
      v: 2,
      tokenId: ids.tokenId,
      successorId: ids.successorId,
      accessTokenId: ids.accessTokenId,
      accessToken: pair.response.access_token,
      refreshToken: pair.response.refresh_token,
      scope: pair.response.scope,
    };
    return encryptSecret(JSON.stringify(envelope), recordEncryption);
  }

  /** Open an envelope; null when it is malformed, tampered or sealed under a retired key. */
  function openRefreshGrace(sealed: string): RefreshGraceEnvelope | null {
    try {
      const parsed = refreshGraceEnvelopeSchema.safeParse(
        JSON.parse(decryptSecret(sealed, recordEncryption)),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * The refresh grace rule, applied to a CONSUMED refresh token. The caller has
   * already authenticated `client` and matched it to the grant; this re-checks
   * the grant and user from `lookup` (fresh for a concurrent loser) and serves
   * the identical successor pair only if ALL hold:
   *   - the token was consumed at most the client's window ago —
   *     OAUTH_REFRESH_TOKEN_GRACE_SECONDS (60 s) for everyone, extended to
   *     OAUTH_FIRST_PARTY_REFRESH_REPLAY_MAX_SECONDS (24 h) for an official
   *     first-party app ({@link oauthRefreshReplayWindowSeconds});
   *   - its recorded successor exists and is unconsumed (it is the immediately
   *     previous token — never a grandparent);
   *   - the envelope opens under the keyring and names exactly this row, this
   *     successor and the successor's stored hash;
   *   - the successor's access row still exists on this grant;
   *   - inside the strict 60 s window: that access token is unexpired (#2065's
   *     rule, unchanged — a race or a lost answer is never punished, even if
   *     the winner already used its access token);
   *   - past the strict window (first-party only): the pair was NEVER USED —
   *     the successor access token has never authenticated a request
   *     (`first_used_at IS NULL`) and the envelope was sealed by code that
   *     records that (v2). Its access token may have lapsed by then; the answer
   *     then says `expires_in: 0` next to the live successor refresh token.
   * The answer is the identical tokens with `expires_in` and `scope` recomputed
   * for this instant. Nothing here writes; the caller decides what a
   * non-`served` outcome costs.
   */
  async function replayWithinGrace(
    lookup: OAuthRefreshTokenLookup,
    client: OAuthClientLookupRow,
  ): Promise<RefreshGraceOutcome> {
    const { token, grant, user, successor } = lookup;
    const at = now();
    if (grant.revokedAt || grant.clientId !== client.id || user.status !== 'active') {
      return { kind: 'unavailable' };
    }
    if (!token.consumedAt) return { kind: 'unavailable' };
    const elapsedMs = at.getTime() - token.consumedAt.getTime();
    // `client` IS the grant's client here (checked above), so its flag is the
    // token's own client's flag — the same one the repository's read path and
    // sweeps key the envelope's lifetime on.
    const windowMs = oauthRefreshReplayWindowSeconds(client.isFirstParty) * 1000;
    if (elapsedMs > windowMs) return { kind: 'reuse', evidence: 'window_passed' };
    if (!token.successorId || !successor || successor.id !== token.successorId) {
      return { kind: 'reuse', evidence: 'no_successor' };
    }
    if (successor.consumedAt) return { kind: 'reuse', evidence: 'successor_rotated' };
    if (!token.successorEnvelope) return { kind: 'unavailable' };

    const sealed = openRefreshGrace(token.successorEnvelope);
    if (!sealed) {
      // Ids only — never the envelope or anything derived from a token.
      logger?.warn(
        { refreshTokenId: token.id, grantId: grant.id },
        'oauth refresh grace envelope could not be opened',
      );
      return { kind: 'unavailable' };
    }
    if (
      sealed.tokenId !== token.id ||
      sealed.successorId !== successor.id ||
      !safeEqual(hashToken(sealed.refreshToken), successor.tokenHash) ||
      successor.expiresAt.getTime() <= at.getTime()
    ) {
      return { kind: 'unavailable' };
    }
    // Past the strict window only the first-party unused-successor rule can
    // serve, and only for a pair whose first use would have been recorded.
    const extended = elapsedMs > REFRESH_GRACE_MS;
    if (extended && sealed.v !== 2) return { kind: 'reuse', evidence: 'legacy_envelope' };
    // Joins through the grant (revoked ⇒ absent) and the user, so this is also
    // the freshest grant/user check before anything leaves the server.
    const access = await repo.findAccessTokenByHash(hashToken(sealed.accessToken));
    if (
      !access ||
      access.token.id !== sealed.accessTokenId ||
      access.grant.id !== grant.id ||
      access.user.status !== 'active'
    ) {
      return { kind: 'unavailable' };
    }
    if (extended && access.token.firstUsedAt !== null) {
      return { kind: 'reuse', evidence: 'successor_access_used' };
    }
    const remaining = Math.floor((access.token.expiresAt.getTime() - at.getTime()) / 1000);
    if (!extended && remaining <= 0) return { kind: 'unavailable' };
    const expiresIn = Math.max(0, remaining);
    // The TOKENS are re-served verbatim, but what they are advertised to carry
    // is recomputed exactly like `expires_in`: the sealed scope intersected with
    // what a fresh refresh would mint NOW (the grant clamped to the app's current
    // ceiling). An admin narrowing inside the window therefore shows up in the
    // answer, as it would on a fresh refresh; enforcement never depended on it
    // (the bearer path clamps every request to the current ceiling).
    const current = new Set<string>(
      withImpliedReadScopes(clampToAllowed(grant.scopes as ApiKeyScope[], client.scopes)),
    );
    const advertised = sealed.scope.split(' ').filter((scope) => current.has(scope));
    // Nothing left in common: never answer 200 with a scopeless grant. The
    // emptied-ceiling case is retired before this runs (#1985); this is the
    // residue of a grant re-consented to a disjoint set inside the window.
    if (advertised.length === 0) return { kind: 'unavailable' };
    return {
      kind: 'served',
      extended,
      response: {
        access_token: sealed.accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: sealed.refreshToken,
        scope: advertised.join(' '),
      },
    };
  }

  /**
   * Audit a grace re-serve. `via` separates a re-presented token (`replay` —
   * usually a lost answer, but also what a thief inside the window looks like)
   * from the losing side of a concurrent refresh (`concurrent`). A first-party
   * re-serve past the strict window adds `window: 'first_party_24h'`.
   */
  function recordGraceReplay(
    lookup: OAuthRefreshTokenLookup,
    client: OAuthClientLookupRow,
    ip: string | null,
    via: 'replay' | 'concurrent',
    extended: boolean,
  ): Promise<void> {
    return audit.record({
      actorId: lookup.grant.userId,
      action: AuditAction.OAuthTokenRefreshReplayedInGrace,
      targetType: 'oauth_grant',
      targetId: lookup.grant.id,
      ip,
      meta: extended
        ? { clientId: client.clientId, via, window: 'first_party_24h' }
        : { clientId: client.clientId, via },
    });
  }

  /**
   * A re-presented refresh token failed the re-serve rule with evidence of
   * reuse: treat it as a compromise (RFC 6819 §5.2.2.3) and revoke the whole
   * grant — one grant per client+user until token families land (they move
   * this to the family and the audit row to `oauth.token_family_revoked`).
   * Every such death is audited `oauth.grant_revoked` with
   * `meta.reason: 'refresh_reuse'` and the failed check as `meta.evidence`.
   *
   * IDEMPOTENCY KEY: the grant id. `repo.revokeGrant` matches only a row whose
   * `revoked_at IS NULL`, so two concurrent reuses of the same grant audit
   * once. The invalidation fan-out is published either way (it is idempotent,
   * and a lost revoke race still means the grant is dead). An audit write that
   * fails after the revoke committed is logged loudly and swallowed, exactly
   * like {@link retireEmptyScopeGrant}, so the wire answer stays INVALID_GRANT.
   */
  async function revokeReusedGrant(input: {
    grant: OAuthGrantRow;
    client: OAuthClientLookupRow;
    ip: string | null;
    evidence: OAuthRefreshReuseEvidence;
  }): Promise<void> {
    const revoked = await repo.revokeGrant(input.grant.userId, input.grant.id);
    await publishInvalidation({
      userId: input.grant.userId,
      kind: 'oauth',
      credentialId: input.grant.id,
      exceptCredentialId: null,
    });
    if (!revoked) return;
    try {
      await audit.record({
        actorId: input.grant.userId,
        action: AuditAction.OAuthGrantRevoked,
        targetType: 'oauth_grant',
        targetId: input.grant.id,
        ip: input.ip,
        meta: {
          clientId: input.client.clientId,
          reason: 'refresh_reuse',
          evidence: input.evidence,
        },
      });
    } catch (err) {
      logger?.warn(
        { err, userId: input.grant.userId, grantId: input.grant.id },
        'oauth refresh-reuse grant revocation AUDIT GAP: grant revoked but audit write failed',
      );
    }
  }

  function issueTokenPair(
    store: OAuthTokenStore,
    grantId: string,
    scopes: ApiKeyScope[],
    firstParty: boolean,
  ): Promise<OAuthTokenResponse> {
    const pair = prepareTokenPair(scopes, firstParty);
    return Promise.all([
      store.createAccessToken({
        grantId,
        ...pair.accessToken,
      }),
      store.createRefreshToken({
        grantId,
        ...pair.refreshToken,
      }),
    ]).then(() => pair.response);
  }

  /** Resolve + authenticate the client on the token endpoint (confidential vs public). */
  async function authenticateClient(input: {
    clientId: string;
    clientSecret?: string;
  }): Promise<OAuthClientLookupRow> {
    const client = await repo.findClientByClientId(input.clientId);
    if (!client) {
      throw badRequest('Unknown client.', 'INVALID_CLIENT');
    }
    if (client.isPublic || !client.clientSecretHash) {
      // Public client: no secret. A secret sent here is simply ignored.
      return client;
    }
    if (!input.clientSecret || !safeEqual(hashToken(input.clientSecret), client.clientSecretHash)) {
      throw badRequest('Invalid client credentials.', 'INVALID_CLIENT');
    }
    return client;
  }

  /**
   * Shared client-row creation for both user-registered and admin first-party
   * apps: validates the redirect URIs, mints the `btc_…` id (+ a secret for a
   * confidential client), inserts, and audits under `actorId`.
   */
  async function createClientRow(input: {
    actorId: string;
    userId: string | null;
    name: string;
    redirectUris: string[];
    scopes: ApiKeyScope[];
    isPublic: boolean;
    isFirstParty: boolean;
    logoUrl?: string | null;
    ip?: string | null;
  }): Promise<CreateOAuthClientResponse> {
    // Defense in depth: the contract already gates URI shape, re-check here so
    // the service never trusts a caller that skipped validation.
    for (const uri of input.redirectUris) {
      if (!isValidRedirectUri(uri)) {
        throw badRequest(`Invalid redirect URI "${uri}".`, 'INVALID_REDIRECT_URI');
      }
    }
    // Write⇒read at the WRITE path (#1740, V5-P0b): the stored ceiling never
    // carries a `:write` without its `:read`. This is the single choke point for
    // both user-registered and admin first-party apps, so neither can store the
    // half-set that produced the spurious `INVALID_SCOPE`. Purely additive — a
    // registration that was accepted before is still accepted, with the read
    // added rather than refused.
    const scopes = withImpliedReadScopes(input.scopes);
    const clientId = `${OAUTH_CLIENT_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
    let clientSecret: string | null = null;
    let clientSecretHash: string | null = null;
    if (!input.isPublic) {
      const secret = mint(OAUTH_CLIENT_SECRET_PREFIX);
      clientSecret = secret.token;
      clientSecretHash = secret.tokenHash;
    }
    // Fetch exactly once at save time. A blocked, invalid, oversized or failed
    // logo degrades to the existing letter placeholder without failing app
    // registration. The remote source is never read during consent rendering.
    const logo =
      !input.isFirstParty && input.logoUrl ? await logoFetcher.fetch(input.logoUrl) : null;
    const row = await repo.createClient({
      userId: input.userId,
      clientId,
      name: input.name,
      clientSecretHash,
      redirectUris: input.redirectUris,
      scopes,
      isPublic: input.isPublic,
      isFirstParty: input.isFirstParty,
      // First-party apps render the BetterTrack mark, so a logo is never stored.
      // Keep a third-party source server-side even when the one save-time fetch
      // fails, so a future explicit retry/update can recover without losing it.
      logoUrl: input.isFirstParty ? null : (input.logoUrl ?? null),
      logoBytes: logo?.bytes ?? null,
      logoContentType: logo?.contentType ?? null,
    });
    await audit.record({
      actorId: input.actorId,
      action: AuditAction.OAuthClientRegistered,
      targetType: 'oauth_client',
      targetId: row.id,
      ip: input.ip ?? null,
      meta: {
        public: input.isPublic,
        firstParty: input.isFirstParty,
        // Audit the set actually stored, not the raw request.
        scopes,
        redirectUris: input.redirectUris,
      },
    });
    return { client: toClientSummary(row), clientSecret };
  }

  return {
    registerClient({ userId, name, redirectUris, scopes, public: isPublic, logoUrl, ip }) {
      return createClientRow({
        actorId: userId,
        userId,
        name,
        redirectUris,
        scopes,
        isPublic,
        isFirstParty: false,
        logoUrl,
        ip,
      });
    },

    async listClients(userId) {
      const rows = await repo.listClientsForUser(userId);
      return rows.map(toClientSummary);
    },

    async deleteClient({ userId, id, ip }) {
      const deleted = await repo.deleteClient(userId, id);
      if (!deleted) {
        throw notFound('OAuth app not found.', 'OAUTH_CLIENT_NOT_FOUND');
      }
      await invalidateDeletedClientGrants(deleted.activeGrants);
      await audit.record({
        actorId: userId,
        action: AuditAction.OAuthClientDeleted,
        targetType: 'oauth_client',
        targetId: deleted.client.id,
        ip: ip ?? null,
      });
    },

    // ── Admin: first-party (official) apps ──────────────────────────────────
    registerFirstPartyClient({
      adminId,
      name,
      redirectUris,
      scopes,
      public: isPublic,
      logoUrl,
      ip,
    }) {
      return createClientRow({
        actorId: adminId,
        userId: null, // system-owned, not tied to any user account
        name,
        redirectUris,
        scopes,
        isPublic,
        isFirstParty: true,
        logoUrl,
        ip,
      });
    },

    async listFirstPartyClients() {
      const rows = await repo.listFirstPartyClients();
      return rows.map(toClientSummary);
    },

    async deleteFirstPartyClient({ adminId, id, ip }) {
      const deleted = await repo.deleteFirstPartyClient(id);
      if (!deleted) {
        throw notFound('OAuth app not found.', 'OAUTH_CLIENT_NOT_FOUND');
      }
      await invalidateDeletedClientGrants(deleted.activeGrants);
      await audit.record({
        actorId: adminId,
        action: AuditAction.OAuthClientDeleted,
        targetType: 'oauth_client',
        targetId: deleted.client.id,
        ip: ip ?? null,
      });
    },

    async updateFirstPartyClient({ adminId, id, name, redirectUris, scopes, ip }) {
      // Defense in depth: re-check URI shape even though the contract gated it,
      // so the service never trusts a caller that skipped validation.
      for (const uri of redirectUris) {
        if (!isValidRedirectUri(uri)) {
          throw badRequest(`Invalid redirect URI "${uri}".`, 'INVALID_REDIRECT_URI');
        }
      }
      // Capture the before-state so the audit entry records exactly what changed.
      const before = await repo.findFirstPartyClientById(id);
      if (!before) {
        throw notFound('OAuth app not found.', 'OAUTH_CLIENT_NOT_FOUND');
      }
      const row = await repo.updateFirstPartyClient(id, {
        name,
        redirectUris,
        // Write⇒read at the WRITE path (#1740): an admin who ticks only the write
        // half stores the pair, exactly as the picker already implies.
        scopes: withImpliedReadScopes(scopes),
        // First-party apps render the BetterTrack mark, so a logo is never stored
        // (mirrors registration).
        logoUrl: null,
      });
      if (!row) {
        throw notFound('OAuth app not found.', 'OAUTH_CLIENT_NOT_FOUND');
      }
      await audit.record({
        actorId: adminId,
        action: AuditAction.OAuthClientUpdated,
        targetType: 'oauth_client',
        targetId: row.id,
        ip: ip ?? null,
        meta: {
          before: {
            name: before.name,
            scopes: before.scopes,
            redirectUris: before.redirectUris,
          },
          after: { name: row.name, scopes: row.scopes, redirectUris: row.redirectUris },
        },
      });
      return toClientSummary(row);
    },

    async listGrants(userId, currentGrantId) {
      const rows = await repo.listGrantsForUser(userId);
      return rows.map(({ grant, client }) => ({
        id: grant.id,
        clientId: client.clientId,
        appName: client.name,
        firstParty: client.isFirstParty,
        current: grant.id === currentGrantId,
        // Show the EFFECTIVE scopes so the "authorized apps" list reflects what
        // the token can actually do. Two steps, in this order:
        //   1. clamp to the app's CURRENT ceiling — never a scope an admin has
        //      since removed from the app;
        //   2. expand every implied read (#371/#1730) — `scopeSatisfies` lets a
        //      held `:write` satisfy its `:read` at request time, so a grant
        //      stored as `['portfolio:write']` really can call the read-only
        //      routes. The consent screen already shows the expansion; this
        //      credential-review surface must not understate it.
        // Display-time only: the stored grant is never rewritten.
        scopes: withImpliedReadScopes(clampToAllowed(grant.scopes as ApiKeyScope[], client.scopes)),
        createdAt: grant.createdAt.toISOString(),
        lastUsedAt: grant.lastUsedAt ? grant.lastUsedAt.toISOString() : null,
      }));
    },

    async revokeGrant({ userId, id, ip }) {
      const row = await repo.revokeGrant(userId, id);
      if (!row) {
        throw notFound('Authorized app not found.', 'OAUTH_GRANT_NOT_FOUND');
      }
      await publishInvalidation({
        userId,
        kind: 'oauth',
        credentialId: row.id,
        exceptCredentialId: null,
      });
      await audit.record({
        actorId: userId,
        action: AuditAction.OAuthGrantRevoked,
        targetType: 'oauth_grant',
        targetId: row.id,
        ip: ip ?? null,
      });
    },

    async revokeAllForUser(userId) {
      await repo.revokeAllForUser(userId);
      await publishInvalidation({
        userId,
        kind: 'oauth',
        credentialId: null,
        exceptCredentialId: null,
      });
    },

    async revokeGrantsForCredentialEvent({
      userId,
      reason,
      firstPartyOnly,
      exceptGrantId,
      ip,
      actorId,
      source,
    }) {
      // IDEMPOTENCY KEY: the grant id (`revoked_at IS NULL` in the repository),
      // so each grant is invalidated and audited exactly once however often the
      // event replays. Failures propagate: the caller's credential change must
      // not answer 200 while a grant it promised to end is still live.
      const revoked = await repo.revokeGrantsForCredentialEvent({
        userId,
        firstPartyOnly,
        exceptGrantId,
        revokedAt: now(),
      });
      // Every socket first (each publish is already best-effort), then the
      // audit trail — one row per grant, naming the app and the event.
      await Promise.all(
        revoked.map(({ grantId }) =>
          publishInvalidation({
            userId,
            kind: 'oauth',
            credentialId: grantId,
            exceptCredentialId: null,
          }),
        ),
      );
      // The revoke above is fail-closed (it propagates). The audit trail
      // after it is not: the grants are already revoked, so a failed row is
      // logged loudly and the loop continues — a 500 here would lose the
      // remaining rows for good (a retry revokes nothing more) and skip the
      // caller's own password audit and the admin temp-password e-mail.
      for (const { grantId, clientId } of revoked) {
        try {
          await audit.record({
            actorId: actorId ?? userId,
            action: AuditAction.OAuthGrantRevoked,
            targetType: 'oauth_grant',
            targetId: grantId,
            ip: ip ?? null,
            meta: source ? { clientId, reason, source } : { clientId, reason },
          });
        } catch (err) {
          logger?.warn(
            { err, userId, grantId, reason },
            'oauth credential-event grant revocation AUDIT GAP: grant revoked but audit write failed',
          );
        }
      }
      return revoked.length;
    },

    async getAuthorizationDetails(query) {
      const { client, scopes } = await validateAuthorize({
        clientId: query.client_id,
        redirectUri: query.redirect_uri,
        scope: query.scope,
        codeChallenge: query.code_challenge,
        codeChallengeMethod: query.code_challenge_method,
      });
      return {
        client: {
          clientId: client.clientId,
          name: client.name,
          firstParty: client.isFirstParty,
          logoPath: logoPathFor(client),
        },
        // Write-implies-read (#371): show every implied read on the consent
        // screen so the user sees the true effective access an approval grants
        // (the middleware lets a `:write` satisfy its `:read` at request time).
        scopes: withImpliedReadScopes(scopes).map((scope) => ({
          scope,
          label: OAUTH_SCOPE_LABELS[scope],
        })),
        redirectUri: query.redirect_uri,
        state: query.state ?? null,
      };
    },

    async getClientLogo(clientId) {
      const logo = await repo.findClientLogoByClientId(clientId);
      if (
        !logo ||
        !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(logo.contentType)
      ) {
        return null;
      }
      return {
        bytes: logo.bytes,
        contentType: logo.contentType as OAuthLogoContentType,
      };
    },

    async approve({ userId, body, ip }) {
      const { client, scopes } = await validateAuthorize({
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        scope: body.scope,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
      });
      const code = mint('bta_');
      const expiresAt = new Date(now().getTime() + OAUTH_AUTH_CODE_TTL_SECONDS * 1000);
      await repo.createAuthCode({
        codeHash: code.tokenHash,
        clientId: client.id,
        userId,
        redirectUri: body.redirect_uri,
        scopes,
        codeChallenge: body.code_challenge ?? null,
        codeChallengeMethod: body.code_challenge ? 'S256' : null,
        expiresAt,
      });
      await audit.record({
        actorId: userId,
        action: AuditAction.OAuthGrantAuthorized,
        targetType: 'oauth_client',
        targetId: client.id,
        ip: ip ?? null,
        meta: { scopes },
      });
      const sep = body.redirect_uri.includes('?') ? '&' : '?';
      const params = new URLSearchParams({ code: code.token });
      if (body.state) params.set('state', body.state);
      return { redirectTo: `${body.redirect_uri}${sep}${params.toString()}` };
    },

    async deny(body) {
      await validateAuthorize({
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        scope: body.scope,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
      });
      const sep = body.redirect_uri.includes('?') ? '&' : '?';
      const params = new URLSearchParams({ error: 'access_denied' });
      if (body.state) params.set('state', body.state);
      return { redirectTo: `${body.redirect_uri}${sep}${params.toString()}` };
    },

    async exchangeToken({ body, ip }) {
      if (body.grant_type === 'authorization_code') {
        return exchangeAuthorizationCode(body, ip ?? null);
      }
      return exchangeRefreshToken(body, ip ?? null);
    },

    async authenticateToken(token) {
      if (!token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return null;
      const found = await repo.findAccessTokenByHash(hashToken(token));
      // This is the access-token choke point. Status is checked independently
      // of grant revocation so a disabled account can never use a bearer token
      // while a suspension cleanup is retrying.
      if (!found || found.user.status !== 'active') return null;
      if (found.token.expiresAt.getTime() <= now().getTime()) return null;

      // ── first_used_at (§16 2026-10-29, migration 0121) ──────────────────────
      // The ONE writer: this is the choke point for both the HTTP bearer
      // middleware and the realtime handshake. Once per token, never per
      // request — the row we just read already says whether it was stamped, so
      // only the first authentication pays the write (and a concurrent second
      // one is a no-op UPDATE under the `first_used_at IS NULL` guard). Fail
      // closed: if the stamp cannot be written the request is rejected, because
      // an unrecorded use would let the first-party re-serve hand the same pair
      // to a second holder.
      if (found.token.firstUsedAt === null) {
        await repo.markAccessTokenFirstUsed(found.token.id, now());
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Throttle the grant lastUsedAt write, mirroring the personal-key path.
      const throttleKey = `oauth:touched:${found.grant.id}`;
      const first = await redis.set(throttleKey, '1', 'EX', LAST_USED_THROTTLE_SEC, 'NX');
      if (first === 'OK') {
        await repo.touchGrantLastUsed(found.grant.id, now());
      }
      // Consent-safety choke point (see {@link clampToAllowed}): the token's
      // effective scope is what it consented to, clamped to the app's CURRENT
      // allowed scopes. This is why widening the app can never grant a live token
      // a scope it never consented to, and narrowing the app denies the removed
      // scope immediately — enforced here, before any resource is reached.
      return {
        user: found.user,
        grantId: found.grant.id,
        accessTokenId: found.token.id,
        expiresAt: found.token.expiresAt,
        scopes: clampToAllowed(found.token.scopes as ApiKeyScope[], found.client.scopes),
        firstParty: found.client.isFirstParty,
      };
    },

    async revalidatePrincipal({ userId, grantId, accessTokenId, expiresAt, scopes }) {
      // A real API process always provides the user repository. A deliberately
      // minimal construction must never accidentally keep a socket authorized.
      if (!userRepo || expiresAt.getTime() <= now().getTime()) return null;
      const [user, grants] = await Promise.all([
        userRepo.findById(userId),
        repo.listGrantsForUser(userId),
      ]);
      if (!user || user.status !== 'active') return null;
      const active = grants.find(({ grant }) => grant.id === grantId);
      if (!active) return null;
      // Keep this specific access token's ceiling: a later grant/client edit
      // may reduce it, but revalidation must never broaden its original grant.
      return {
        user,
        grantId,
        accessTokenId,
        expiresAt,
        scopes: clampToAllowed(scopes, active.client.scopes),
        firstParty: active.client.isFirstParty,
      };
    },

    async recordScopeDenied({ userId, grantId, requiredScope, reason, method, path, ip }) {
      // The OAuth twin of the personal-key writer, through the SAME strict meta
      // contract (#1951 §1) — one schema, so the two shapes cannot drift and a
      // bogus `reason` cannot reach the row on either rail. A failure here is a
      // reported 500, never a silent 400 (#1951 L1).
      const meta = parseBearerScopeDeniedMeta('oauthService.recordScopeDenied', {
        requiredScope,
        reason,
        method,
        path,
        kind: 'oauth',
      });
      await audit.record({
        actorId: userId,
        action: AuditAction.ApiKeyScopeDenied,
        targetType: 'oauth_grant',
        targetId: grantId,
        ip: ip ?? null,
        meta,
      });
    },
  };

  async function exchangeAuthorizationCode(
    body: Extract<OAuthTokenRequest, { grant_type: 'authorization_code' }>,
    ip: string | null,
  ): Promise<OAuthTokenResponse> {
    const client = await authenticateClient({
      clientId: body.client_id,
      clientSecret: body.client_secret,
    });
    const issued = await repo.withAuthorizationCodeExchange(
      hashToken(body.code),
      async (exchange) => {
        // A code bound to a different client, absent/deleted account, or disabled
        // account is an invalid grant. This runs while the user's row is locked,
        // so suspension cannot interleave after this check and before grant minting.
        if (
          !exchange ||
          exchange.code.clientId !== client.id ||
          exchange.user.status !== 'active'
        ) {
          throw badRequest('Invalid authorization code.', 'INVALID_GRANT');
        }
        if (exchange.code.redirectUri !== body.redirect_uri) {
          throw badRequest(
            'redirect_uri does not match the authorization request.',
            'INVALID_GRANT',
          );
        }
        if (exchange.code.expiresAt.getTime() <= now().getTime()) {
          throw badRequest('Authorization code has expired.', 'INVALID_GRANT');
        }
        // PKCE verification (RFC 7636). A stored challenge demands a matching verifier.
        if (exchange.code.codeChallenge) {
          if (
            !body.code_verifier ||
            !safeEqual(sha256Base64Url(body.code_verifier), exchange.code.codeChallenge)
          ) {
            throw badRequest('PKCE verification failed.', 'INVALID_GRANT');
          }
        }
        // Clamp the consented scopes to the app's CURRENT allowed set: if the admin
        // narrowed the app during the code's brief lifetime, the grant + token
        // reflect the reduced set immediately (consent-safe narrowing).
        // Closed under write⇒read (#1740): `parseScopes` already normalized what
        // the code stores, and the clamp only ever filters, so this re-normalizes
        // nothing in the ordinary case — it exists for a code minted by a
        // pre-#1740 process whose short TTL straddles the deploy.
        const scopes = withImpliedReadScopes(
          clampToAllowed(exchange.code.scopes as ApiKeyScope[], client.scopes),
        );
        if (scopes.length === 0) {
          // Shared with the refresh exchange (#1985) — both must answer this
          // identically. Nothing is retired here: the code is not consumed, and
          // this path has no grant of its own to retire (an existing one, if
          // any, is retired the moment it is refreshed).
          throw emptyEffectiveScope();
        }
        // Single-use: consume under the code lock before creating a grant or token.
        const consumed = await exchange.consumeCode();
        if (!consumed) {
          throw badRequest('Authorization code has already been used.', 'INVALID_GRANT');
        }
        // Establish (or reuse) the grant for this app↔user pair while retaining the
        // user lock. An administrative disable therefore cannot revoke "what exists"
        // and let this pre-suspension exchange create a new active grant afterwards.
        const existing = await exchange.findActiveGrant(client.id);
        let grantId: string;
        if (existing) {
          grantId = existing.id;
          await exchange.updateGrantScopes(existing.id, scopes);
        } else {
          const grant = await exchange.createGrant({
            clientId: client.id,
            userId: exchange.code.userId,
            scopes,
          });
          grantId = grant.id;
        }
        return {
          tokens: await issueTokenPair(exchange, grantId, scopes, client.isFirstParty),
          grantId,
          userId: exchange.code.userId,
          scopes,
        };
      },
    );
    await audit.record({
      actorId: issued.userId,
      action: AuditAction.OAuthTokenIssued,
      targetType: 'oauth_grant',
      targetId: issued.grantId,
      ip,
      meta: { clientId: client.clientId, scopes: issued.scopes },
    });
    return issued.tokens;
  }

  async function exchangeRefreshToken(
    body: Extract<OAuthTokenRequest, { grant_type: 'refresh_token' }>,
    ip: string | null,
  ): Promise<OAuthTokenResponse> {
    const client = await authenticateClient({
      clientId: body.client_id,
      clientSecret: body.client_secret,
    });
    const found = await repo.findRefreshTokenByHash(hashToken(body.refresh_token), now());
    if (!found || found.grant.clientId !== client.id || found.user.status !== 'active') {
      throw badRequest('Invalid refresh token.', 'INVALID_GRANT');
    }
    if (found.grant.revokedAt) {
      throw badRequest('This authorization has been revoked.', 'INVALID_GRANT');
    }
    // Clamp to the app's current allowed scopes so a refresh never re-broadens a
    // grant past a scope the admin has since removed, and the advertised `scope`
    // matches what the freshly-issued token can actually use.
    // Normalized on the way out (#1740) so a grant row STORED before this rule
    // reached the write paths still mints a token whose stored scope set and
    // advertised `scope` carry the implied reads — the read-side healing that
    // makes a data migration unnecessary.
    const scopes = withImpliedReadScopes(
      clampToAllowed(found.grant.scopes as ApiKeyScope[], client.scopes),
    );
    // Re-presenting an already-rotated refresh token.
    if (found.token.consumedAt) {
      // An emptied ceiling retires the grant BEFORE anything is re-served (#1985):
      // a grace replay must never hand out a pair the exchange itself would now
      // refuse. Applied only inside the client's window (24 h first-party, 60 s
      // otherwise) — outside it this is plain reuse, which keeps its
      // INVALID_GRANT answer below (and revokes the grant too).
      const inWindow =
        now().getTime() - found.token.consumedAt.getTime() <=
        oauthRefreshReplayWindowSeconds(client.isFirstParty) * 1000;
      if (inWindow && scopes.length === 0) {
        await retireEmptyScopeGrant({ grant: found.grant, client, ip });
        throw emptyEffectiveScope();
      }
      const grace = await replayWithinGrace(found, client);
      if (grace.kind === 'served') {
        await recordGraceReplay(found, client, ip, 'replay', grace.extended);
        return grace.response;
      }
      if (grace.kind === 'reuse') {
        // Reuse past the window, of an older token in the chain, or (first-party)
        // of a token whose successor somebody already used, is treated as a
        // compromise: revoke the whole grant, audited with the evidence, and reject.
        await revokeReusedGrant({ grant: found.grant, client, ip, evidence: grace.evidence });
      }
      // `unavailable`: inside the window, with no sign of reuse, but the pair
      // cannot be re-served (envelope unreadable after a key rotation, …). The
      // caller is refused; nobody else is signed out.
      throw badRequest('Refresh token has already been used.', 'INVALID_GRANT');
    }
    if (found.token.expiresAt.getTime() <= now().getTime()) {
      throw badRequest('Refresh token has expired.', 'INVALID_GRANT');
    }
    // The clamp can land on EMPTY: the admin removed every scope from the app,
    // or narrowed it to a set disjoint from this consent (#1985). Minting here
    // would hand the client a 200 and a zero-scope token — a credential that
    // satisfies nothing — where the code exchange refuses outright. Refuse
    // identically, and retire the grant so the next refresh is terminal rather
    // than a repeat of this same exchange. Ordered AFTER the revoked/reused/
    // expired checks so a bad refresh token keeps its INVALID_GRANT answer, and
    // BEFORE `prepareTokenPair`/`rotateRefreshToken` so no token row is written
    // and the presented refresh token is not consumed.
    if (scopes.length === 0) {
      await retireEmptyScopeGrant({ grant: found.grant, client, ip });
      throw emptyEffectiveScope();
    }
    const pair = prepareTokenPair(scopes, client.isFirstParty);
    const rotation = await repo.rotateRefreshToken({
      tokenId: found.token.id,
      grantId: found.grant.id,
      rotatedAt: pair.issuedAt,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      sealSuccessor: (ids) => sealRefreshGrace(pair, ids),
    });
    if (rotation.outcome === 'replayed') {
      // Lost the atomic consume to a concurrent refresh of the SAME token. Both
      // callers presented it while it was current — a race, not reuse — so the
      // grant is never revoked here: this caller gets the winner's pair under
      // the grace rule, or a plain INVALID_GRANT when that cannot be served.
      // `pair` was never written and is simply dropped.
      const grace = rotation.current
        ? await replayWithinGrace(rotation.current, client)
        : ({ kind: 'unavailable' } as const);
      if (grace.kind === 'served' && rotation.current) {
        await recordGraceReplay(rotation.current, client, ip, 'concurrent', grace.extended);
        return grace.response;
      }
      throw badRequest('Refresh token has already been used.', 'INVALID_GRANT');
    }
    await audit.record({
      actorId: found.grant.userId,
      action: AuditAction.OAuthTokenRefreshed,
      targetType: 'oauth_grant',
      targetId: found.grant.id,
      ip,
      meta: { clientId: client.clientId },
    });
    await sweepExpiredGraceEnvelopes(pair.issuedAt);
    return pair.response;
  }

  /**
   * Best-effort, AFTER the rotation committed: null up to
   * {@link POST_ROTATION_ENVELOPE_SWEEP_BATCH} envelopes anywhere on the
   * instance whose window has passed at `rotatedAt` — each row's OWN window
   * (60 s third-party, 24 h first-party; the repository applies it per row, so
   * a first-party pair that may still be re-served is never taken). A sealed
   * pair on a row nobody re-reads and whose successor never rotates (a phone
   * that got its answer and went idle) would otherwise sit at rest until the
   * daily sweep — and the nightly dump runs before that. Any refresh traffic
   * now bounds that to minutes past its window. Served by the partial
   * live-envelope index; idempotent; a failure here is logged and never fails
   * the refresh that already succeeded.
   */
  async function sweepExpiredGraceEnvelopes(rotatedAt: Date): Promise<void> {
    try {
      await repo.clearExpiredSuccessorEnvelopes(rotatedAt, POST_ROTATION_ENVELOPE_SWEEP_BATCH);
    } catch (err) {
      logger?.warn({ err }, 'oauth post-rotation grace-envelope sweep failed');
    }
  }
}

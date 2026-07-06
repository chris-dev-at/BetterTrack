import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { Redis } from 'ioredis';

import {
  API_KEY_SCOPES,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_AUTH_CODE_TTL_SECONDS,
  OAUTH_CLIENT_ID_PREFIX,
  OAUTH_CLIENT_SECRET_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  OAUTH_SCOPE_LABELS,
  isValidRedirectUri,
  type ApiKeyScope,
  type CreateOAuthClientResponse,
  type OAuthApproveRequest,
  type OAuthApproveResponse,
  type OAuthAuthorizationDetailsQuery,
  type OAuthAuthorizationDetailsResponse,
  type OAuthClientSummary,
  type OAuthGrantSummary,
  type OAuthTokenRequest,
  type OAuthTokenResponse,
} from '@bettertrack/contracts';

import type { OAuthRepository } from '../../data/repositories/oauthRepository';
import type { OAuthClientRow, UserRow } from '../../data/schema';
import { badRequest, notFound } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { hashToken, sha256Base64Url } from '../crypto/tokens';

/** The resolved principal behind a valid OAuth access token (mirrors the key one). */
export interface OAuthPrincipal {
  user: UserRow;
  grantId: string;
  scopes: ApiKeyScope[];
}

export interface OAuthServiceDeps {
  repo: OAuthRepository;
  audit: AuditService;
  redis: Redis;
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
  listGrants(userId: string): Promise<OAuthGrantSummary[]>;
  revokeGrant(input: { userId: string; id: string; ip?: string | null }): Promise<void>;
  /** Consent-screen data: validates the authorize request, plain-language scopes. */
  getAuthorizationDetails(
    query: OAuthAuthorizationDetailsQuery,
  ): Promise<OAuthAuthorizationDetailsResponse>;
  /** User approved consent → mint a single-use code, return where to send them. */
  approve(input: {
    userId: string;
    body: OAuthApproveRequest;
    ip?: string | null;
  }): Promise<OAuthApproveResponse>;
  /** Public token endpoint: authorization_code or refresh_token grant. */
  exchangeToken(input: {
    body: OAuthTokenRequest;
    ip?: string | null;
  }): Promise<OAuthTokenResponse>;
  /** Bearer-auth lookup: resolve an active OAuth access token, else null. */
  authenticateToken(token: string): Promise<OAuthPrincipal | null>;
  /** Record a scope-denied OAuth bearer attempt (called by the scope middleware). */
  recordScopeDenied(input: {
    userId: string;
    grantId: string;
    requiredScope: string;
    method: string;
    path: string;
    ip?: string | null;
  }): Promise<void>;
}

const VALID_SCOPES = new Set<string>(API_KEY_SCOPES);
const LAST_USED_THROTTLE_SEC = 60;

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

function toClientSummary(row: OAuthClientRow): OAuthClientSummary {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    redirectUris: row.redirectUris,
    scopes: row.scopes as ApiKeyScope[],
    public: row.isPublic,
    firstParty: row.isFirstParty,
    logoUrl: row.logoUrl ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Parse the space-delimited `scope` param into a validated, client-allowed set. */
function parseScopes(scope: string, client: OAuthClientRow): ApiKeyScope[] {
  const requested = scope.split(/\s+/).filter(Boolean);
  if (requested.length === 0) {
    throw badRequest('At least one scope is required.', 'INVALID_SCOPE');
  }
  const allowed = new Set(client.scopes);
  const out: ApiKeyScope[] = [];
  const seen = new Set<string>();
  for (const s of requested) {
    if (!VALID_SCOPES.has(s)) {
      throw badRequest(`Unknown scope "${s}".`, 'INVALID_SCOPE');
    }
    if (!allowed.has(s)) {
      throw badRequest(`Scope "${s}" is not permitted for this app.`, 'INVALID_SCOPE');
    }
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s as ApiKeyScope);
    }
  }
  return out;
}

/**
 * OAuth 2.0 provider service (PROJECTPLAN.md §6.13, §14, V2-P12). Owns client
 * registration, the authorize/consent + token exchange flows, grant management,
 * and access-token resolution for the bearer middleware. Security invariants:
 * redirect URIs are exact-matched (never redirected to an unvalidated target),
 * public clients MUST use PKCE, codes are single-use + short-lived, refresh
 * tokens rotate and a replayed one revokes the whole grant, and revoking a grant
 * cuts off every token because the token lookup joins through the grant.
 */
export function createOAuthService(deps: OAuthServiceDeps): OAuthService {
  const { repo, audit, redis } = deps;
  const now = deps.now ?? (() => new Date());

  /** Shared authorize-request validation for both the consent read and approve. */
  async function validateAuthorize(input: {
    clientId: string;
    redirectUri: string;
    scope: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  }): Promise<{ client: OAuthClientRow; scopes: ApiKeyScope[] }> {
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

  function issueTokenPair(grantId: string, scopes: ApiKeyScope[]): Promise<OAuthTokenResponse> {
    const issued = now();
    const access = mint(OAUTH_ACCESS_TOKEN_PREFIX);
    const refresh = mint(OAUTH_REFRESH_TOKEN_PREFIX);
    const accessExpires = new Date(issued.getTime() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshExpires = new Date(issued.getTime() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000);
    return Promise.all([
      repo.createAccessToken({
        grantId,
        tokenHash: access.tokenHash,
        scopes,
        expiresAt: accessExpires,
      }),
      repo.createRefreshToken({ grantId, tokenHash: refresh.tokenHash, expiresAt: refreshExpires }),
    ]).then(() => ({
      access_token: access.token,
      token_type: 'Bearer' as const,
      expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refresh.token,
      scope: scopes.join(' '),
    }));
  }

  /** Resolve + authenticate the client on the token endpoint (confidential vs public). */
  async function authenticateClient(input: {
    clientId: string;
    clientSecret?: string;
  }): Promise<OAuthClientRow> {
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
    const clientId = `${OAUTH_CLIENT_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
    let clientSecret: string | null = null;
    let clientSecretHash: string | null = null;
    if (!input.isPublic) {
      const secret = mint(OAUTH_CLIENT_SECRET_PREFIX);
      clientSecret = secret.token;
      clientSecretHash = secret.tokenHash;
    }
    const row = await repo.createClient({
      userId: input.userId,
      clientId,
      name: input.name,
      clientSecretHash,
      redirectUris: input.redirectUris,
      scopes: input.scopes,
      isPublic: input.isPublic,
      isFirstParty: input.isFirstParty,
      // First-party apps render the BetterTrack mark, so a logo is never stored.
      logoUrl: input.isFirstParty ? null : (input.logoUrl ?? null),
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
        scopes: input.scopes,
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
      const row = await repo.deleteClient(userId, id);
      if (!row) {
        throw notFound('OAuth app not found.', 'OAUTH_CLIENT_NOT_FOUND');
      }
      await audit.record({
        actorId: userId,
        action: AuditAction.OAuthClientDeleted,
        targetType: 'oauth_client',
        targetId: row.id,
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
      const row = await repo.deleteFirstPartyClient(id);
      if (!row) {
        throw notFound('OAuth app not found.', 'OAUTH_CLIENT_NOT_FOUND');
      }
      await audit.record({
        actorId: adminId,
        action: AuditAction.OAuthClientDeleted,
        targetType: 'oauth_client',
        targetId: row.id,
        ip: ip ?? null,
      });
    },

    async listGrants(userId) {
      const rows = await repo.listGrantsForUser(userId);
      return rows.map(({ grant, client }) => ({
        id: grant.id,
        clientId: client.clientId,
        appName: client.name,
        scopes: grant.scopes as ApiKeyScope[],
        createdAt: grant.createdAt.toISOString(),
        lastUsedAt: grant.lastUsedAt ? grant.lastUsedAt.toISOString() : null,
      }));
    },

    async revokeGrant({ userId, id, ip }) {
      const row = await repo.revokeGrant(userId, id);
      if (!row) {
        throw notFound('Authorized app not found.', 'OAUTH_GRANT_NOT_FOUND');
      }
      await audit.record({
        actorId: userId,
        action: AuditAction.OAuthGrantRevoked,
        targetType: 'oauth_grant',
        targetId: row.id,
        ip: ip ?? null,
      });
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
          logoUrl: client.isFirstParty ? null : (client.logoUrl ?? null),
        },
        scopes: scopes.map((scope) => ({ scope, label: OAUTH_SCOPE_LABELS[scope] })),
        redirectUri: query.redirect_uri,
        state: query.state ?? null,
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

    async exchangeToken({ body, ip }) {
      if (body.grant_type === 'authorization_code') {
        return exchangeAuthorizationCode(body, ip ?? null);
      }
      return exchangeRefreshToken(body, ip ?? null);
    },

    async authenticateToken(token) {
      if (!token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return null;
      const found = await repo.findAccessTokenByHash(hashToken(token));
      if (!found) return null;
      if (found.token.expiresAt.getTime() <= now().getTime()) return null;

      // Throttle the grant lastUsedAt write, mirroring the personal-key path.
      const throttleKey = `oauth:touched:${found.grant.id}`;
      const first = await redis.set(throttleKey, '1', 'EX', LAST_USED_THROTTLE_SEC, 'NX');
      if (first === 'OK') {
        await repo.touchGrantLastUsed(found.grant.id, now());
      }
      return {
        user: found.user,
        grantId: found.grant.id,
        scopes: found.token.scopes as ApiKeyScope[],
      };
    },

    async recordScopeDenied({ userId, grantId, requiredScope, method, path, ip }) {
      await audit.record({
        actorId: userId,
        action: AuditAction.ApiKeyScopeDenied,
        targetType: 'oauth_grant',
        targetId: grantId,
        ip: ip ?? null,
        meta: { requiredScope, method, path, kind: 'oauth' },
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
    const found = await repo.findAuthCodeByHash(hashToken(body.code));
    // A code bound to a different client, or none, is an invalid grant.
    if (!found || found.clientId !== client.id) {
      throw badRequest('Invalid authorization code.', 'INVALID_GRANT');
    }
    if (found.redirectUri !== body.redirect_uri) {
      throw badRequest('redirect_uri does not match the authorization request.', 'INVALID_GRANT');
    }
    if (found.expiresAt.getTime() <= now().getTime()) {
      throw badRequest('Authorization code has expired.', 'INVALID_GRANT');
    }
    // PKCE verification (RFC 7636). A stored challenge demands a matching verifier.
    if (found.codeChallenge) {
      if (
        !body.code_verifier ||
        !safeEqual(sha256Base64Url(body.code_verifier), found.codeChallenge)
      ) {
        throw badRequest('PKCE verification failed.', 'INVALID_GRANT');
      }
    }
    // Single-use: the atomic consume is the guard against replay / double-spend.
    const consumed = await repo.consumeAuthCode(found.id);
    if (!consumed) {
      throw badRequest('Authorization code has already been used.', 'INVALID_GRANT');
    }
    const scopes = found.scopes as ApiKeyScope[];
    // Establish (or reuse) the grant for this app↔user pair.
    const existing = await repo.findActiveGrant(client.id, found.userId);
    let grantId: string;
    if (existing) {
      grantId = existing.id;
      await repo.updateGrantScopes(existing.id, scopes);
    } else {
      const grant = await repo.createGrant({ clientId: client.id, userId: found.userId, scopes });
      grantId = grant.id;
    }
    const tokens = await issueTokenPair(grantId, scopes);
    await audit.record({
      actorId: found.userId,
      action: AuditAction.OAuthTokenIssued,
      targetType: 'oauth_grant',
      targetId: grantId,
      ip,
      meta: { clientId: client.clientId, scopes },
    });
    return tokens;
  }

  async function exchangeRefreshToken(
    body: Extract<OAuthTokenRequest, { grant_type: 'refresh_token' }>,
    ip: string | null,
  ): Promise<OAuthTokenResponse> {
    const client = await authenticateClient({
      clientId: body.client_id,
      clientSecret: body.client_secret,
    });
    const found = await repo.findRefreshTokenByHash(hashToken(body.refresh_token));
    if (!found || found.grant.clientId !== client.id) {
      throw badRequest('Invalid refresh token.', 'INVALID_GRANT');
    }
    if (found.grant.revokedAt) {
      throw badRequest('This authorization has been revoked.', 'INVALID_GRANT');
    }
    // Replay of an already-rotated refresh token is treated as a compromise:
    // revoke the whole grant (RFC 6819 §5.2.2.3) and reject.
    if (found.token.consumedAt) {
      await repo.revokeGrant(found.grant.userId, found.grant.id);
      throw badRequest('Refresh token has already been used.', 'INVALID_GRANT');
    }
    if (found.token.expiresAt.getTime() <= now().getTime()) {
      throw badRequest('Refresh token has expired.', 'INVALID_GRANT');
    }
    const consumed = await repo.consumeRefreshToken(found.token.id);
    if (!consumed) {
      throw badRequest('Refresh token has already been used.', 'INVALID_GRANT');
    }
    const scopes = found.grant.scopes as ApiKeyScope[];
    const tokens = await issueTokenPair(found.grant.id, scopes);
    await repo.touchGrantLastUsed(found.grant.id, now());
    await audit.record({
      actorId: found.grant.userId,
      action: AuditAction.OAuthTokenRefreshed,
      targetType: 'oauth_grant',
      targetId: found.grant.id,
      ip,
      meta: { clientId: client.clientId },
    });
    return tokens;
  }
}

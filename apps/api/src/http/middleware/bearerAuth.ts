import type { Request, RequestHandler } from 'express';

import { scopeSatisfies } from '@bettertrack/contracts';

import { forbidden, notFound, unauthorized } from '../../errors';
import { toAuthUser } from '../serializers';
import type { AppContext } from '../context';

const BEARER_PREFIX = 'Bearer ';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Bearer auth for personal API keys AND delegated OAuth access tokens
 * (PROJECTPLAN.md §6.13, §14, V2-P12). Mounted first in the `/api/v1` chain:
 * when the request carries an `Authorization: Bearer …` header it resolves the
 * token — a personal key (`btk_…`) or an OAuth access token (`bto_…`) — to its
 * owning user and attaches `req.authUser` + `req.apiKey`, so cookie-session
 * middleware downstream stands down (it early-returns when `req.apiKey` is set).
 * A malformed / unknown / **revoked** token is a hard `401` — no fallthrough to
 * anonymous, since the caller clearly intended to authenticate. Both token kinds
 * enforce the same coarse scopes and are equally barred from admin endpoints.
 *
 * Requests with no bearer header pass straight through untouched, leaving the
 * session cookie path unchanged.
 */
export function loadBearerAuth(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    try {
      const header = req.get('authorization');
      if (!header || !header.startsWith(BEARER_PREFIX)) {
        next();
        return;
      }
      const token = header.slice(BEARER_PREFIX.length).trim();
      const keyPrincipal = await ctx.apiKeys.authenticate(token);
      if (keyPrincipal) {
        req.authUser = toAuthUser(keyPrincipal.user);
        req.apiKey = { id: keyPrincipal.keyId, scopes: keyPrincipal.scopes, kind: 'personal' };
        next();
        return;
      }
      const oauthPrincipal = await ctx.oauth.authenticateToken(token);
      if (oauthPrincipal) {
        req.authUser = toAuthUser(oauthPrincipal.user);
        req.apiKey = { id: oauthPrincipal.grantId, scopes: oauthPrincipal.scopes, kind: 'oauth' };
        next();
        return;
      }
      next(unauthorized('Invalid or revoked access token.', 'API_KEY_INVALID'));
    } catch (err) {
      next(err);
    }
  };
}

/** How a mount-relative path resolves for an API-key request. */
type PathPolicy =
  | { kind: 'allow' }
  | { kind: 'admin' }
  | { kind: 'session-only' }
  | { kind: 'scope'; read: string; write: string };

/** The scope gating the account-security surface (2FA, sessions, password, PIN). */
const ACCOUNT_SECURITY_SCOPE = 'account:security';

/**
 * Coarse per-module scope map (§6.13). Read scopes gate safe methods; write
 * scopes gate mutations. Read-only modules (market) carry a write scope string
 * no key can hold, so any mutation is denied *and audited* through the same path
 * as a genuine missing-scope. Anything not matched here is default-denied — a
 * new user router is unreachable by API key until it opts in.
 *
 * The `/settings` catch-all keeps the coarse account/profile bucket on the
 * social scope (unchanged since V2-P12); the more specific `/settings/notifications`
 * prefs route is remapped to the notifications scope in {@link resolvePolicy}
 * before this table is consulted (#361).
 */
const MODULE_POLICIES: readonly { prefix: string; read: string; write: string }[] = [
  { prefix: '/portfolios', read: 'portfolio:read', write: 'portfolio:write' },
  { prefix: '/custom-assets', read: 'portfolio:read', write: 'portfolio:write' },
  { prefix: '/workboard', read: 'workboard:read', write: 'workboard:write' },
  { prefix: '/conglomerates', read: 'workboard:read', write: 'workboard:write' },
  { prefix: '/backtest', read: 'workboard:read', write: 'workboard:write' },
  { prefix: '/assets', read: 'market:read', write: 'market:write' },
  { prefix: '/search', read: 'market:read', write: 'market:write' },
  // #361: `social:write` and `notifications:*` are now real, granularly-enforced
  // scopes. GET the notifications inbox needs `notifications:read`; mutating it
  // needs `notifications:write`; the social graph mutation needs `social:write`.
  { prefix: '/social', read: 'social:read', write: 'social:write' },
  { prefix: '/notifications', read: 'notifications:read', write: 'notifications:write' },
  // #396: friend chat (V3-P8) shipped without a row here, so every bearer
  // request to /chat/* fell through to the session-only default — a 403 no
  // matter which scopes the token held. Cookie sessions bypass this map, which
  // is why web chat worked and only bearer clients (mobile, #349) hit it.
  { prefix: '/chat', read: 'chat:read', write: 'chat:write' },
  { prefix: '/settings', read: 'social:read', write: 'social:write' },
];

/**
 * Bearer-callable sub-paths of the otherwise cookie-only `/auth/*` group (#361).
 * The unified web+mobile API exposes identity, self-service logout/revocation and
 * the account-security surface to a bearer; the rest of `/auth/*` (login,
 * register, password reset, invites, the login-2FA challenge) stays
 * cookie-session / public. `verify`/`email-code` are the public login-challenge
 * endpoints — excluded here so they never read as bearer-callable.
 */
function resolveAuthPolicy(path: string): PathPolicy | null {
  // Identity + self-service logout/self-revocation: any valid bearer, no scope.
  if (path === '/auth/me' || path === '/auth/logout') return { kind: 'allow' };
  // Public login-2FA challenge endpoints — never bearer (pending-token based).
  if (path === '/auth/2fa/verify' || path === '/auth/2fa/email-code') {
    return { kind: 'session-only' };
  }
  // Account-security surface, both safe + unsafe methods gated by one scope:
  // the session manager, password change, PIN status/verify/manage, and 2FA
  // management (enroll/confirm/disable/status/recovery-codes/email/*).
  const accountSecurity =
    path === '/auth/sessions' ||
    path.startsWith('/auth/sessions/') ||
    path === '/auth/change-password' ||
    path === '/auth/pin' ||
    path.startsWith('/auth/pin/') ||
    path.startsWith('/auth/2fa/');
  if (accountSecurity) {
    return { kind: 'scope', read: ACCOUNT_SECURITY_SCOPE, write: ACCOUNT_SECURITY_SCOPE };
  }
  // Any other /auth path (login, register, password-reset, invite, accept-invite,
  // /auth/session single, /auth/2fa bare) stays cookie-session / public.
  if (path === '/auth' || path.startsWith('/auth/')) return { kind: 'session-only' };
  return null;
}

function resolvePolicy(path: string): PathPolicy {
  // Admin is never reachable by API key regardless of scopes (account-kind
  // separation, §6.12) — 404 to disclose nothing.
  if (path === '/admin' || path.startsWith('/admin/')) return { kind: 'admin' };
  // /auth carve-outs (#361) — resolved before anything else in the group.
  const authPolicy = resolveAuthPolicy(path);
  if (authPolicy) return authPolicy;
  // Account lifecycle (#362): self-service deletion is part of the
  // account-security surface — the mobile in-app flow calls it with a bearer
  // holding `account:security` (deletion is additionally re-auth-gated).
  if (path === '/account' || path.startsWith('/account/')) {
    return { kind: 'scope', read: ACCOUNT_SECURITY_SCOPE, write: ACCOUNT_SECURITY_SCOPE };
  }
  // Key management + OAuth app/grant lifecycle are cookie-session only: a
  // delegated token must not mint/list/revoke keys, register OAuth apps or manage
  // grants (no privilege escalation). Checked before the `/settings` module
  // policy below, which would otherwise grant these to a social scope.
  if (path === '/settings/api-keys' || path.startsWith('/settings/api-keys/')) {
    return { kind: 'session-only' };
  }
  if (path === '/settings/oauth-clients' || path.startsWith('/settings/oauth-clients/')) {
    return { kind: 'session-only' };
  }
  if (path === '/settings/oauth-grants' || path.startsWith('/settings/oauth-grants/')) {
    return { kind: 'session-only' };
  }
  // Notification preferences live under /settings but belong to the notifications
  // scope (#361), checked before the coarse `/settings` → social catch-all.
  if (path === '/settings/notifications' || path.startsWith('/settings/notifications/')) {
    return { kind: 'scope', read: 'notifications:read', write: 'notifications:write' };
  }
  // The OAuth authorize/consent + token endpoints are never reachable with a
  // bearer token — consent is a cookie-session page, token exchange is public.
  if (path === '/oauth' || path.startsWith('/oauth/')) return { kind: 'session-only' };
  if (path === '/health' || path.startsWith('/health')) return { kind: 'allow' };
  for (const p of MODULE_POLICIES) {
    if (path === p.prefix || path.startsWith(`${p.prefix}/`)) {
      return { kind: 'scope', read: p.read, write: p.write };
    }
  }
  return { kind: 'session-only' };
}

/**
 * Whether a mount-relative `/api/v1` path accepts a bearer token at the auth
 * layer (a personal API key OR a delegated OAuth access token) — i.e. anything
 * that is `allow` (identity/logout/health) or scope-gated. Session-only and
 * admin paths do not. The OpenAPI document derives each route's `security`
 * requirement from this so the spec can never drift from the real middleware
 * policy (#361, fixes the doc's blanket sessionCookie-only claim). Method-
 * independent: a scope path accepts a bearer for both reads and writes (the
 * required scope differs, but acceptance does not).
 */
export function pathAcceptsBearer(path: string): boolean {
  const kind = resolvePolicy(path).kind;
  return kind === 'allow' || kind === 'scope';
}

/**
 * Scope enforcement for API-key requests (§6.13, V2-P12). A no-op for cookie
 * sessions (full access). For a bearer request it maps the path+method to the
 * required scope and rejects — with an audited `403 INSUFFICIENT_SCOPE` — when
 * the key lacks it; admin paths 404, and session-only paths (auth, key mgmt)
 * 403. `req.path` here is mount-relative (Express strips `/api/v1`).
 */
export function enforceApiKeyScope(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    if (!req.apiKey) {
      next();
      return;
    }
    const policy = resolvePolicy(req.path);
    if (policy.kind === 'admin') {
      next(notFound());
      return;
    }
    if (policy.kind === 'session-only') {
      next(forbidden('This endpoint is not accessible with an API key.', 'API_KEY_FORBIDDEN'));
      return;
    }
    if (policy.kind === 'allow') {
      next();
      return;
    }
    const required = SAFE_METHODS.has(req.method) ? policy.read : policy.write;
    // Write-implies-read (#371): a held `:write` satisfies the corresponding
    // `:read` requirement, so no read-only route is unreachable to a write-scoped
    // token. Enforced here at check time — the single authoritative point that
    // also covers tokens minted before the rule.
    if (scopeSatisfies(req.apiKey.scopes, required)) {
      next();
      return;
    }
    denyScope(ctx, req, required).then(
      () =>
        next(
          forbidden(`API key is missing the required scope "${required}".`, 'INSUFFICIENT_SCOPE'),
        ),
      next,
    );
  };
}

function denyScope(ctx: AppContext, req: Request, requiredScope: string): Promise<void> {
  const common = {
    userId: req.authUser!.id,
    requiredScope,
    method: req.method,
    path: req.path,
    ip: req.ip ?? null,
  };
  if (req.apiKey!.kind === 'oauth') {
    return ctx.oauth.recordScopeDenied({ ...common, grantId: req.apiKey!.id });
  }
  return ctx.apiKeys.recordScopeDenied({ ...common, keyId: req.apiKey!.id });
}

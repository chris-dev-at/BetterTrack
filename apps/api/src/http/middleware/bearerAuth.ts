import type { Request, RequestHandler } from 'express';

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

/**
 * Coarse per-module scope map (§6.13). Read scopes gate safe methods; write
 * scopes gate mutations. Read-only modules (market, social) carry a write scope
 * string no key can hold, so any mutation is denied *and audited* through the
 * same path as a genuine missing-scope. Anything not matched here is
 * default-denied — a new user router is unreachable by API key until it opts in.
 */
const MODULE_POLICIES: readonly { prefix: string; read: string; write: string }[] = [
  { prefix: '/portfolios', read: 'portfolio:read', write: 'portfolio:write' },
  { prefix: '/custom-assets', read: 'portfolio:read', write: 'portfolio:write' },
  { prefix: '/workboard', read: 'workboard:read', write: 'workboard:write' },
  { prefix: '/conglomerates', read: 'workboard:read', write: 'workboard:write' },
  { prefix: '/backtest', read: 'workboard:read', write: 'workboard:write' },
  { prefix: '/assets', read: 'market:read', write: 'market:write' },
  { prefix: '/search', read: 'market:read', write: 'market:write' },
  { prefix: '/social', read: 'social:read', write: 'social:write' },
  { prefix: '/notifications', read: 'social:read', write: 'social:write' },
  { prefix: '/settings', read: 'social:read', write: 'social:write' },
];

function resolvePolicy(path: string): PathPolicy {
  // Admin is never reachable by API key regardless of scopes (account-kind
  // separation, §6.12) — 404 to disclose nothing.
  if (path === '/admin' || path.startsWith('/admin/')) return { kind: 'admin' };
  // Key management + session lifecycle are cookie-session only: a delegated
  // token must not mint/list/revoke keys, register OAuth apps, manage grants, or
  // touch the session (no privilege escalation). Checked before the `/settings`
  // module policy below, which would otherwise grant these to a social scope.
  if (path === '/settings/api-keys' || path.startsWith('/settings/api-keys/')) {
    return { kind: 'session-only' };
  }
  if (path === '/settings/oauth-clients' || path.startsWith('/settings/oauth-clients/')) {
    return { kind: 'session-only' };
  }
  if (path === '/settings/oauth-grants' || path.startsWith('/settings/oauth-grants/')) {
    return { kind: 'session-only' };
  }
  // The OAuth authorize/consent + token endpoints are never reachable with a
  // bearer token — consent is a cookie-session page, token exchange is public.
  if (path === '/oauth' || path.startsWith('/oauth/')) return { kind: 'session-only' };
  if (path === '/auth' || path.startsWith('/auth/')) return { kind: 'session-only' };
  if (path === '/health' || path.startsWith('/health')) return { kind: 'allow' };
  for (const p of MODULE_POLICIES) {
    if (path === p.prefix || path.startsWith(`${p.prefix}/`)) {
      return { kind: 'scope', read: p.read, write: p.write };
    }
  }
  return { kind: 'session-only' };
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
    if (req.apiKey.scopes.includes(required)) {
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

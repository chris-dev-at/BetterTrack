import type { Request, RequestHandler } from 'express';

import { scopeSatisfies } from '@bettertrack/contracts';

import { forbidden, notFound, unauthorized } from '../../errors';
import {
  isParanoidKilledScope,
  PARANOID_MODE_ERROR_CODE,
} from '../../services/account/paranoidEnforcement';
import { normalizeRoutePath } from '../../services/security/routePath';
import { toAuthUser } from '../serializers';
import type { AppContext } from '../context';

const BEARER_PREFIX = 'Bearer ';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The single inherently read-write scope gating the paranoid-vault sync surface. */
export const VAULT_SYNC_SCOPE = 'vault:sync';

/**
 * How an allowlist entry's `{param}` placeholders match a live path segment.
 * Declared per entry rather than inferred from the placeholder's spelling, so a
 * later route whose id parameter happens to be named `{version}` cannot silently
 * change matching semantics for a shared helper.
 */
type RouteParamKind = 'uuid' | 'positive-integer';

/** One method + path template in a bearer allowlist. `param` defaults to `uuid`. */
interface BearerRoute {
  readonly method: string;
  readonly path: string;
  readonly param?: RouteParamKind;
}

/**
 * The sync-only bearer exception for the opaque paranoid vault (#1043).
 * `vault:sync` is inherently read-write, but the route surface remains
 * method-aware and default-closed: storage/media transitions and account-mode
 * transitions are deliberately absent from this list.
 */
export const VAULT_SYNC_BEARER_ROUTE_ALLOWLIST = [
  { method: 'GET', path: '/vault' },
  { method: 'PUT', path: '/vault' },
  { method: 'GET', path: '/vault/media' },
  { method: 'GET', path: '/vault/history' },
  { method: 'GET', path: '/vault/history/{version}', param: 'positive-integer' },
] as const satisfies readonly BearerRoute[];

/**
 * Vaults v2 (`docs/VAULTS_V2_DESIGN.md` §3): the SAME `vault:sync` exception,
 * widened from the account-singleton `/vault` routes to `{vaultId}`-scoped
 * ones. A sync client may enumerate the account's vaults (ids + names +
 * backends — the narrow projection the list route serves a bearer) and
 * GET/PUT each vault's opaque header and per-portfolio blobs under If-Match
 * CAS. Nothing else: every transition below is absent by design and the module
 * defaults closed, exactly like `/vault`.
 */
export const VAULTS_SYNC_BEARER_ROUTE_ALLOWLIST = [
  { method: 'GET', path: '/vaults' },
  { method: 'GET', path: '/vaults/{vaultId}/header' },
  { method: 'PUT', path: '/vaults/{vaultId}/header' },
  { method: 'GET', path: '/vaults/{vaultId}/common' },
  { method: 'PUT', path: '/vaults/{vaultId}/common' },
  { method: 'GET', path: '/vaults/{vaultId}/portfolios/{portfolioId}' },
  { method: 'PUT', path: '/vaults/{vaultId}/portfolios/{portfolioId}' },
] as const satisfies readonly BearerRoute[];

/**
 * Vaults v2 lifecycle routes that deliberately remain cookie-session-only.
 * Policy metadata for the mounted-route completeness census, not a second guard
 * — the guard is default-deny. `POST /vaults` shares its path with the
 * allowlisted `GET /vaults`, which is exactly why the matcher is method-aware.
 */
export const VAULTS_SESSION_ONLY_ROUTES = [
  { method: 'POST', path: '/vaults' },
  { method: 'PATCH', path: '/vaults/{vaultId}' },
  { method: 'DELETE', path: '/vaults/{vaultId}' },
  // The v1 → v2 migration protocol (design r2 §11). The flip is a one-way
  // commit that turns the legacy account vault into a read-only tombstone —
  // exactly the class of transition `/account/paranoid/*` already reserves for
  // the owning browser session.
  { method: 'GET', path: '/vaults/migration' },
  { method: 'POST', path: '/vaults/migration/claim' },
  { method: 'POST', path: '/vaults/migration/renew' },
  { method: 'POST', path: '/vaults/migration/flip' },
] as const satisfies readonly BearerRoute[];

/**
 * The two per-portfolio vault TRANSITIONS. They live under `/portfolios`, whose
 * module policy grants `portfolio:read`/`portfolio:write`, so without an
 * explicit rule ahead of `MODULE_POLICIES` a `portfolio:write` bearer would be
 * able to purge a portfolio's cleartext (join) or write a caller-authored
 * document back into the account (leave). Both are destructive, one-way-ish
 * transitions — the same class the account-level `/account/paranoid/*` routes
 * keep browser-session-only — so they are pinned session-only here.
 */
export const PORTFOLIO_VAULT_SESSION_ONLY_ROUTES = [
  { method: 'POST', path: '/portfolios/{portfolioId}/vault' },
  { method: 'DELETE', path: '/portfolios/{portfolioId}/vault' },
  // The vaulted-portfolio alias. Session-only like the transitions: it is the
  // one write that stays reachable while vaulted, and widening it to a bearer
  // would put the only writable surface of a vaulted portfolio on a token.
  { method: 'PATCH', path: '/portfolios/{portfolioId}/alias' },
] as const satisfies readonly BearerRoute[];

/**
 * The MIRRORCHAIN bearer surface: participation (#1042) plus administration
 * (mobile board #67 — the owner's fully-capable phone-management mandate,
 * owner-approved 2026-08-07). This list is method-aware because `GET /chains`
 * reads while `POST /chains` administers, and both operations share one path.
 * Reads require `mirrorchain:read`, every write `mirrorchain:write` (the
 * module policy row below); ownership/role checks for administration live in
 * the service layer and are identical to the cookie session. Anything under
 * `/mirrorchain` that is not listed here remains cookie-session-only and
 * default-closed.
 */
export const MIRRORCHAIN_BEARER_ROUTE_ALLOWLIST = [
  { method: 'GET', path: '/mirrorchain/chains' },
  { method: 'GET', path: '/mirrorchain/chains/{chainId}/members' },
  { method: 'GET', path: '/mirrorchain/chains/{chainId}/activity' },
  { method: 'GET', path: '/mirrorchain/invites' },
  { method: 'POST', path: '/mirrorchain/invites/{inviteId}/accept' },
  { method: 'POST', path: '/mirrorchain/invites/{inviteId}/decline' },
  { method: 'POST', path: '/mirrorchain/chains/{chainId}/leave' },
  { method: 'POST', path: '/mirrorchain/chains' },
  { method: 'POST', path: '/mirrorchain/chains/convert' },
  { method: 'POST', path: '/mirrorchain/invites/{inviteId}/revoke' },
  { method: 'POST', path: '/mirrorchain/chains/{chainId}/invites' },
  { method: 'PATCH', path: '/mirrorchain/chains/{chainId}' },
  { method: 'POST', path: '/mirrorchain/chains/{chainId}/transfer' },
  { method: 'DELETE', path: '/mirrorchain/chains/{chainId}' },
  {
    method: 'PATCH',
    path: '/mirrorchain/chains/{chainId}/members/{userId}/role',
  },
  { method: 'DELETE', path: '/mirrorchain/chains/{chainId}/members/{userId}' },
] as const satisfies readonly BearerRoute[];

/**
 * MIRRORCHAIN routes that deliberately remain cookie-session-only. Emptied by
 * the board-#67 widening (administration moved into the bearer allowlist
 * above), but the constant stays: the mounted-route completeness test compares
 * the real Express router against the allowlist + session-only union, so a
 * newly added route must still make an explicit access decision before CI can
 * pass. This is policy metadata, not a second guard — the guard above is
 * default-deny.
 */
export const MIRRORCHAIN_SESSION_ONLY_ROUTES: readonly BearerRoute[] = [];

/**
 * Vault storage/media mutations that are explicitly outside opaque bearer
 * synchronization. Kept beside the sync allowlist for the same mounted-route
 * completeness check used by MIRRORCHAIN.
 */
export const VAULT_SESSION_ONLY_ROUTES = [
  { method: 'PATCH', path: '/vault/media' },
  { method: 'PUT', path: '/vault/media/server-candidate' },
  { method: 'GET', path: '/vault/media/server-candidate/{candidateId}' },
  { method: 'POST', path: '/vault/media/retired/purge/challenge' },
  { method: 'POST', path: '/vault/media/retired/purge' },
] as const satisfies readonly BearerRoute[];

function normalizedRouteSegments(path: string): string[] {
  return normalizeRoutePath(path).split('/').filter(Boolean);
}

const UUID_ROUTE_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POSITIVE_INTEGER_ROUTE_SEGMENT = /^[1-9][0-9]*$/;

const ROUTE_PARAM_MATCHERS: Record<RouteParamKind, RegExp> = {
  uuid: UUID_ROUTE_SEGMENT,
  'positive-integer': POSITIVE_INTEGER_ROUTE_SEGMENT,
};

function matchesRoute(path: string, route: BearerRoute, allowPathTemplate = false): boolean {
  const actual = normalizedRouteSegments(path);
  const expected = normalizedRouteSegments(route.path);
  // The matcher comes from the allowlist entry, never from how the placeholder
  // happens to be spelled — renaming `{version}` cannot change what matches.
  const paramMatcher = ROUTE_PARAM_MATCHERS[route.param ?? 'uuid'];
  return (
    actual.length === expected.length &&
    expected.every((segment, index) => {
      const actualSegment = actual[index]!;
      if (segment.startsWith('{') && segment.endsWith('}')) {
        // Only the OpenAPI generator provides route templates. Live requests
        // carry real ids, so a literal `{param}` must never enter an allowlist.
        // Refusing arbitrary static words keeps a future same-depth admin route
        // from matching a parameter placeholder.
        return (allowPathTemplate && actualSegment === segment) || paramMatcher.test(actualSegment);
      }
      return segment === actualSegment;
    })
  );
}

function routeAllowlistAccepts(
  allowlist: readonly BearerRoute[],
  method: string,
  path: string,
  allowPathTemplate = false,
): boolean {
  const normalizedMethod = method.toUpperCase();
  return allowlist.some(
    (route) =>
      (route.method === normalizedMethod ||
        (normalizedMethod === 'HEAD' && route.method === 'GET')) &&
      matchesRoute(path, route, allowPathTemplate),
  );
}

/** Whether one exact method + path is in the paranoid-vault sync allowlist. */
export function vaultSyncRouteAcceptsBearer(method: string, path: string): boolean {
  return routeAllowlistAccepts(VAULT_SYNC_BEARER_ROUTE_ALLOWLIST, method, path);
}

/** Whether one exact method + path is in the Vaults v2 sync allowlist. */
export function vaultsSyncRouteAcceptsBearer(method: string, path: string): boolean {
  return routeAllowlistAccepts(VAULTS_SYNC_BEARER_ROUTE_ALLOWLIST, method, path);
}

/** Whether one exact method + path is in the MIRRORCHAIN bearer allowlist. */
export function mirrorchainRouteAcceptsBearer(method: string, path: string): boolean {
  return routeAllowlistAccepts(MIRRORCHAIN_BEARER_ROUTE_ALLOWLIST, method, path);
}

/**
 * Local defense-in-depth for the mirrorchain router. The global policy makes
 * the same decision before routing, but keeping this default-deny allowlist on
 * the router means a remount or policy-table reshuffle cannot expose a new
 * administrative route to a bearer by accident.
 */
export const enforceMirrorchainBearerAllowlist: RequestHandler = (req, _res, next) => {
  if (
    !req.apiKey ||
    mirrorchainRouteAcceptsBearer(req.method, `/mirrorchain${req.path === '/' ? '' : req.path}`)
  ) {
    next();
    return;
  }
  next(forbidden('This endpoint is not accessible with an API key.', 'API_KEY_FORBIDDEN'));
};

/**
 * Bearer auth for personal API keys AND delegated OAuth access tokens
 * (PROJECTPLAN.md §6.13, §14, V2-P12). Mounted first in the `/api/v1` chain:
 * when the request carries an `Authorization: Bearer …` header it resolves the
 * token — a personal key (`btk_…`) or an OAuth access token (`bto_…`) — to its
 * owning user and attaches `req.authUser` + `req.apiKey`, so cookie-session
 * middleware downstream stands down (it early-returns when `req.apiKey` is set).
 * A malformed / unknown / **revoked** or suspended-account token is a hard `401`
 * — no fallthrough to anonymous, since the caller clearly intended to
 * authenticate. Both token kinds enforce the same coarse scopes and are equally
 * barred from admin endpoints.
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
      // Services make this status check at their credential choke points; retain
      // it at the HTTP attachment boundary as a defense-in-depth assertion.
      if (keyPrincipal?.user.status === 'active') {
        req.authUser = toAuthUser(keyPrincipal.user);
        req.apiKey = {
          id: keyPrincipal.keyId,
          scopes: keyPrincipal.scopes,
          kind: 'personal',
          securityGeneration: keyPrincipal.user.securityGeneration,
          // Carry the resolved per-key tier onto the request so the rate-limit
          // middleware can read (limit, windowSec) from it — without this the
          // limiter falls back to the config default and tier assignment has no
          // effect end-to-end (§13.5 V5-P10).
          rateLimit: keyPrincipal.rateLimit,
        };
        next();
        return;
      }
      const oauthPrincipal = await ctx.oauth.authenticateToken(token);
      if (oauthPrincipal?.user.status === 'active') {
        req.authUser = toAuthUser(oauthPrincipal.user);
        req.apiKey = {
          id: oauthPrincipal.grantId,
          scopes: oauthPrincipal.scopes,
          kind: 'oauth',
          securityGeneration: oauthPrincipal.user.securityGeneration,
        };
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
  // Standing orders (§13.5 V5-P6b) manage recurring portfolio writes — the same
  // scope pair as /portfolios, declared so the module never default-denies.
  { prefix: '/standing-orders', read: 'portfolio:read', write: 'portfolio:write' },
  // Broker CSV imports (§13.4 V4-P8) stage + apply portfolio data — the same
  // scope pair as /portfolios, declared here so the module never falls through
  // to the session-only default (the #396/#405 gap class).
  { prefix: '/imports', read: 'portfolio:read', write: 'portfolio:write' },
  // Analytics deep-dive (§13.3 V3-P9) reads portfolio-derived series/stats — a
  // read-only surface, but declared with the portfolio scope pair so it never
  // falls through to the session-only default (the #396/#405 gap class).
  { prefix: '/analytics', read: 'portfolio:read', write: 'portfolio:write' },
  { prefix: '/workboard', read: 'workboard:read', write: 'workboard:write' },
  { prefix: '/conglomerates', read: 'workboard:read', write: 'workboard:write' },
  { prefix: '/backtest', read: 'workboard:read', write: 'workboard:write' },
  // Ideas (§13.4 V4-P9) are a Workboard surface — a saved Workboard analysis —
  // so they gate on the same workboard scope pair as conglomerates/backtest.
  { prefix: '/ideas', read: 'workboard:read', write: 'workboard:write' },
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
  // #405: price alerts (V3-P10) shipped without a row here — the same gap class
  // as chat (#396). Every bearer request to /alerts/* fell through to the
  // session-only default (403 API_KEY_FORBIDDEN regardless of scope), so the
  // mobile app could never reach alerts. Cookie sessions bypass this map, which
  // is why web alerts worked and only bearer clients hit it.
  { prefix: '/alerts', read: 'alerts:read', write: 'alerts:write' },
  // #1041: cash classification (tags, budgets, rules, summaries and trends)
  // is a distinct mobile module. Movement/source ledger CRUD remains under the
  // existing /portfolios policy; this row admits only the /cash/* surface.
  { prefix: '/cash', read: 'cash:read', write: 'cash:write' },
  // #1042: group-portfolio participation has its own scope pair. The explicit
  // method + route allowlist in resolvePolicy keeps lifecycle administration
  // session-only even though the module itself is now scope-addressable.
  { prefix: '/mirrorchain', read: 'mirrorchain:read', write: 'mirrorchain:write' },
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
  // the session manager, password change, PIN status/verify/manage, 2FA
  // management (enroll/confirm/disable/status/recovery-codes/email/*), and the
  // Google link status + unlink (§13.4 V4-P4b). The Google start/callback
  // redirects stay session/public (they fall through to the default below).
  const accountSecurity =
    path === '/auth/sessions' ||
    path.startsWith('/auth/sessions/') ||
    path === '/auth/change-password' ||
    path === '/auth/pin' ||
    path.startsWith('/auth/pin/') ||
    path.startsWith('/auth/2fa/') ||
    path === '/auth/google/link-status' ||
    path === '/auth/google/unlink';
  if (accountSecurity) {
    return { kind: 'scope', read: ACCOUNT_SECURITY_SCOPE, write: ACCOUNT_SECURITY_SCOPE };
  }
  // Any other /auth path (login, register, password-reset, invite, accept-invite,
  // /auth/session single, /auth/2fa bare) stays cookie-session / public.
  if (path === '/auth' || path.startsWith('/auth/')) return { kind: 'session-only' };
  return null;
}

function resolvePolicy(
  requestPath: string,
  requestMethod = 'GET',
  allowPathTemplate = false,
): PathPolicy {
  // Express routes case-insensitively by default, so `/Account/Paranoid/enable`
  // reaches the very same handler as the lowercase spelling. Match the same way,
  // or a variant-cased request silently resolves to a DIFFERENT policy than the
  // route it actually reaches — skipping past a restricting rule onto the
  // coarser prefix above it (`app.ts` normalizes its body-parser deferral for
  // exactly this reason). Every literal in this table is lowercase, so folding
  // case can only align a rule with the route Express picked.
  const path = requestPath.toLowerCase();
  // Admin is never reachable by API key regardless of scopes (account-kind
  // separation, §6.12) — 404 to disclose nothing.
  if (path === '/admin' || path.startsWith('/admin/')) return { kind: 'admin' };
  // /auth carve-outs (#361) — resolved before anything else in the group.
  const authPolicy = resolveAuthPolicy(path);
  if (authPolicy) return authPolicy;
  // Paranoid mode transitions (§13.5 V5-P13) are strictly browser-cookie-session
  // only — the same rule as `/vault/*` below, for a strictly stronger reason.
  // Enable is a one-way destructive purge of every cleartext row plus every
  // outbound and inbound share, and a Drive-only media set carries no
  // server-verifiable evidence at all: the caller's own attestation IS the whole
  // input. Disable writes a caller-authored document back into the account. So
  // neither direction may ride a personal API key or a delegated OAuth token
  // holding `account:security` (plausible for a sessions/2FA integration), which
  // also carries no CSRF header. Checked BEFORE the `/account/` branch, which
  // would otherwise fold both routes into that coarse account-security scope.
  if (path === '/account/paranoid' || path.startsWith('/account/paranoid/')) {
    return { kind: 'session-only' };
  }
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
  // Outbound webhook management (§13.5 V5-P10) is cookie-session only, like key
  // management: a delegated token must not create/list/delete webhooks or read
  // their signing-secret lifecycle. Checked before the `/settings` catch-all.
  if (path === '/settings/webhooks' || path.startsWith('/settings/webhooks/')) {
    return { kind: 'session-only' };
  }
  // Tax year locking (§16 2026-08-07): the unlock ritual re-verifies the
  // account password and re-opens a legally-settled year — strictly a
  // browser-cookie-session act, never a bearer's (no delegated token or
  // personal key may unlock, re-lock, or even read the lock surface).
  // Checked before the `/settings` module catch-all below, which would
  // otherwise fold these under the social scope.
  if (path === '/settings/taxes/years' || path.startsWith('/settings/taxes/years/')) {
    return { kind: 'session-only' };
  }
  // #1043: native clients may synchronize the already-encrypted vault with the
  // single inherently read-write vault:sync scope. The exact method-aware
  // allowlist admits the live blob, media-state read and conflict-history reads
  // only. Staging, media transitions, retirement and purge stay browser-session
  // work, and any future /vault route defaults closed.
  if (path === '/vault' || path.startsWith('/vault/')) {
    return routeAllowlistAccepts(
      VAULT_SYNC_BEARER_ROUTE_ALLOWLIST,
      requestMethod,
      path,
      allowPathTemplate,
    )
      ? { kind: 'scope', read: VAULT_SYNC_SCOPE, write: VAULT_SYNC_SCOPE }
      : { kind: 'session-only' };
  }
  // Vaults v2 (`docs/VAULTS_V2_DESIGN.md` §3): the same `vault:sync` exception
  // on the `{vaultId}`-scoped surface. Method-aware because `GET /vaults`
  // synchronizes while `POST /vaults` creates, and both share one path. An
  // unlisted route — including every future one — defaults closed.
  if (path === '/vaults' || path.startsWith('/vaults/')) {
    return routeAllowlistAccepts(
      VAULTS_SYNC_BEARER_ROUTE_ALLOWLIST,
      requestMethod,
      path,
      allowPathTemplate,
    )
      ? { kind: 'scope', read: VAULT_SYNC_SCOPE, write: VAULT_SYNC_SCOPE }
      : { kind: 'session-only' };
  }
  // The per-portfolio vault transitions. Resolved BEFORE the `/portfolios`
  // module row below, which would otherwise fold a one-way purge and a
  // caller-authored restore into the coarse `portfolio:write` scope.
  if (
    routeAllowlistAccepts(
      PORTFOLIO_VAULT_SESSION_ONLY_ROUTES,
      requestMethod,
      path,
      allowPathTemplate,
    )
  ) {
    return { kind: 'session-only' };
  }
  // MIRRORCHAIN is participation-over-administration for bearer clients
  // (#1042). Resolve the method-aware allowlist BEFORE MODULE_POLICIES: an
  // unlisted route defaults closed instead of inheriting mirrorchain:write.
  if (
    (path === '/mirrorchain' || path.startsWith('/mirrorchain/')) &&
    !routeAllowlistAccepts(
      MIRRORCHAIN_BEARER_ROUTE_ALLOWLIST,
      requestMethod,
      path,
      allowPathTemplate,
    )
  ) {
    return { kind: 'session-only' };
  }
  // Rule preview is intentionally a read despite using POST: it evaluates a
  // caller-supplied note without writing anything. Resolve it before the /cash
  // module row so cash:read can use the preview while every other POST/PATCH/
  // PUT/DELETE under /cash continues to require cash:write.
  if (path === '/cash/rules/preview' || path === '/cash/rules/preview/') {
    return { kind: 'scope', read: 'cash:read', write: 'cash:read' };
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
 * policy (#361, fixes the doc's blanket sessionCookie-only claim). Usually the
 * method only changes the required read/write half; the MIRRORCHAIN participation
 * allowlist is intentionally method-aware because reads and administration can
 * share a path.
 */
export function pathAcceptsBearer(path: string, method = 'GET'): boolean {
  const kind = resolvePolicy(path, method).kind;
  return kind === 'allow' || kind === 'scope';
}

/**
 * Template-aware bearer-policy lookup reserved for the OpenAPI generator.
 * Live request paths must use {@link pathAcceptsBearer}, which rejects literal
 * `{param}` segments rather than treating them as an allowlisted resource id.
 */
export function openApiPathTemplateAcceptsBearer(path: string, method = 'GET'): boolean {
  const kind = resolvePolicy(path, method, true).kind;
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
    const policy = resolvePolicy(req.path, req.method);
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
    if (req.authUser?.privacyMode === 'paranoid' && isParanoidKilledScope(required)) {
      next(
        forbidden(
          'This API scope is unavailable while paranoid mode is active.',
          PARANOID_MODE_ERROR_CODE,
        ),
      );
      return;
    }
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

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

/**
 * Native account-security clients may manage existing passkeys, but they may
 * not enter either WebAuthn ceremony. Keeping the three management operations
 * in an exact method + path allowlist means registration, public sign-in and
 * every future `/auth/passkeys/*` route remain closed to bearer credentials.
 */
export const PASSKEY_MANAGEMENT_BEARER_ROUTE_ALLOWLIST = [
  { method: 'GET', path: '/auth/passkeys' },
  { method: 'PATCH', path: '/auth/passkeys/{id}' },
  { method: 'DELETE', path: '/auth/passkeys/{id}' },
] as const satisfies readonly BearerRoute[];

/** The account-level tax-documentation list exposed to native clients. */
export const TAX_YEAR_DOCUMENTATION_BEARER_ROUTE_ALLOWLIST = [
  { method: 'GET', path: '/settings/taxes/years' },
] as const satisfies readonly BearerRoute[];

/**
 * The exact grant-management routes a trusted first-party OAuth client may use.
 * Everything else under `/settings/oauth-grants` remains cookie-session-only.
 */
export const OAUTH_GRANT_FIRST_PARTY_BEARER_ROUTE_ALLOWLIST = [
  { method: 'GET', path: '/settings/oauth-grants' },
  { method: 'DELETE', path: '/settings/oauth-grants/{id}' },
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

/** Whether one exact method + path is in the MIRRORCHAIN bearer allowlist. */
export function mirrorchainRouteAcceptsBearer(method: string, path: string): boolean {
  return routeAllowlistAccepts(MIRRORCHAIN_BEARER_ROUTE_ALLOWLIST, method, path);
}

/** Whether one exact method + path is an existing-passkey management route. */
export function passkeyManagementRouteAcceptsBearer(method: string, path: string): boolean {
  return routeAllowlistAccepts(PASSKEY_MANAGEMENT_BEARER_ROUTE_ALLOWLIST, method, path);
}

/** Whether one exact method + path is the tax-year documentation read. */
export function taxYearDocumentationRouteAcceptsBearer(method: string, path: string): boolean {
  return routeAllowlistAccepts(TAX_YEAR_DOCUMENTATION_BEARER_ROUTE_ALLOWLIST, method, path);
}

/** Whether one live grant-management request is in the first-party bearer allowlist. */
export function oauthGrantRouteAcceptsBearer(method: string, path: string): boolean {
  return routeAllowlistAccepts(
    OAUTH_GRANT_FIRST_PARTY_BEARER_ROUTE_ALLOWLIST,
    method,
    path.toLowerCase(),
  );
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
          // A btk_ credential is not an OAuth client. It must stay false so a
          // personal key cannot reopen credential-management escalation by
          // enumerating or revoking the account's delegated grants.
          firstParty: false,
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
          firstParty: oauthPrincipal.firstParty,
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
  | { kind: 'session-only'; bearerMessage?: string }
  | { kind: 'scope'; read: string; write: string; firstPartyOnly?: true };

export type BearerModulePolicy =
  | {
      readonly prefix: `/${string}`;
      readonly kind: 'scope';
      readonly read: string;
      readonly write: string;
    }
  | {
      readonly prefix: `/${string}`;
      readonly kind: 'allow' | 'admin' | 'session-only';
      readonly reason: string;
    };

/** The scope gating account-security state shared by the web and native clients. */
export const ACCOUNT_SECURITY_SCOPE = 'account:security';

/**
 * Explicit bearer classification for every top-level API module mounted by
 * `app.ts`. Read scopes gate safe methods; write scopes gate mutations.
 * Read-only modules (market) carry a write scope string no key can hold, so any
 * mutation is denied *and audited* through the same path as a genuine missing
 * scope. Session-only entries are deliberate defaults; exact route carve-outs
 * (auth, vault sync, tax-year documentation) resolve before this table.
 *
 * The `/settings` catch-all keeps the coarse account/profile bucket on the
 * social scope (unchanged since V2-P12); the more specific `/settings/notifications`
 * prefs route is remapped to the notifications scope in {@link resolvePolicy}
 * before this table is consulted (#361).
 *
 * This table is also consumed by the real-app mount census in
 * `checkOpenapiCoverage.ts`. Do not add a second classification list: runtime
 * enforcement, generated OpenAPI bearer security and the completeness gate all
 * depend on these entries.
 */
export const MODULE_POLICIES = [
  {
    prefix: '/version',
    kind: 'allow',
    reason:
      'Deployment metadata is mounted before authentication and is public; its census row changed pathAcceptsBearer("/version") from false to true with no observable effect.',
  },
  {
    prefix: '/health',
    kind: 'allow',
    reason: 'Liveness and readiness probes are mounted before authentication and are public.',
  },
  {
    prefix: '/feature-flags',
    kind: 'session-only',
    reason: 'The SPA bootstrap flag map has no bearer scope in the current catalog.',
  },
  {
    prefix: '/auth',
    kind: 'session-only',
    reason: 'Authentication defaults closed; native account-security carve-outs resolve first.',
  },
  {
    prefix: '/account',
    kind: 'scope',
    read: ACCOUNT_SECURITY_SCOPE,
    write: ACCOUNT_SECURITY_SCOPE,
  },
  {
    prefix: '/admin',
    kind: 'admin',
    reason: 'User bearer credentials never cross the admin account-kind boundary.',
  },
  { prefix: '/workboard', kind: 'scope', read: 'workboard:read', write: 'workboard:write' },
  { prefix: '/search', kind: 'scope', read: 'market:read', write: 'market:write' },
  { prefix: '/assets', kind: 'scope', read: 'market:read', write: 'market:write' },
  { prefix: '/portfolios', kind: 'scope', read: 'portfolio:read', write: 'portfolio:write' },
  {
    prefix: '/custom-assets',
    kind: 'scope',
    read: 'portfolio:read',
    write: 'portfolio:write',
  },
  // Standing orders (§13.5 V5-P6b) manage recurring portfolio writes — the same
  // scope pair as /portfolios, declared so the module never default-denies.
  {
    prefix: '/standing-orders',
    kind: 'scope',
    read: 'portfolio:read',
    write: 'portfolio:write',
  },
  // Broker CSV imports (§13.4 V4-P8) stage + apply portfolio data — the same
  // scope pair as /portfolios, declared here so the module never falls through
  // to the session-only default (the #396/#405 gap class).
  { prefix: '/imports', kind: 'scope', read: 'portfolio:read', write: 'portfolio:write' },
  // Analytics deep-dive (§13.3 V3-P9) reads portfolio-derived series/stats — a
  // read-only surface, but declared with the portfolio scope pair so it never
  // falls through to the session-only default (the #396/#405 gap class).
  { prefix: '/analytics', kind: 'scope', read: 'portfolio:read', write: 'portfolio:write' },
  {
    prefix: '/conglomerates',
    kind: 'scope',
    read: 'workboard:read',
    write: 'workboard:write',
  },
  { prefix: '/backtest', kind: 'scope', read: 'workboard:read', write: 'workboard:write' },
  // Ideas (§13.4 V4-P9) are a Workboard surface — a saved Workboard analysis —
  // so they gate on the same workboard scope pair as conglomerates/backtest.
  { prefix: '/ideas', kind: 'scope', read: 'workboard:read', write: 'workboard:write' },
  // #1315/#1338/#1339: explicit feedback scopes keep capture, caller-owned
  // status history and nested support-thread routes out of the session-only
  // fallback that caused the recurring API_KEY_FORBIDDEN module-policy gap.
  // Reads remain separate from `feedback:write`: submission/thread history must
  // not be granted silently by capture/reply access.
  { prefix: '/feedback', kind: 'scope', read: 'feedback:read', write: 'feedback:write' },
  {
    prefix: '/expenses',
    kind: 'session-only',
    reason: 'The superseded read-only expense surface has no bearer scope classification.',
  },
  // #361: `social:write` and `notifications:*` are now real, granularly-enforced
  // scopes. GET the notifications inbox needs `notifications:read`; mutating it
  // needs `notifications:write`; the social graph mutation needs `social:write`.
  { prefix: '/social', kind: 'scope', read: 'social:read', write: 'social:write' },
  {
    prefix: '/notifications',
    kind: 'scope',
    read: 'notifications:read',
    write: 'notifications:write',
  },
  // #396: friend chat (V3-P8) shipped without a row here, so every bearer
  // request to /chat/* fell through to the session-only default — a 403 no
  // matter which scopes the token held. Cookie sessions bypass this map, which
  // is why web chat worked and only bearer clients (mobile, #349) hit it.
  { prefix: '/chat', kind: 'scope', read: 'chat:read', write: 'chat:write' },
  // #405: price alerts (V3-P10) shipped without a row here — the same gap class
  // as chat (#396). Every bearer request to /alerts/* fell through to the
  // session-only default (403 API_KEY_FORBIDDEN regardless of scope), so the
  // mobile app could never reach alerts. Cookie sessions bypass this map, which
  // is why web alerts worked and only bearer clients hit it.
  { prefix: '/alerts', kind: 'scope', read: 'alerts:read', write: 'alerts:write' },
  // #1041: cash classification (tags, budgets, rules, summaries and trends)
  // is a distinct mobile module. Movement/source ledger CRUD remains under the
  // existing /portfolios policy; this row admits only the /cash/* surface.
  { prefix: '/cash', kind: 'scope', read: 'cash:read', write: 'cash:write' },
  // #1042: group-portfolio participation has its own scope pair. The explicit
  // method + route allowlist in resolvePolicy keeps lifecycle administration
  // session-only even though the module itself is now scope-addressable.
  {
    prefix: '/mirrorchain',
    kind: 'scope',
    read: 'mirrorchain:read',
    write: 'mirrorchain:write',
  },
  {
    prefix: '/ai',
    kind: 'session-only',
    reason: 'AI capability and generation endpoints have no bearer scope in the current catalog.',
  },
  { prefix: '/settings', kind: 'scope', read: 'social:read', write: 'social:write' },
  {
    prefix: '/vault',
    kind: 'session-only',
    reason: 'Vault storage defaults closed; the exact vault:sync allowlist resolves first.',
  },
  {
    prefix: '/oauth',
    kind: 'session-only',
    reason: 'Consent is session-bound and token exchange is handled on the public pre-guard rail.',
  },
] as const satisfies readonly BearerModulePolicy[];

/**
 * Bearer-callable sub-paths of the otherwise cookie-only `/auth/*` group (#361).
 * The unified web+mobile API exposes identity, self-service logout/revocation and
 * the account-security surface to a bearer; the rest of `/auth/*` (login,
 * register, password reset, invites, the login-2FA challenge) stays
 * cookie-session / public. `verify`/`email-code` are the public login-challenge
 * endpoints — excluded here so they never read as bearer-callable.
 */
function resolveAuthPolicy(
  path: string,
  requestMethod: string,
  allowPathTemplate: boolean,
): PathPolicy | null {
  // Identity + self-service logout/self-revocation: any valid bearer, no scope.
  if (path === '/auth/me' || path === '/auth/logout') return { kind: 'allow' };
  // Public login-2FA challenge endpoints — never bearer (pending-token based).
  if (path === '/auth/2fa/verify' || path === '/auth/2fa/email-code') {
    return { kind: 'session-only' };
  }
  // Existing-passkey management is native-callable, but only through this
  // method-aware allowlist. Registration and login ceremonies — plus unknown
  // future passkey routes — deliberately fall through to session-only below.
  if (
    routeAllowlistAccepts(
      PASSKEY_MANAGEMENT_BEARER_ROUTE_ALLOWLIST,
      requestMethod,
      path,
      allowPathTemplate,
    )
  ) {
    return { kind: 'scope', read: ACCOUNT_SECURITY_SCOPE, write: ACCOUNT_SECURITY_SCOPE };
  }
  // First-run completion is set-once, idempotent account state. Only the real
  // POST route is widened; another method on the same path remains closed.
  if (path === '/auth/first-run/complete' && requestMethod.toUpperCase() === 'POST') {
    return { kind: 'scope', read: ACCOUNT_SECURITY_SCOPE, write: ACCOUNT_SECURITY_SCOPE };
  }
  // The native Google LINK start is authenticated account-security state
  // (#1328). Admit only the exact POST; the public Google return leg carries no
  // bearer, and the legacy `/auth/google/start` must keep demoting bearers to an
  // anonymous sign-in intent rather than inheriting this exception.
  if (path === '/auth/google/link/start' && requestMethod.toUpperCase() === 'POST') {
    return { kind: 'scope', read: ACCOUNT_SECURITY_SCOPE, write: ACCOUNT_SECURITY_SCOPE };
  }
  // The singular mint route is intentionally browser-only: its only useful
  // result is a signed `bt_rdid` cookie in the browser / Custom-Tab jar that will
  // run the next OAuth login. A bearer would put that cookie on the app's own
  // HTTP client and strand the binding. Native clients manage existing bindings
  // through the plural account-security surface below (#1327).
  if (path === '/auth/remembered-device' && requestMethod.toUpperCase() === 'POST') {
    return {
      kind: 'session-only',
      bearerMessage:
        'Remembering a device requires a browser session so the cookie reaches the browser used for OAuth login.',
    };
  }
  // Account-security surface, both safe + unsafe methods gated by one scope:
  // the session manager, password change, PIN status/verify/manage, 2FA
  // management (enroll/confirm/disable/status/recovery-codes/email/*), and the
  // Google link status + unlink (§13.4 V4-P4b). The legacy Google start/callback
  // redirects and the new public native callback fall through to the default.
  const accountSecurity =
    path === '/auth/sessions' ||
    path.startsWith('/auth/sessions/') ||
    path === '/auth/remembered-devices' ||
    path.startsWith('/auth/remembered-devices/') ||
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
  // /auth/session single, /auth/2fa bare) falls through to the module's explicit
  // session-only default.
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
  // /auth carve-outs (#361) — resolved before anything else in the group.
  const authPolicy = resolveAuthPolicy(path, requestMethod, allowPathTemplate);
  if (authPolicy) return authPolicy;
  // Paranoid mode transitions (§13.5 V5-P13) are strictly browser-cookie-session
  // only — the same rule as `/vault/*` below, for a strictly stronger reason.
  // Enable is a one-way destructive purge of every cleartext row plus every
  // outbound and inbound share, and a Drive-only media set carries no
  // server-verifiable evidence at all: the caller's own attestation IS the whole
  // input. Disable writes a caller-authored document back into the account. So
  // neither direction may ride a personal API key or a delegated OAuth token
  // holding `account:security` (plausible for a sessions/2FA integration), which
  // also carries no CSRF header. Checked BEFORE the `/account` module policy,
  // which would otherwise fold both routes into that coarse account-security scope.
  if (path === '/account/paranoid' || path.startsWith('/account/paranoid/')) {
    return { kind: 'session-only' };
  }
  // Key management + OAuth app registration remain cookie-session only: a
  // delegated token must not mint/list/revoke keys or register OAuth apps. Grant
  // management has one narrower exception below for trusted first-party clients.
  // Checked before the `/settings` module policy, which would otherwise grant
  // these credential routes to a social scope.
  if (path === '/settings/api-keys' || path.startsWith('/settings/api-keys/')) {
    return { kind: 'session-only' };
  }
  if (path === '/settings/oauth-clients' || path.startsWith('/settings/oauth-clients/')) {
    return { kind: 'session-only' };
  }
  if (
    routeAllowlistAccepts(
      OAUTH_GRANT_FIRST_PARTY_BEARER_ROUTE_ALLOWLIST,
      requestMethod,
      path,
      allowPathTemplate,
    )
  ) {
    return {
      kind: 'scope',
      read: ACCOUNT_SECURITY_SCOPE,
      write: ACCOUNT_SECURITY_SCOPE,
      firstPartyOnly: true,
    };
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
  // Tax-year documentation is account state shared by web and native clients.
  // Keep an exact read-only allowlist so a future sibling cannot inherit access
  // from this carve-out or the `/settings` social-scope catch-all below.
  if (path === '/settings/taxes/years' || path.startsWith('/settings/taxes/years/')) {
    return routeAllowlistAccepts(
      TAX_YEAR_DOCUMENTATION_BEARER_ROUTE_ALLOWLIST,
      requestMethod,
      path,
      allowPathTemplate,
    )
      ? { kind: 'scope', read: ACCOUNT_SECURITY_SCOPE, write: ACCOUNT_SECURITY_SCOPE }
      : { kind: 'session-only' };
  }
  // #1043: native clients may synchronize the already-encrypted vault with the
  // single inherently read-write vault:sync scope. The exact method-aware
  // allowlist admits the live blob, media-state read and conflict-history reads
  // only. Staging, media transitions, retirement and purge stay browser-session
  // work, and any future /vault route defaults closed.
  if (
    (path === '/vault' || path.startsWith('/vault/')) &&
    routeAllowlistAccepts(VAULT_SYNC_BEARER_ROUTE_ALLOWLIST, requestMethod, path, allowPathTemplate)
  ) {
    return { kind: 'scope', read: VAULT_SYNC_SCOPE, write: VAULT_SYNC_SCOPE };
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
  for (const p of MODULE_POLICIES) {
    if (path === p.prefix || path.startsWith(`${p.prefix}/`)) {
      return p.kind === 'scope'
        ? { kind: 'scope', read: p.read, write: p.write }
        : { kind: p.kind };
    }
  }
  return { kind: 'session-only' };
}

/**
 * Whether a mount-relative `/api/v1` path accepts at least one bearer token at
 * the auth layer — i.e. anything that is `allow` (identity/logout/health) or
 * scope-gated. A scope policy may additionally restrict the bearer to a trusted
 * first-party OAuth client. Session-only and admin paths do not. The OpenAPI
 * document derives each route's `security`
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
    // Bearer credentials are a user-app rail. An account promoted to admin may
    // still have a not-yet-revoked personal key or OAuth grant; disclose no
    // user surface to that principal, just as `/admin/*` discloses nothing to a
    // bearer regardless of its scopes.
    if (req.authUser?.role === 'admin') {
      next(notFound());
      return;
    }
    const policy = resolvePolicy(req.path, req.method);
    if (policy.kind === 'admin') {
      next(notFound());
      return;
    }
    if (policy.kind === 'session-only') {
      next(
        forbidden(
          policy.bearerMessage ?? 'This endpoint is not accessible with an API key.',
          'API_KEY_FORBIDDEN',
        ),
      );
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
    if (!scopeSatisfies(req.apiKey.scopes, required)) {
      denyScope(ctx, req, required).then(
        () =>
          next(
            forbidden(`API key is missing the required scope "${required}".`, 'INSUFFICIENT_SCOPE'),
          ),
        next,
      );
      return;
    }
    if (policy.firstPartyOnly && !req.apiKey.firstParty) {
      // Scope is deliberately checked first: a first-party client missing the
      // contractually required scope gets actionable INSUFFICIENT_SCOPE. Once a
      // token does hold it, this trust-boundary refusal says only that the route
      // is first-party-only — it does not imply scope alone would ever suffice.
      // Reuse the established audited denial rail: probing another app's grants
      // is a credential-boundary event the account owner must be able to trace.
      denyScope(ctx, req, required).then(
        () =>
          next(
            forbidden(
              'This endpoint is available to first-party OAuth clients only.',
              'API_KEY_FORBIDDEN',
            ),
          ),
        next,
      );
      return;
    }
    next();
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

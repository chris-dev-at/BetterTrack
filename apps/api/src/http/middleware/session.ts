import type { RequestHandler } from 'express';

import { ADMIN_2FA_SETUP_REQUIRED } from '@bettertrack/contracts';

import { adminAccountKind, forbidden, notFound, unauthorized } from '../../errors';
import type { AppContext } from '../context';
import { toAuthUser } from '../serializers';

/**
 * Resolves the session cookie into `req.authUser` without rejecting — public
 * routes still work. Deliberately does not mutate the response cookie: a request
 * that resolved an old session before a concurrent security rotation may finish
 * afterward, and its stale Set-Cookie/clear-cookie header must not overwrite the
 * a concurrent transition response. Explicit login, renewal, security-transition
 * clearing, and logout handlers own every session-cookie write.
 */
export function loadSession(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    try {
      // A bearer (API-key) request already resolved its principal upstream and
      // carries no session — never let a stray cookie override it (§6.13).
      if (req.apiKey) {
        next();
        return;
      }
      const sessionId = req.signedCookies?.[ctx.config.cookie.name] as unknown;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        next();
        return;
      }
      // Pass the request's User-Agent so the session manager can stamp
      // last-seen (throttled) and capture the device on first-seen (V3-P11a).
      const resolved = await ctx.auth.resolveSession(sessionId, req.get('user-agent') ?? null);
      if (!resolved) {
        next();
        return;
      }
      req.sessionId = sessionId;
      req.sessionSecurityGeneration = resolved.securityGeneration;
      // Carry the session's persistence (V4-P2b) so explicit renewal handlers
      // re-issue the SAME cookie flavour (Max-Age for persistent,
      // browser-session for ephemeral) rather than silently upgrading it.
      req.sessionPersistent = resolved.persistent;
      req.authUser = toAuthUser(resolved.user);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.authUser) {
    next(unauthorized());
    return;
  }
  next();
};

/**
 * User-app endpoints. Requires a session (401 otherwise) and rejects admin-kind
 * sessions: account kinds are disjoint, so an administrator has no portfolio,
 * workboard, assets, search or social surface (PROJECTPLAN.md §3, §5.5, §10).
 * The rejection is a pointed `403 ADMIN_ACCOUNT_KIND` sending them to the admin
 * area — never a 404, unlike the reverse guard, because an authenticated admin
 * already knows that area exists.
 */
export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.authUser) {
    next(unauthorized());
    return;
  }
  if (req.authUser.role === 'admin') {
    next(adminAccountKind());
    return;
  }
  next();
};

/**
 * Endpoints reachable while `mustChangePassword` is true (paths relative to the
 * `/api/v1` mount). The change-password flow and logout must work; login and
 * the invite validate/accept endpoints are public and never carry a
 * forced-change session, but are listed so the guard is mounted globally with
 * an explicit allowlist rather than each router opting in.
 */
const PASSWORD_CHANGE_EXEMPT: ReadonlySet<string> = new Set([
  '/auth/login',
  '/auth/logout',
  '/auth/change-password',
  '/auth/accept-invite',
]);

const isPasswordChangeExempt = (path: string): boolean =>
  PASSWORD_CHANGE_EXEMPT.has(path) || path.startsWith('/auth/invite/');

/**
 * Forced password change (§6.1): a user with `mustChangePassword=true` gets
 * `403 PASSWORD_CHANGE_REQUIRED` on every `/api/v1` route except the exempt
 * auth endpoints above. Mounted once, globally — so future routers cannot
 * accidentally skip the guard. `req.path` here is mount-relative (Express
 * strips the `/api/v1` prefix), e.g. `/auth/me`, `/admin/users`.
 */
export const enforcePasswordChange: RequestHandler = (req, _res, next) => {
  if (req.authUser?.mustChangePassword && !isPasswordChangeExempt(req.path)) {
    next(forbidden('Password change required.', 'PASSWORD_CHANGE_REQUIRED'));
    return;
  }
  next();
};

/** Admin-only. Non-admins (and anonymous) get a 404 — no route disclosure (§6.12). */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  // Personal API keys can never reach the admin surface, regardless of scopes
  // (§6.12, §6.13) — a bare 404, like any non-admin, discloses nothing.
  if (req.apiKey || !req.authUser || req.authUser.role !== 'admin') {
    next(notFound());
    return;
  }
  next();
};

/**
 * Mandatory current-session admin MFA gate (§6.12, #400, #878). Account-wide
 * enrollment is not assurance: every non-bootstrap admin request must resolve
 * the exact cookie again and find a password first factor plus a second-factor
 * method/time on that server-side session. `allowBootstrap` admits only a
 * password-authenticated, unassured session while the account has no factor, so
 * the first enrollment wizard remains deployable without widening any later
 * factor-management route.
 */
export function requireAdminTwoFactor(
  ctx: AppContext,
  options: { allowBootstrap?: boolean } = {},
): RequestHandler {
  return async (req, _res, next) => {
    try {
      // requireAdmin already ran; be defensive if the mount order ever changes.
      if (req.apiKey || !req.authUser || req.authUser.role !== 'admin') {
        next();
        return;
      }
      if (!req.sessionId) {
        next(unauthorized());
        return;
      }

      // Re-resolve the exact server-side session at the final authorization
      // boundary. Besides validating expiry/generation again, this prevents a
      // request from inheriting assurance that another browser established
      // after `loadSession` ran.
      const resolved = await ctx.auth.resolveSession(req.sessionId);
      const authorization = await ctx.twoFactor.getAuthorizationState(req.authUser.id);
      if (
        !resolved ||
        resolved.user.id !== req.authUser.id ||
        resolved.user.role !== 'admin' ||
        resolved.authenticationMethod !== 'password' ||
        !authorization ||
        req.sessionSecurityGeneration === undefined ||
        resolved.securityGeneration !== req.sessionSecurityGeneration ||
        authorization.securityGeneration !== resolved.securityGeneration
      ) {
        next(unauthorized());
        return;
      }

      if (!authorization.enabled) {
        if (options.allowBootstrap && resolved.mfaAssurance === null) {
          next();
          return;
        }
        next(
          forbidden(
            'Two-factor authentication setup is required for admin accounts.',
            ADMIN_2FA_SETUP_REQUIRED,
          ),
        );
        return;
      }

      if (resolved.mfaAssurance) {
        next();
        return;
      }
      next(unauthorized());
    } catch (err) {
      next(err);
    }
  };
}

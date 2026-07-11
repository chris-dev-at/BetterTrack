import type { RequestHandler } from 'express';

import { adminAccountKind, forbidden, notFound, unauthorized } from '../../errors';
import type { AppContext } from '../context';
import { clearSessionCookie, setSessionCookie } from '../cookies';
import { toAuthUser } from '../serializers';

/**
 * Resolves the session cookie into `req.authUser` without rejecting — public
 * routes still work. Invalid/expired sessions are cleared; valid ones get a
 * rolling cookie + Redis TTL refresh.
 */
export function loadSession(ctx: AppContext): RequestHandler {
  return async (req, res, next) => {
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
        clearSessionCookie(res, ctx.config);
        next();
        return;
      }
      req.sessionId = sessionId;
      // Carry the session's persistence (V4-P2b) so the rolling cookie refresh
      // below — and the PIN-verify handler — re-issue the SAME cookie flavour
      // (Max-Age for persistent, browser-session for ephemeral) rather than
      // silently upgrading an ephemeral session to a persistent cookie.
      req.sessionPersistent = resolved.persistent;
      req.authUser = toAuthUser(resolved.user);
      setSessionCookie(res, ctx.config, sessionId, resolved.persistent);
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

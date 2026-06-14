import type { RequestHandler } from 'express';

import { forbidden, notFound, unauthorized } from '../../errors';
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
      const sessionId = req.signedCookies?.[ctx.config.cookie.name] as unknown;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        next();
        return;
      }
      const user = await ctx.auth.resolveSession(sessionId);
      if (!user) {
        clearSessionCookie(res, ctx.config);
        next();
        return;
      }
      req.sessionId = sessionId;
      req.authUser = toAuthUser(user);
      setSessionCookie(res, ctx.config, sessionId);
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

/** Forced password change (§6.1): block everything but change-password/logout. */
export const enforcePasswordChange: RequestHandler = (req, _res, next) => {
  if (req.authUser?.mustChangePassword) {
    next(forbidden('Password change required.', 'PASSWORD_CHANGE_REQUIRED'));
    return;
  }
  next();
};

/** Admin-only. Non-admins (and anonymous) get a 404 — no route disclosure (§6.12). */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.authUser || req.authUser.role !== 'admin') {
    next(notFound());
    return;
  }
  next();
};

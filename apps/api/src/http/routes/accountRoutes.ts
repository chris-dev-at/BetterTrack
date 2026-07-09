import { Router } from 'express';

import { deleteAccountRequestSchema, type DeleteAccountRequest } from '@bettertrack/contracts';

import { clearSessionCookie } from '../cookies';
import { requireUser } from '../middleware/session';
import { validateBody } from '../middleware/validate';
import type { RateLimiters } from '../middleware/rateLimit';
import type { AppContext } from '../context';

/**
 * Account-lifecycle endpoints (PROJECTPLAN.md §13.4 V4-P2c, #362). One route:
 * self-service account deletion — the shared capability behind the web deletion
 * page (`/account/delete`, the public URL Google Play requires) and the mobile
 * in-app flow (bearer with `account:security`, mapped in the bearer policy).
 *
 * User-kind only, and rate-limited on the login schedule (per-IP) because it
 * re-verifies a credential; the service adds its own per-account throttle.
 */
export function createAccountRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.delete(
    '/',
    requireUser,
    limiters.login,
    validateBody(deleteAccountRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as DeleteAccountRequest;
      await ctx.accountDeletion.deleteAccount({ userId: req.authUser!.id, body, ip: req.ip });
      // The session store is already empty; clear the cookie for the web caller
      // (a bearer caller's credential rows died with the user).
      clearSessionCookie(res, ctx.config);
      res.json({ ok: true });
    },
  );

  return router;
}

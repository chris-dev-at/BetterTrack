import { Router } from 'express';

import {
  acceptInviteRequestSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  tokenParamSchema,
  type AcceptInviteRequest,
  type ChangePasswordRequest,
  type LoginRequest,
} from '@bettertrack/contracts';

import { clearSessionCookie, setSessionCookie } from '../cookies';
import { enforcePasswordChange, requireAuth } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { RateLimiters } from '../middleware/rateLimit';
import { toMeResponse, toMeResponseFromRow } from '../serializers';
import type { AppContext } from '../context';

/** Auth endpoints (PROJECTPLAN.md §6.1, §8). Controllers stay thin. */
export function createAuthRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.post('/login', limiters.login, validateBody(loginRequestSchema), async (req, res) => {
    const body = req.valid?.body as LoginRequest;
    const { user, sessionId } = await ctx.auth.login({
      identifier: body.identifier,
      password: body.password,
      ip: req.ip,
      currentSessionId: req.sessionId,
    });
    setSessionCookie(res, ctx.config, sessionId);
    res.json(toMeResponseFromRow(user));
  });

  router.post('/logout', async (req, res) => {
    if (req.sessionId) await ctx.auth.logout(req.sessionId);
    clearSessionCookie(res, ctx.config);
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, enforcePasswordChange, (req, res) => {
    res.json(toMeResponse(req.authUser!));
  });

  router.post(
    '/change-password',
    requireAuth,
    validateBody(changePasswordRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as ChangePasswordRequest;
      const { user, sessionId } = await ctx.auth.changePassword(req.authUser!.id, body, req.ip);
      setSessionCookie(res, ctx.config, sessionId);
      res.json(toMeResponseFromRow(user));
    },
  );

  router.get('/invite/:token', validateParams(tokenParamSchema), async (req, res) => {
    const { token } = req.valid?.params as { token: string };
    res.json(await ctx.auth.validateInvite(token));
  });

  router.post('/accept-invite', validateBody(acceptInviteRequestSchema), async (req, res) => {
    const body = req.valid?.body as AcceptInviteRequest;
    const { user, sessionId } = await ctx.auth.acceptInvite(body, req.ip);
    setSessionCookie(res, ctx.config, sessionId);
    res.status(201).json(toMeResponseFromRow(user));
  });

  return router;
}

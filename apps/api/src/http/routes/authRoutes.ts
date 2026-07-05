import { Router } from 'express';

import {
  acceptInviteRequestSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  pinVerifyRequestSchema,
  registerRequestSchema,
  setPinLockRequestSchema,
  setPinRequestSchema,
  tokenParamSchema,
  type AcceptInviteRequest,
  type ChangePasswordRequest,
  type LoginRequest,
  type PasswordResetComplete,
  type PasswordResetRequest,
  type PinVerifyRequest,
  type RegisterRequest,
  type SetPinLockRequest,
  type SetPinRequest,
} from '@bettertrack/contracts';

import { unauthorized } from '../../errors';
import { clearSessionCookie, setSessionCookie } from '../cookies';
import { requireAuth } from '../middleware/session';
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

  // The global enforcePasswordChange guard (mounted on /api/v1) blocks
  // mustChangePassword users here before this handler runs.
  router.get('/me', requireAuth, (req, res) => {
    res.json(toMeResponse(req.authUser!));
  });

  // Read-only view of the caller's *own* current session (§6.11 Security):
  // when they signed in and when the fixed 30-day window lapses. No TTL/renew
  // side effects — this only reads req.sessionId's record.
  router.get('/session', requireAuth, async (req, res) => {
    const info = await ctx.auth.getSessionInfo(req.sessionId!);
    if (!info) throw unauthorized();
    res.json(info);
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

  // ── PIN gate (§6.1, §8) ────────────────────────────────────────────────────
  // Verify is rate-limited on the login schedule (per-IP) since it is a
  // credential check; the auth service also falls the session back to full
  // login after 5 consecutive wrong PINs.
  router.post(
    '/pin/verify',
    requireAuth,
    limiters.login,
    validateBody(pinVerifyRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as PinVerifyRequest;
      const user = await ctx.auth.verifyPin({
        userId: req.authUser!.id,
        sessionId: req.sessionId!,
        pin: body.pin,
        ip: req.ip,
      });
      // The 30-day window was renewed; refresh the cookie's max-age to match.
      setSessionCookie(res, ctx.config, req.sessionId!);
      res.json(toMeResponseFromRow(user));
    },
  );

  // Enable or change the PIN.
  router.put('/pin', requireAuth, validateBody(setPinRequestSchema), async (req, res) => {
    const body = req.valid?.body as SetPinRequest;
    const user = await ctx.auth.setPin(req.authUser!.id, body.pin, req.ip);
    res.json(toMeResponseFromRow(user));
  });

  // Disable the PIN.
  router.delete('/pin', requireAuth, async (req, res) => {
    const user = await ctx.auth.disablePin(req.authUser!.id, req.ip);
    res.json(toMeResponseFromRow(user));
  });

  // Set (or clear with null) the AFK auto-lock idle timeout (§6.1, §13.2 V2-P2).
  // A UI preference only — it never renews or shortens the session.
  router.put(
    '/pin/idle-timeout',
    requireAuth,
    validateBody(setPinLockRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as SetPinLockRequest;
      const user = await ctx.auth.setPinLockIdleMinutes(req.authUser!.id, body.idleMinutes, req.ip);
      res.json(toMeResponseFromRow(user));
    },
  );

  router.get('/invite/:token', validateParams(tokenParamSchema), async (req, res) => {
    const { token } = req.valid?.params as { token: string };
    res.json(await ctx.auth.validateInvite(token));
  });

  // Public self-serve registration (§4, §6.12). Enforcement plumbing: the
  // service reads the stored registration mode and, in V1's `closed` mode,
  // rejects with 403 REGISTRATION_CLOSED — this is the "hand-crafted register
  // call" the P8 gate blocks. Admin-created users and invites are unaffected.
  router.post(
    '/register',
    limiters.login,
    validateBody(registerRequestSchema),
    async (req, res) => {
      const { user, sessionId } = await ctx.auth.register(
        req.valid?.body as RegisterRequest,
        req.ip,
      );
      setSessionCookie(res, ctx.config, sessionId);
      res.status(201).json(toMeResponseFromRow(user));
    },
  );

  // Self-service password reset (§6.1, §14, §13.2 V2-P4). Both steps are public
  // and rate-limited on the login schedule (per-IP). Request always returns the
  // same generic ack — no user enumeration; complete lands the user signed in.
  router.post(
    '/password-reset/request',
    limiters.login,
    validateBody(passwordResetRequestSchema),
    async (req, res) => {
      await ctx.auth.requestPasswordReset(req.valid?.body as PasswordResetRequest, req.ip);
      res.json({ ok: true });
    },
  );

  router.post(
    '/password-reset/complete',
    limiters.login,
    validateBody(passwordResetCompleteSchema),
    async (req, res) => {
      const { user, sessionId } = await ctx.auth.completePasswordReset(
        req.valid?.body as PasswordResetComplete,
        req.ip,
      );
      setSessionCookie(res, ctx.config, sessionId);
      res.json(toMeResponseFromRow(user));
    },
  );

  router.post('/accept-invite', validateBody(acceptInviteRequestSchema), async (req, res) => {
    const body = req.valid?.body as AcceptInviteRequest;
    const { user, sessionId } = await ctx.auth.acceptInvite(body, req.ip);
    setSessionCookie(res, ctx.config, sessionId);
    res.status(201).json(toMeResponseFromRow(user));
  });

  return router;
}

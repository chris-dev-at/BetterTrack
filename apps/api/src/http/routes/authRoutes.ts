import { Router } from 'express';

import {
  acceptInviteRequestSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  pinVerifyRequestSchema,
  registerRequestSchema,
  sessionHandleParamSchema,
  setPinLockRequestSchema,
  setPinRequestSchema,
  tokenParamSchema,
  twoFactorConfirmRequestSchema,
  twoFactorDisableRequestSchema,
  twoFactorEmailCodeRequestSchema,
  twoFactorEmailConfirmRequestSchema,
  twoFactorVerifyRequestSchema,
  type AcceptInviteRequest,
  type ChangePasswordRequest,
  type LoginRequest,
  type PasswordResetComplete,
  type PasswordResetRequest,
  type PinVerifyRequest,
  type RegisterRequest,
  type SetPinLockRequest,
  type SetPinRequest,
  type TwoFactorConfirmRequest,
  type TwoFactorDisableRequest,
  type TwoFactorEmailCodeRequest,
  type TwoFactorEmailConfirmRequest,
  type TwoFactorVerifyRequest,
} from '@bettertrack/contracts';

import { notFound, unauthorized } from '../../errors';
import { clearSessionCookie, setSessionCookie } from '../cookies';
import { requireAuth, requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { RateLimiters } from '../middleware/rateLimit';
import { toMeResponse, toMeResponseFromRow } from '../serializers';
import type { AppContext } from '../context';

/** Auth endpoints (PROJECTPLAN.md §6.1, §8). Controllers stay thin. */
export function createAuthRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.post('/login', limiters.login, validateBody(loginRequestSchema), async (req, res) => {
    const body = req.valid?.body as LoginRequest;
    const result = await ctx.auth.login({
      identifier: body.identifier,
      password: body.password,
      ip: req.ip,
      currentSessionId: req.sessionId,
    });
    // 2FA on: no session cookie yet — hand back the challenge so the SPA can
    // collect a second factor (§6.1, §13.2 V2-P5).
    if (result.status === 'two_factor_required') {
      res.json({ twoFactorRequired: true, ...result.challenge });
      return;
    }
    setSessionCookie(res, ctx.config, result.sessionId);
    res.json(toMeResponseFromRow(result.user));
  });

  // ── Login 2FA challenge (§6.1, §13.2 V2-P5) ─────────────────────────────────
  // Public, per-IP rate-limited on the login schedule: they complete the login
  // flow for an account with 2FA on. Neither honours a session — they act only on
  // the short-lived pending token from /login. Verify a valid factor to promote
  // the challenge to a real session; email-code requests a one-time code.
  router.post(
    '/2fa/verify',
    limiters.login,
    validateBody(twoFactorVerifyRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as TwoFactorVerifyRequest;
      const { user, sessionId } = await ctx.auth.verifyTwoFactor({
        pendingToken: body.pendingToken,
        code: body.code,
        recoveryCode: body.recoveryCode,
        ip: req.ip,
      });
      setSessionCookie(res, ctx.config, sessionId);
      res.json(toMeResponseFromRow(user));
    },
  );

  router.post(
    '/2fa/email-code',
    limiters.login,
    validateBody(twoFactorEmailCodeRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as TwoFactorEmailCodeRequest;
      await ctx.auth.requestTwoFactorEmailCode(body.pendingToken, req.ip);
      res.json({ ok: true });
    },
  );

  // Logout is the unified sign-out for both clients (§6.1, §6.13, #361). A cookie
  // session is destroyed and its cookie cleared. A **bearer** principal instead
  // self-revokes the credential it presented — the personal API key, or (for a
  // delegated OAuth token) its whole grant, which instantly kills that grant's
  // access + refresh tokens (server-side revocation, not just a local wipe). No
  // scope is required beyond a valid token: you may always revoke yourself.
  router.post('/logout', async (req, res) => {
    if (req.apiKey) {
      const userId = req.authUser!.id;
      const ip = req.ip ?? null;
      if (req.apiKey.kind === 'oauth') {
        await ctx.oauth.revokeGrant({ userId, id: req.apiKey.id, ip });
      } else {
        await ctx.apiKeys.revoke({ userId, id: req.apiKey.id, ip });
      }
      res.json({ ok: true });
      return;
    }
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

  // ── Session manager (§6.1, §6.11 Security, V3-P11a) ─────────────────────────
  // The caller's own active sessions + revocation. Cookie-session only: the
  // whole `/auth/*` group is bearer-forbidden (§6.13), so an API-key/OAuth
  // principal gets 403 API_KEY_FORBIDDEN before reaching these — a user only
  // ever sees/revokes their OWN sessions.
  router.get('/sessions', requireAuth, async (req, res) => {
    const sessions = await ctx.auth.listSessions(req.authUser!.id, req.sessionId ?? null);
    res.json({ sessions });
  });

  // Revoke one session ("log out that device"). Revoking your own current
  // session clears the cookie for a clean logout; an unknown handle is a 404.
  router.delete(
    '/sessions/:id',
    requireAuth,
    validateParams(sessionHandleParamSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const { revoked, wasCurrent } = await ctx.auth.revokeSession(
        req.authUser!.id,
        id,
        req.sessionId ?? null,
      );
      if (!revoked) throw notFound();
      if (wasCurrent) clearSessionCookie(res, ctx.config);
      res.json({ ok: true });
    },
  );

  // Log out every other device, keeping the caller signed in on this session.
  router.post('/sessions/revoke-others', requireAuth, async (req, res) => {
    const revoked = await ctx.auth.revokeOtherSessions(req.authUser!.id, req.sessionId ?? null);
    res.json({ revoked });
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

  // ── PIN gate (§6.1, §8, #361) ──────────────────────────────────────────────
  // Status: whether a web PIN is set, so a client (the mobile app-lock) can hide
  // "Use my BetterTrack PIN" until one exists. Callable by cookie session or by a
  // bearer holding `account:security`; both read the caller's own flag only.
  router.get('/pin/status', requireAuth, (req, res) => {
    res.json({ pinSet: req.authUser!.pinEnabled });
  });

  // Verify is rate-limited on the login schedule (per-IP) since it is a
  // credential check. The cookie path renews the session and falls back to full
  // login after 5 consecutive wrong PINs; the bearer path (#361) has no session,
  // so it reuses the SAME pin_hash verify under a per-account brute-force throttle
  // and returns a bare `{ ok: true }` — the app-lock reuses the one web PIN.
  router.post(
    '/pin/verify',
    requireAuth,
    limiters.login,
    validateBody(pinVerifyRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as PinVerifyRequest;
      if (req.apiKey) {
        await ctx.auth.verifyPinForToken({ userId: req.authUser!.id, pin: body.pin, ip: req.ip });
        res.json({ ok: true });
        return;
      }
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

  // ── Two-factor auth — two methods (§6.1, §13.2 V2-P5, #298) ─────────────────
  // All 2FA endpoints are user-kind only: `requireUser` 401s the anonymous and
  // 403s admin-kind sessions (§3, §5.5). Two independently-toggleable methods:
  // the authenticator app (TOTP: enroll/confirm/disable) and email codes
  // (email/enroll/confirm/disable), sharing recovery codes + status.
  router.post('/2fa/enroll', requireUser, async (req, res) => {
    res.json(await ctx.twoFactor.enrollTotp(req.authUser!.id, req.ip));
  });

  // Cancel a pending (unconfirmed) TOTP enrollment (#401). Armed 2FA is
  // untouchable here — 409 when TOTP is already on, 404 when nothing is pending.
  // Session + bearer (`account:security`, gated by the /auth/2fa/ policy in
  // bearerAuth); rate-limited by the shared /api/v1 limiter like its siblings.
  router.delete('/2fa/enroll', requireUser, async (req, res) => {
    await ctx.twoFactor.cancelTotpEnrollment(req.authUser!.id, req.ip);
    res.json({ ok: true });
  });

  router.post(
    '/2fa/confirm',
    requireUser,
    validateBody(twoFactorConfirmRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as TwoFactorConfirmRequest;
      res.json(await ctx.twoFactor.confirmTotp(req.authUser!.id, body.code, req.ip));
    },
  );

  router.post(
    '/2fa/disable',
    requireUser,
    validateBody(twoFactorDisableRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as TwoFactorDisableRequest;
      await ctx.twoFactor.disableTotp(req.authUser!.id, body.code, req.ip);
      res.json({ ok: true });
    },
  );

  // Email-code method (#298): enroll sends a mailbox-proof code, confirm turns it
  // on (blocked with TWO_FACTOR_EMAIL_UNAVAILABLE when SMTP is off), disable turns
  // it off from the authenticated session alone.
  router.post('/2fa/email/enroll', requireUser, async (req, res) => {
    await ctx.twoFactor.startEmailEnrollment(req.authUser!.id, req.ip);
    res.json({ ok: true });
  });

  router.post(
    '/2fa/email/confirm',
    requireUser,
    validateBody(twoFactorEmailConfirmRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as TwoFactorEmailConfirmRequest;
      res.json(await ctx.twoFactor.confirmEmail(req.authUser!.id, body.code, req.ip));
    },
  );

  router.post('/2fa/email/disable', requireUser, async (req, res) => {
    await ctx.twoFactor.disableEmail(req.authUser!.id, req.ip);
    res.json({ ok: true });
  });

  router.get('/2fa/status', requireUser, async (req, res) => {
    res.json(await ctx.twoFactor.status(req.authUser!.id));
  });

  router.post('/2fa/recovery-codes', requireUser, async (req, res) => {
    res.json(await ctx.twoFactor.regenerateRecoveryCodes(req.authUser!.id, req.ip));
  });

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
      const result = await ctx.auth.completePasswordReset(
        req.valid?.body as PasswordResetComplete,
        req.ip,
      );
      // A 2FA-enabled account gets a pending challenge instead of a session —
      // the emailed link alone must not defeat the second factor (§6.1).
      if (result.status === 'two_factor_required') {
        res.json({ twoFactorRequired: true, ...result.challenge });
        return;
      }
      setSessionCookie(res, ctx.config, result.sessionId);
      res.json(toMeResponseFromRow(result.user));
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

import { Router, type Request } from 'express';

import {
  acceptInviteRequestSchema,
  changePasswordRequestSchema,
  googleRegisterRequestSchema,
  googleUnlinkRequestSchema,
  loginRequestSchema,
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  pinQuickAuthRequestSchema,
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
  type GoogleRegisterRequest,
  type GoogleUnlinkRequest,
  type LoginRequest,
  type PasswordResetComplete,
  type PasswordResetRequest,
  type PinQuickAuthRequest,
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

import { ApiError, badRequest, notFound, unauthorized } from '../../errors';
import {
  clearGoogleOAuthStateCookie,
  clearGoogleRegisterTicketCookie,
  clearRememberedDeviceCookie,
  clearSessionCookie,
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_REGISTER_TICKET_COOKIE,
  REMEMBERED_DEVICE_COOKIE,
  setGoogleOAuthStateCookie,
  setGoogleRegisterTicketCookie,
  setRememberedDeviceCookie,
  setSessionCookie,
} from '../cookies';
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
      // "Stay signed in" + OAuth-flow persistence rules (V4-P2b, §399 §A).
      staySignedIn: body.staySignedIn,
      oauthLogin: body.oauthLogin,
    });
    // 2FA on: no session cookie yet — hand back the challenge so the SPA can
    // collect a second factor (§6.1, §13.2 V2-P5).
    if (result.status === 'two_factor_required') {
      res.json({ twoFactorRequired: true, ...result.challenge });
      return;
    }
    setSessionCookie(res, ctx.config, result.sessionId, result.persistent);
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
      const { user, sessionId, persistent } = await ctx.auth.verifyTwoFactor({
        pendingToken: body.pendingToken,
        code: body.code,
        recoveryCode: body.recoveryCode,
        ip: req.ip,
      });
      setSessionCookie(res, ctx.config, sessionId, persistent);
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

  // Promote the caller's current session to persistent — the OAuth-login "stay
  // signed in — your PIN protects this" choice, made post-credential-entry once
  // the PIN is known (V4-P2b, §399 §A). Cookie-session only (a bearer is 403'd by
  // the /auth session-only policy); the service PIN-gates it so a PIN-less
  // account can never turn its forced-ephemeral OAuth session persistent.
  router.post('/session/persist', requireAuth, async (req, res) => {
    if (!req.sessionId) throw unauthorized();
    await ctx.auth.persistCurrentSession(req.authUser!.id, req.sessionId);
    setSessionCookie(res, ctx.config, req.sessionId, true);
    res.json({ ok: true });
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
      const { user, sessionId, persistent } = await ctx.auth.changePassword(
        req.authUser!.id,
        body,
        req.ip,
      );
      setSessionCookie(res, ctx.config, sessionId, persistent);
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
      // The window was renewed; refresh the cookie, keeping this session's
      // flavour (persistent Max-Age vs browser-session) — PIN verify never
      // changes persistence (V4-P2b).
      setSessionCookie(res, ctx.config, req.sessionId!, req.sessionPersistent ?? true);
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

  // ── OAuth account memory + PIN quick re-auth (§16, owner spec #399 §B, V4-P2b) ──
  // The remembered-device binding rides a signed httpOnly `bt_rdid` cookie; read it
  // from the signed-cookie jar (cookie-parser drops a tampered value), never the
  // body — the client controls its display record but not which account it is.
  const readDeviceId = (req: Request): string | null => {
    const value = req.signedCookies?.[REMEMBERED_DEVICE_COOKIE] as unknown;
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  // PIN-only re-authentication for a device that already remembers a PIN user.
  // PUBLIC (no session yet — that is the whole point) but rate-limited per-IP on
  // the login schedule; the PIN check itself rides the per-account progressive PIN
  // limiter in the service. A `pin`-less call is an auto-pass probe that answers
  // { pinRequired: true } when the ~15-min window is closed.
  router.post(
    '/pin/quick-auth',
    limiters.login,
    validateBody(pinQuickAuthRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as PinQuickAuthRequest;
      const deviceId = readDeviceId(req);
      const result = await ctx.auth.quickAuth({ deviceId, pin: body.pin, ip: req.ip });
      if (result.status === 'pin_required') {
        res.json({ pinRequired: true });
        return;
      }
      // Always an ephemeral session (a Custom-Tab browser must not silently keep a
      // persistent one); refresh the long-lived device cookie so the memory stays.
      setSessionCookie(res, ctx.config, result.sessionId, false);
      if (deviceId) setRememberedDeviceCookie(res, ctx.config, deviceId);
      res.json(toMeResponseFromRow(result.user));
    },
  );

  // Remember THIS device for the caller (a PIN user) so future OAuth flows can
  // quick-re-auth. Cookie-session only (requireUser 403s bearer/admin): sets the
  // signed httpOnly `bt_rdid` cookie and returns the identity the client stores.
  router.post('/remembered-device', requireUser, async (req, res) => {
    const { deviceId, record } = await ctx.auth.rememberDevice(req.authUser!.id, req.ip);
    setRememberedDeviceCookie(res, ctx.config, deviceId);
    res.json(record);
  });

  // Forget the remembered device — "Another account" / explicit forget. PUBLIC:
  // it only ever clears the binding for the device presenting the cookie, so it
  // needs no session (the chooser shows the option when none exists). Clears the
  // cookie so a closed-then-reopened OAuth flow knows nobody (blank login).
  router.delete('/remembered-device', async (req, res) => {
    await ctx.auth.forgetDevice(readDeviceId(req), req.ip);
    clearRememberedDeviceCookie(res, ctx.config);
    res.json({ ok: true });
  });

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

  // Public registration-mode discovery (§13.4 V4-P4a). Unauthenticated: the
  // login / register surfaces and the landing page read the active mode to
  // reflect it. Leaks nothing beyond the mode itself.
  //
  // The landing (product/apex origin) is NOT on the credentialed CORS allowlist
  // — that list is only the web+admin SPAs (§4.6) — so a bare cross-origin GET
  // from it would be blocked by the browser. Since this endpoint is
  // unauthenticated and leaks only the mode, we serve it with permissive,
  // NON-credentialed CORS (`Access-Control-Allow-Origin: *`) so any origin can
  // read it. Only set the wildcard when the credentialed middleware hasn't
  // already emitted an origin-specific ACAO for an allowlisted (web/admin)
  // caller — a `*` ACAO alongside `Allow-Credentials: true` is rejected by
  // browsers, and those SPAs call this with `credentials: 'include'`.
  router.get('/registration-info', async (_req, res) => {
    if (!res.getHeader('Access-Control-Allow-Origin')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.json(await ctx.auth.getRegistrationInfo());
  });

  // Public self-serve registration (§4, §6.12, §13.4 V4-P4a). The service reads
  // the stored registration mode and gates on it: `closed` → 403
  // REGISTRATION_CLOSED (unchanged); `invite_token` → a valid token required;
  // `approval` → a pending application (202, no session); `open` → account
  // created and signed straight in (201). Admin-created users and per-email
  // invites are unaffected either way.
  router.post(
    '/register',
    limiters.login,
    validateBody(registerRequestSchema),
    async (req, res) => {
      const result = await ctx.auth.register(req.valid?.body as RegisterRequest, req.ip);
      if (result.status === 'pending') {
        res.status(202).json({ pending: true });
        return;
      }
      setSessionCookie(res, ctx.config, result.sessionId, result.persistent);
      res.status(201).json(toMeResponseFromRow(result.user));
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
      setSessionCookie(res, ctx.config, result.sessionId, result.persistent);
      res.json(toMeResponseFromRow(result.user));
    },
  );

  router.post('/accept-invite', validateBody(acceptInviteRequestSchema), async (req, res) => {
    const body = req.valid?.body as AcceptInviteRequest;
    const { user, sessionId, persistent } = await ctx.auth.acceptInvite(body, req.ip);
    setSessionCookie(res, ctx.config, sessionId, persistent);
    res.status(201).json(toMeResponseFromRow(user));
  });

  // ── Google sign-in (§13.4 V4-P4b) ───────────────────────────────────────────
  // Server-side OAuth authorization-code flow. Both `start` and `callback` are
  // browser redirects (no JSON), and the whole surface 404s when Google is not
  // configured (env-gated). `link-status`/`unlink` back Settings → Security and,
  // per #361 convention, accept a bearer holding `account:security`.

  // Kick off the flow: bind a single-use `state` and redirect to Google. A live
  // cookie session turns this into a "link Google to my account" flow (from
  // Settings); anonymous is a sign-in/registration. A brand-new identity lands
  // back on the connected register form, where any invite token is entered — so
  // nothing rides through `start` beyond the flow's CSRF state.
  router.get('/google/start', async (req, res) => {
    if (!ctx.google.isEnabled()) throw notFound();
    const linkUserId = req.authUser && !req.apiKey ? req.authUser.id : null;
    const { url, state } = await ctx.google.buildAuthorizeUrl({ linkUserId });
    // Bind the state to this browser: the callback requires the same value back
    // from this signed cookie (login-CSRF defence, §13.4 V4-P4b).
    setGoogleOAuthStateCookie(res, ctx.config, state);
    res.redirect(url);
  });

  // Google's redirect back. Validates `state`, verifies the ID token, then signs
  // in / links / registers. Always ends in a redirect to the SPA — a success sets
  // the session cookie exactly like password login; every failure carries a
  // friendly `?error=` the SPA renders (no JSON error page for a browser flow).
  router.get('/google/callback', async (req, res) => {
    if (!ctx.google.isEnabled()) throw notFound();
    const web = ctx.config.appOrigin;
    // The state cookie is single-use — always clear it, whatever the outcome.
    const cookieState = req.signedCookies?.[GOOGLE_OAUTH_STATE_COOKIE] as string | undefined;
    clearGoogleOAuthStateCookie(res, ctx.config);
    // The user denied consent (or Google errored) before we ever got a code.
    if (typeof req.query.error === 'string' && req.query.error.length > 0) {
      res.redirect(`${web}/login?error=google_failed`);
      return;
    }
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const result = await ctx.google.handleCallback({ state, cookieState, code, ip: req.ip });
    switch (result.status) {
      case 'authenticated':
        setSessionCookie(res, ctx.config, result.sessionId, result.persistent);
        res.redirect(`${web}/?google=signed_in`);
        return;
      case 'linked':
        res.redirect(`${web}/settings/connections?google=linked`);
        return;
      case 'register':
        // A brand-new identity: bind the pending ticket to this browser and land
        // on the connected register form — no account exists yet (owner order
        // 2026-07-16). The account is created only on explicit submit.
        setGoogleRegisterTicketCookie(res, ctx.config, result.ticket);
        res.redirect(`${web}/register?google=connected`);
        return;
      case 'error': {
        const base = result.intent === 'link' ? '/settings/connections' : '/login';
        res.redirect(`${web}${base}?error=${googleErrorParam(result.code)}`);
        return;
      }
    }
  });

  // ── Google-assisted registration: connect → prefill → submit (owner 2026-07-16) ──
  // The pending ticket rides a signed httpOnly `bt_goog_reg` cookie set at the
  // callback; read it from the signed-cookie jar (cookie-parser drops a tampered
  // value), never the body — the client never handles the reference itself.
  const readRegisterTicket = (req: Request): string | null => {
    const value = req.signedCookies?.[GOOGLE_REGISTER_TICKET_COOKIE] as unknown;
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  // Display values for the connected register form (email to lock, name to seed
  // the username). PUBLIC — there is no session yet; the ticket cookie is the
  // only credential. 404 when Google is off or no ticket is pending. Read-only:
  // it never consumes the ticket, so a page refresh keeps the connected state.
  router.get('/google/register-ticket', async (req, res) => {
    if (!ctx.google.isEnabled()) throw notFound();
    const ticket = readRegisterTicket(req);
    const info = ticket ? await ctx.google.peekRegisterTicket(ticket) : null;
    if (!info) {
      throw notFound('No pending Google sign-up.', 'GOOGLE_REGISTER_TICKET_INVALID');
    }
    res.json(info);
  });

  // Create the account from the pending ticket on explicit submit. The email +
  // the subject to link are taken from the TICKET (never the body — a tampered
  // form email is ignored). Per the active mode: open / invite-token → account +
  // session (201); approval → pending (202). The ticket is single-use, spent only
  // on success, so a validation failure (taken username, bad token) leaves it live
  // for a retry; a spent/expired ticket 400s and its cookie is dropped.
  router.post(
    '/google/register',
    limiters.login,
    validateBody(googleRegisterRequestSchema),
    async (req, res) => {
      if (!ctx.google.isEnabled()) throw notFound();
      const ticket = readRegisterTicket(req);
      if (!ticket) {
        clearGoogleRegisterTicketCookie(res, ctx.config);
        throw badRequest(
          'Your Google sign-up session expired. Please connect Google again.',
          'GOOGLE_REGISTER_TICKET_INVALID',
        );
      }
      const body = req.valid?.body as GoogleRegisterRequest;
      let result;
      try {
        result = await ctx.google.completeRegistration({
          ticket,
          username: body.username,
          password: body.password,
          inviteToken: body.inviteToken ?? null,
          locale: body.locale ?? null,
          ip: req.ip,
        });
      } catch (err) {
        // A spent/expired ticket is unrecoverable — drop its stale cookie. Any
        // other failure (taken username, weak password, bad token) leaves the
        // ticket + cookie in place so the user can fix the form and resubmit.
        if (err instanceof ApiError && err.code === 'GOOGLE_REGISTER_TICKET_INVALID') {
          clearGoogleRegisterTicketCookie(res, ctx.config);
        }
        throw err;
      }
      // Success: the ticket has been consumed server-side — clear its cookie.
      clearGoogleRegisterTicketCookie(res, ctx.config);
      if (result.status === 'pending') {
        res.status(202).json({ pending: true });
        return;
      }
      setSessionCookie(res, ctx.config, result.sessionId, result.persistent);
      res.status(201).json(toMeResponseFromRow(result.user));
    },
  );

  // The caller's Google link state for the Settings surface. Cookie session or a
  // bearer holding `account:security` (both read only the caller's own account).
  router.get('/google/link-status', requireAuth, async (req, res) => {
    if (!ctx.google.isEnabled()) throw notFound();
    res.json(await ctx.google.getLinkStatus(req.authUser!.id));
  });

  // Unlink Google after a password re-auth. Refused (409 GOOGLE_ONLY_SIGN_IN)
  // while Google is the account's only usable sign-in method.
  router.post(
    '/google/unlink',
    requireAuth,
    validateBody(googleUnlinkRequestSchema),
    async (req, res) => {
      if (!ctx.google.isEnabled()) throw notFound();
      const body = req.valid?.body as GoogleUnlinkRequest;
      await ctx.google.unlink(req.authUser!.id, body.password, req.ip);
      res.json({ ok: true });
    },
  );

  return router;
}

/**
 * Map a Google-callback failure code to the stable `?error=` param the SPA reads
 * (login / Settings → Security surfaces localize it). Anything unmapped falls
 * back to a generic `google_failed`.
 */
function googleErrorParam(code: string): string {
  switch (code) {
    case 'GOOGLE_STATE_INVALID':
      return 'google_state';
    case 'GOOGLE_VERIFY_FAILED':
      return 'google_verify';
    case 'REGISTRATION_CLOSED':
      return 'google_registration_closed';
    case 'EMAIL_TAKEN':
      return 'google_email_taken';
    case 'REGISTRATION_TOKEN_REQUIRED':
    case 'INVALID_REGISTRATION_TOKEN':
      return 'google_invite_required';
    case 'ACCOUNT_DISABLED':
      return 'google_account_disabled';
    case 'GOOGLE_ADMIN_UNSUPPORTED':
      return 'google_admin';
    case 'GOOGLE_ALREADY_LINKED':
      return 'google_already_linked';
    case 'GOOGLE_EMAIL_MISMATCH':
      return 'google_email_mismatch';
    default:
      return 'google_failed';
  }
}

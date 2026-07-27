import { Router } from 'express';

import {
  adminTwoFactorEmailStartRequestSchema,
  twoFactorConfirmRequestSchema,
  twoFactorDisableRequestSchema,
  twoFactorEmailConfirmRequestSchema,
  updateAdminSessionPolicyRequestSchema,
  type AdminTwoFactorEmailStartRequest,
  type TwoFactorConfirmRequest,
  type TwoFactorDisableRequest,
  type TwoFactorEmailConfirmRequest,
  type UpdateAdminSessionPolicyRequest,
} from '@bettertrack/contracts';

import type { AppContext } from '../context';
import { setSessionCookie } from '../cookies';
import { validateBody } from '../middleware/validate';
import { toAdminSessionPolicy } from '../serializers';

/**
 * Admin 2FA management endpoints under `/admin/security/2fa` (§6.12, #400).
 *
 * Registered FLAT onto the admin router (not a nested sub-router — the OpenAPI
 * coverage checker only reconstructs top-level mounts). The parent router allows
 * only the exact first-factor → first-enrollment bootstrap paths before any
 * factor exists; once one exists, every route here requires current-session MFA
 * assurance. `requireAdmin` fences the whole surface to admin accounts (404 to
 * everyone else).
 *
 * The TOTP + recovery lifecycle mirrors the user endpoints (the service delegates
 * to the shared core); the email method targets the SEPARATE 2FA email.
 */
export function registerAdminSecurityRoutes(router: Router, ctx: AppContext): void {
  // `ctx.adminTwoFactor` is read PER-REQUEST, never at mount — route factories
  // must stay side-effect free at mount time (checkOpenapiCoverage relies on it).

  router.get('/security/2fa/status', async (req, res) => {
    res.json(await ctx.adminTwoFactor.status(req.authUser!.id));
  });

  router.post('/security/2fa/totp/enroll', async (req, res) => {
    res.json(await ctx.adminTwoFactor.enrollTotp(req.authUser!.id, req.ip));
  });

  router.post(
    '/security/2fa/totp/confirm',
    validateBody(twoFactorConfirmRequestSchema),
    async (req, res) => {
      const { code } = req.valid?.body as TwoFactorConfirmRequest;
      // Only the first factor must turn a fresh password session into an
      // MFA-assured one. Confirming an additional factor already runs on an
      // assured session, so retain that assurance and revoke sibling sessions
      // like every other factor-set mutation.
      const hadFactor = await ctx.twoFactor.isEnabled(req.authUser!.id);
      const result = await ctx.adminTwoFactor.confirmTotp(req.authUser!.id, code, req.ip);
      if (hadFactor) {
        await ctx.auth.revokeOtherSessions(req.authUser!.id, req.sessionId!);
      } else {
        // Completing first enrollment is an MFA ceremony. Rotate the cookie and
        // revoke every older session before returning success, so no other
        // password-only session can inherit this new assurance.
        const session = await ctx.auth.completeAdminMfaEnrollment(
          req.authUser!.id,
          req.sessionId!,
          'totp',
        );
        setSessionCookie(res, ctx.config, session.sessionId, session.persistent);
      }
      res.json(result);
    },
  );

  router.post(
    '/security/2fa/totp/disable',
    validateBody(twoFactorDisableRequestSchema),
    async (req, res) => {
      const { code } = req.valid?.body as TwoFactorDisableRequest;
      await ctx.adminTwoFactor.disableTotp(req.authUser!.id, code, req.ip);
      // A factor-set mutation invalidates every other device's prior assurance.
      await ctx.auth.revokeOtherSessions(req.authUser!.id, req.sessionId!);
      res.status(204).end();
    },
  );

  router.post(
    '/security/2fa/email/start',
    validateBody(adminTwoFactorEmailStartRequestSchema),
    async (req, res) => {
      const { email, proof } = req.valid?.body as AdminTwoFactorEmailStartRequest;
      await ctx.adminTwoFactor.startEmailEnrollment(req.authUser!.id, email, proof, req.ip);
      res.status(204).end();
    },
  );

  router.post(
    '/security/2fa/email/confirm',
    validateBody(twoFactorEmailConfirmRequestSchema),
    async (req, res) => {
      const { code } = req.valid?.body as TwoFactorEmailConfirmRequest;
      const hadFactor = await ctx.twoFactor.isEnabled(req.authUser!.id);
      const result = await ctx.adminTwoFactor.confirmEmail(req.authUser!.id, code, req.ip);
      if (hadFactor) {
        await ctx.auth.revokeOtherSessions(req.authUser!.id, req.sessionId!);
      } else {
        const session = await ctx.auth.completeAdminMfaEnrollment(
          req.authUser!.id,
          req.sessionId!,
          'email',
        );
        setSessionCookie(res, ctx.config, session.sessionId, session.persistent);
      }
      res.json(result);
    },
  );

  router.post('/security/2fa/email/disable', async (req, res) => {
    await ctx.adminTwoFactor.disableEmail(req.authUser!.id, req.ip);
    await ctx.auth.revokeOtherSessions(req.authUser!.id, req.sessionId!);
    res.status(204).end();
  });

  router.post('/security/2fa/recovery-codes', async (req, res) => {
    const result = await ctx.adminTwoFactor.regenerateRecoveryCodes(req.authUser!.id, req.ip);
    await ctx.auth.revokeOtherSessions(req.authUser!.id, req.sessionId!);
    res.json(result);
  });
}

/**
 * Admin session policy endpoints under `/admin/security/session-policy` (§13.5
 * V5-P13c, settles #430). Registered FLAT onto the admin router (like the 2FA
 * routes) but AFTER the {@link requireAdminTwoFactor} setup gate — unlike the
 * enroll/confirm set, changing the session lifetime is a normal admin action,
 * so it stays behind the mandatory-2FA gate. `requireAdmin` on the parent router
 * fences it to admin accounts (404 to everyone else).
 *
 * There is deliberately NO step-up 2FA re-challenge on the write (#430 rejected):
 * the security guarantee is the early-expiring admin session, not a re-prompt.
 */
export function registerAdminSessionPolicyRoutes(router: Router, ctx: AppContext): void {
  router.get('/security/session-policy', async (_req, res) => {
    res.json(toAdminSessionPolicy(await ctx.admin.getSessionPolicy()));
  });

  router.patch(
    '/security/session-policy',
    validateBody(updateAdminSessionPolicyRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as UpdateAdminSessionPolicyRequest;
      const policy = await ctx.admin.updateSessionPolicy(body, {
        id: req.authUser!.id,
        ip: req.ip,
      });
      res.json(toAdminSessionPolicy(policy));
    },
  );
}

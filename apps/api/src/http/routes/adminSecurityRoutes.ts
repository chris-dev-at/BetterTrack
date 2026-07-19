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
import { validateBody } from '../middleware/validate';
import { toAdminSessionPolicy } from '../serializers';

/**
 * Admin 2FA management endpoints under `/admin/security/2fa` (§6.12, #400).
 *
 * Registered FLAT onto the admin router (not a nested sub-router — the OpenAPI
 * coverage checker only reconstructs top-level mounts) and BEFORE the
 * {@link requireAdminTwoFactor} setup gate, so they stay reachable in the
 * not-yet-enrolled bootstrap state: they are exactly the "2FA enroll/confirm set"
 * the gate exempts. `requireAdmin` on the parent router fences them to admin
 * accounts (404 to everyone else).
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
      res.json(await ctx.adminTwoFactor.confirmTotp(req.authUser!.id, code, req.ip));
    },
  );

  router.post(
    '/security/2fa/totp/disable',
    validateBody(twoFactorDisableRequestSchema),
    async (req, res) => {
      const { code } = req.valid?.body as TwoFactorDisableRequest;
      await ctx.adminTwoFactor.disableTotp(req.authUser!.id, code, req.ip);
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
      res.json(await ctx.adminTwoFactor.confirmEmail(req.authUser!.id, code, req.ip));
    },
  );

  router.post('/security/2fa/email/disable', async (req, res) => {
    await ctx.adminTwoFactor.disableEmail(req.authUser!.id, req.ip);
    res.status(204).end();
  });

  router.post('/security/2fa/recovery-codes', async (req, res) => {
    res.json(await ctx.adminTwoFactor.regenerateRecoveryCodes(req.authUser!.id, req.ip));
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

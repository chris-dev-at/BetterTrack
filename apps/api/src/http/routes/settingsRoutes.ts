import { Router } from 'express';

import {
  createApiKeyRequestSchema,
  idParamSchema,
  updateAccountSettingsRequestSchema,
  updateNotificationSettingsRequestSchema,
  type CreateApiKeyRequest,
  type UpdateAccountSettingsRequest,
  type UpdateNotificationSettingsRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Per-user settings endpoints (PROJECTPLAN.md §6.10, §6.11, §8). V1 exposes the
 * notification channel toggles the dispatcher honors; every handler is
 * session-required and strictly scoped to the caller.
 */
export function createSettingsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /settings/notifications — the session user's per-channel state (§8).
  router.get('/notifications', async (req, res) => {
    const settings = await ctx.notificationSettings.get(req.authUser!.id);
    res.json(settings);
  });

  // PATCH /settings/notifications — partial toggles; in-app stays on (§6.10).
  router.patch(
    '/notifications',
    validateBody(updateNotificationSettingsRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as UpdateNotificationSettingsRequest;
      const settings = await ctx.notificationSettings.update(req.authUser!.id, body);
      res.json(settings);
    },
  );

  // GET /settings/account — the caller's account defaults (default portfolio
  // visibility, §6.9, V2-P9).
  router.get('/account', async (req, res) => {
    const settings = await ctx.accountSettings.get(req.authUser!.id);
    res.json(settings);
  });

  // PATCH /settings/account — update the default portfolio visibility (§6.9, V2-P9).
  router.patch('/account', validateBody(updateAccountSettingsRequestSchema), async (req, res) => {
    const body = req.valid?.body as UpdateAccountSettingsRequest;
    const settings = await ctx.accountSettings.update(
      req.authUser!.id,
      body.defaultPortfolioVisibility,
    );
    res.json(settings);
  });

  // ── Personal API keys (§6.13, V2-P12) ──────────────────────────────────────
  // Session-only: the bearer scope guard blocks API-key requests from reaching
  // `/settings/api-keys*`, so a key can never mint/list/revoke keys.

  // GET /settings/api-keys — the caller's active (non-revoked) keys.
  router.get('/api-keys', async (req, res) => {
    const keys = await ctx.apiKeys.list(req.authUser!.id);
    res.json({ keys });
  });

  // POST /settings/api-keys — mint a key; the plaintext token is returned once.
  router.post('/api-keys', validateBody(createApiKeyRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateApiKeyRequest;
    const result = await ctx.apiKeys.create({
      userId: req.authUser!.id,
      name: body.name,
      scopes: body.scopes,
      ip: req.ip ?? null,
    });
    res.status(201).json(result);
  });

  // DELETE /settings/api-keys/:id — revoke a key the caller owns (404 otherwise).
  router.delete('/api-keys/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.apiKeys.revoke({ userId: req.authUser!.id, id, ip: req.ip ?? null });
    res.status(204).end();
  });

  return router;
}

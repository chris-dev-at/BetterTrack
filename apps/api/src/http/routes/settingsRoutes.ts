import { Router } from 'express';

import {
  createApiKeyRequestSchema,
  createOAuthClientRequestSchema,
  idParamSchema,
  updateAccountSettingsRequestSchema,
  updateNotificationSettingsRequestSchema,
  updateTaxSettingsRequestSchema,
  type CreateApiKeyRequest,
  type CreateOAuthClientRequest,
  type UpdateAccountSettingsRequest,
  type UpdateNotificationSettingsRequest,
  type UpdateTaxSettingsRequest,
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

  // PATCH /settings/account — partial update of the caller's account prefs:
  // default portfolio visibility (§6.9, V2-P9), UI language (§13.3 V3-P1)
  // and/or base currency (§5.4, §13.3 V3-P10d).
  router.patch('/account', validateBody(updateAccountSettingsRequestSchema), async (req, res) => {
    const body = req.valid?.body as UpdateAccountSettingsRequest;
    const settings = await ctx.accountSettings.update(req.authUser!.id, {
      defaultPortfolioVisibility: body.defaultPortfolioVisibility,
      locale: body.locale,
      baseCurrency: body.baseCurrency,
    });
    res.json(settings);
  });

  // GET /settings/taxes — the caller's tax mode (+ country), V3-P4 (§13.3).
  router.get('/taxes', async (req, res) => {
    const settings = await ctx.tax.getSettings(req.authUser!.id);
    res.json(settings);
  });

  // PATCH /settings/taxes — switch the tax mode; applies forward only (§16
  // 2026-07-08: existing sells/dividends are never recomputed).
  router.patch('/taxes', validateBody(updateTaxSettingsRequestSchema), async (req, res) => {
    const body = req.valid?.body as UpdateTaxSettingsRequest;
    const settings = await ctx.tax.updateSettings(req.authUser!.id, body);
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

  // ── OAuth apps + grants (§6.13, V2-P12) ─────────────────────────────────────
  // Also session-only (the bearer scope guard blocks API-key/OAuth-token
  // requests from `/settings/oauth-*`), so a delegated token can never register
  // an app or manage grants — no privilege escalation.

  // GET /settings/oauth-clients — the caller's registered OAuth apps.
  router.get('/oauth-clients', async (req, res) => {
    const clients = await ctx.oauth.listClients(req.authUser!.id);
    res.json({ clients });
  });

  // POST /settings/oauth-clients — register an app; client_secret returned once
  // (null for public/PKCE clients).
  router.post('/oauth-clients', validateBody(createOAuthClientRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateOAuthClientRequest;
    const result = await ctx.oauth.registerClient({
      userId: req.authUser!.id,
      name: body.name,
      redirectUris: body.redirectUris,
      scopes: body.scopes,
      public: body.public,
      ip: req.ip ?? null,
    });
    res.status(201).json(result);
  });

  // DELETE /settings/oauth-clients/:id — delete an app (cascades its grants/tokens).
  router.delete('/oauth-clients/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.oauth.deleteClient({ userId: req.authUser!.id, id, ip: req.ip ?? null });
    res.status(204).end();
  });

  // GET /settings/oauth-grants — apps the caller has authorized (active grants).
  router.get('/oauth-grants', async (req, res) => {
    const grants = await ctx.oauth.listGrants(req.authUser!.id);
    res.json({ grants });
  });

  // DELETE /settings/oauth-grants/:id — revoke a grant; kills its tokens instantly.
  router.delete('/oauth-grants/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.oauth.revokeGrant({ userId: req.authUser!.id, id, ip: req.ip ?? null });
    res.status(204).end();
  });

  return router;
}

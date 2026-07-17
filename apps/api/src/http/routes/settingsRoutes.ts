import { Router } from 'express';

import {
  createApiKeyRequestSchema,
  createOAuthClientRequestSchema,
  discordWebhookRequestSchema,
  idParamSchema,
  updateAccountSettingsRequestSchema,
  updateNotificationSettingsRequestSchema,
  updateTaxSettingsRequestSchema,
  type CreateApiKeyRequest,
  type CreateOAuthClientRequest,
  type DiscordWebhookRequest,
  type UpdateAccountSettingsRequest,
  type UpdateNotificationSettingsRequest,
  type UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import { DiscordSetupError } from '../../services/notifications/discordSetupService';
import { TelegramSetupError } from '../../services/notifications/telegramSetupService';

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

  // V5-P0 kill-switch (§13.5, owner directive): every Telegram + Discord
  // endpoint 404s when the global flag is OFF. Placed BEFORE the handlers
  // below so a disabled deployment refuses even the read paths — no leak of
  // per-user linked state, no probe surface, and no matrix column ever
  // renders (the SPA keys the setup cards off `channelsConfigurable` on the
  // notifications response). Code, schema and rows all stay intact; flipping
  // the env restores every route unchanged.
  if (!ctx.config.telegram.enabled) {
    router.use('/telegram', (_req, res) => {
      res.status(404).end();
    });
  }
  if (!ctx.config.discord.enabled) {
    router.use('/discord', (_req, res) => {
      res.status(404).end();
    });
  }

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

  // ── Telegram channel setup (§13.4 V4-P10) ──────────────────────────────────
  // Env-gated at the service layer: with the bot token unset, GET returns the
  // "not available" body and the writes 400 with `not_available` — never a 500.

  router.get('/telegram', async (req, res) => {
    const settings = await ctx.telegramSetup.get(req.authUser!.id);
    res.json(settings);
  });

  // POST /settings/telegram/link — issue a fresh link code + deep link.
  router.post('/telegram/link', async (req, res) => {
    try {
      const settings = await ctx.telegramSetup.startLink(req.authUser!.id);
      res.json(settings);
    } catch (err) {
      if (err instanceof TelegramSetupError) {
        res.status(400).json({ error: { code: err.code, message: err.code } });
        return;
      }
      throw err;
    }
  });

  // POST /settings/telegram/confirm — poll for the `/start <code>` event and
  // attach the chat id when it arrives.
  router.post('/telegram/confirm', async (req, res) => {
    try {
      const result = await ctx.telegramSetup.confirmLink(req.authUser!.id);
      res.json(result);
    } catch (err) {
      if (err instanceof TelegramSetupError) {
        res.status(400).json({ error: { code: err.code, message: err.code } });
        return;
      }
      throw err;
    }
  });

  // DELETE /settings/telegram — unlink; idempotent.
  router.delete('/telegram', async (req, res) => {
    const settings = await ctx.telegramSetup.unlink(req.authUser!.id);
    res.json(settings);
  });

  // ── Discord channel setup (§13.4 V4-P10) ───────────────────────────────────
  // Per-user webhook URL — validated by shape (superRefine on the request)
  // and by a live test send before persisting. The URL is never returned.

  router.get('/discord', async (req, res) => {
    const settings = await ctx.discordSetup.get(req.authUser!.id);
    res.json(settings);
  });

  // POST /settings/discord/webhook — save (or replace) the caller's webhook.
  router.post('/discord/webhook', validateBody(discordWebhookRequestSchema), async (req, res) => {
    const body = req.valid?.body as DiscordWebhookRequest;
    try {
      const settings = await ctx.discordSetup.save(req.authUser!.id, body.url);
      res.json(settings);
    } catch (err) {
      if (err instanceof DiscordSetupError) {
        res.status(400).json({ error: { code: err.code, message: err.code } });
        return;
      }
      throw err;
    }
  });

  // POST /settings/discord/test — fire a diagnostic message.
  router.post('/discord/test', async (req, res) => {
    const outcome = await ctx.discordSetup.test(req.authUser!.id);
    if (outcome === 'ok') {
      res.json({ ok: true });
      return;
    }
    res.status(400).json({
      error: { code: outcome === 'gone' ? 'no_webhook' : 'send_failed', message: outcome },
    });
  });

  // DELETE /settings/discord — remove the caller's webhook.
  router.delete('/discord', async (req, res) => {
    const settings = await ctx.discordSetup.remove(req.authUser!.id);
    res.json(settings);
  });

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

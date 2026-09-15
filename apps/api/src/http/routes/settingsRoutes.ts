import { Router, type RequestHandler } from 'express';

import {
  createApiKeyRequestSchema,
  createOAuthClientRequestSchema,
  discordWebhookRequestSchema,
  idParamSchema,
  scopeSatisfies,
  updateAccountSettingsRequestSchema,
  updateHomeLayoutRequestSchema,
  updateNotificationSettingsRequestSchema,
  updateTaxSettingsRequestSchema,
  updateWidgetLayoutRequestSchema,
  widgetLayoutNamespaceParamSchema,
  type CreateApiKeyRequest,
  type CreateOAuthClientRequest,
  type DiscordWebhookRequest,
  type UpdateAccountSettingsRequest,
  type UpdateHomeLayoutRequest,
  type UpdateNotificationSettingsRequest,
  type UpdateTaxSettingsRequest,
  type UpdateWidgetLayoutRequest,
  type WidgetLayoutNamespaceParam,
} from '@bettertrack/contracts';

import { forbidden, notFound } from '../../errors';

import type { BearerScopeDenialReason } from '../../services/audit/auditService';
import { DiscordSetupError } from '../../services/notifications/discordSetupService';
import { TelegramSetupError } from '../../services/notifications/telegramSetupService';

import {
  ACCOUNT_SECURITY_SCOPE,
  oauthGrantRouteAcceptsBearer,
  recordBearerScopeDenied,
  taxYearDocumentationRouteAcceptsBearer,
} from '../middleware/bearerAuth';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Defense-in-depth for the bearer-callable tax-year documentation read. The
 * global policy makes the same decision before routing, but this guard remains
 * independently method/path-aware AND scope-aware so bypassing or regressing
 * that table cannot expose account documentation to an unrelated bearer.
 */
export const requireCookieSessionOrTaxYearDocumentationBearer: RequestHandler = (
  req,
  _res,
  next,
) => {
  const bearerAllowed =
    req.apiKey !== undefined &&
    scopeSatisfies(req.apiKey.scopes, ACCOUNT_SECURITY_SCOPE) &&
    taxYearDocumentationRouteAcceptsBearer(
      req.method,
      `/settings${req.path === '/' || req.path === '' ? '' : req.path}`,
    );
  if ((!req.apiKey && req.sessionId) || bearerAllowed) {
    next();
    return;
  }
  next(
    forbidden(
      'Tax-year documentation requires the owning session or account-security access.',
      'API_KEY_FORBIDDEN',
    ),
  );
};

/**
 * Per-user settings endpoints (PROJECTPLAN.md §6.10, §6.11, §8). V1 exposes the
 * notification channel toggles the dispatcher honors; every handler is
 * authenticated and strictly scoped to the caller, with bearer-capable
 * subtrees carrying their own explicit scope guards. OAuth grant list/revoke
 * additionally admit trusted first-party bearers holding `account:security`.
 */

/**
 * Router-local twin of the global first-party grant policy. It independently
 * checks the exact route, scope, credential kind and first-party marker so a
 * policy-table reshuffle or direct router mount cannot expose grant management
 * to a third-party token or personal key.
 *
 * Its refusals are split the same way the global rail splits them: a trusted
 * first-party token that merely lacks `account:security` gets the actionable
 * INSUFFICIENT_SCOPE answer naming the scope, and only a third-party token or
 * personal key is told the route is first-party-only. Unreachable while the
 * global policy answers first — but this fallback exists precisely for the case
 * where that table regresses, and in that case it must not misdescribe the
 * cause (#1365).
 *
 * ## Why it takes `ctx` (#1951 §2)
 *
 * The rail audits every bearer scope refusal it answers; a twin that refuses
 * the IDENTICAL request silently would lose that row at exactly the moment it
 * matters — the twin only ever answers when the global table has regressed, and
 * a regression the owner cannot see in `api_key.scope_denied` is a regression
 * nobody finds. So the twin writes the row itself, through the same
 * {@link recordBearerScopeDenied} rail and the same closed `reason` vocabulary.
 *
 * Exactly one row per refusal: when the global guard answers first it has
 * already short-circuited the request, so this handler never runs; when it
 * admits and the twin refuses, this is the only writer.
 *
 * ## Which refusals are audited, and with which reason
 *
 * Only a refusal of a real bearer credential on a route the grant allowlist
 * ACCEPTS is a scope denial. Everything else here is a different event: no
 * credential at all (an unauthenticated caller — there is no principal to
 * audit), or an off-allowlist path, which the global rail classifies
 * session-only and audits nowhere either.
 *
 * Within that set the reason follows the rail's own scope-first order, and the
 * documented meaning of the discriminator: a credential that LACKS the scope is
 * `insufficient-scope` whether or not it is also untrusted, and only a
 * credential that HOLDS the scope and is refused for being third-party is
 * `first-party-only`. That deliberately makes the audited reason finer than the
 * answer the client gets, which stays byte-identical to before: telling an
 * untrusted caller "you are merely missing a scope" would hand it an actionable
 * hint about a route reserved for first-party clients, while the owner reading
 * their own audit log is entitled to the precise cause.
 */
export function requireCookieSessionOrFirstPartyOAuthGrant(ctx: AppContext): RequestHandler {
  return function requireCookieSessionOrFirstPartyOAuthGrant(req, _res, next) {
    const path = `/settings${req.path === '/' || req.path === '' ? '' : req.path}`;
    const routeAccepted = oauthGrantRouteAcceptsBearer(req.method, path);
    const trustedClient = req.apiKey?.kind === 'oauth' && req.apiKey.firstParty;
    const scoped =
      req.apiKey !== undefined && scopeSatisfies(req.apiKey.scopes, ACCOUNT_SECURITY_SCOPE);
    if ((!req.apiKey && req.sessionId) || (trustedClient && scoped && routeAccepted)) {
      next();
      return;
    }

    const refuse = (error: unknown, reason?: BearerScopeDenialReason): void => {
      if (reason === undefined) {
        next(error);
        return;
      }
      recordBearerScopeDenied(ctx, req, ACCOUNT_SECURITY_SCOPE, reason, path).then(
        () => next(error),
        next,
      );
    };
    // `routeAccepted && req.apiKey` is what makes this a scope denial at all;
    // `scoped` then picks the reason exactly as the global rail would.
    const auditedReason: BearerScopeDenialReason | undefined =
      req.apiKey !== undefined && routeAccepted
        ? scoped
          ? 'first-party-only'
          : 'insufficient-scope'
        : undefined;

    if (trustedClient && routeAccepted && !scoped) {
      refuse(
        forbidden(
          `API key is missing the required scope "${ACCOUNT_SECURITY_SCOPE}".`,
          'INSUFFICIENT_SCOPE',
        ),
        auditedReason,
      );
      return;
    }
    refuse(
      forbidden(
        'This endpoint is available to first-party OAuth clients only.',
        'API_KEY_FORBIDDEN',
      ),
      auditedReason,
    );
  };
}

export function createSettingsRouter(ctx: AppContext): Router {
  const router = Router();
  // Built once per router, not per request: the guard closes over `ctx` only to
  // reach the audit rail.
  const firstPartyOAuthGrantAccess = requireCookieSessionOrFirstPartyOAuthGrant(ctx);

  router.use(requireUser);

  // V5-P0 kill-switch (§13.5, owner directive): every Telegram + Discord
  // endpoint 404s when the global flag is OFF. Placed BEFORE the handlers
  // below so a disabled deployment refuses even the read paths — no leak of
  // per-user linked state, no probe surface, and no matrix column ever
  // renders (the SPA keys the setup cards off `channelsConfigurable` on the
  // notifications response). Code, schema and rows all stay intact; flipping
  // the env restores every route unchanged.
  //
  // The guard keys on `offered` — the kill-switch ALONE (#1795). A missing bot
  // token is NOT a refusal: with the switch ON and no token, `/settings/telegram`
  // answers the documented `available: false` body (§13.4 V4-P10), exactly as
  // Discord does for its own "nothing configured yet" state. And the refusal
  // carries the standard `{error:{code,message}}` envelope every other 404 in
  // this API carries, rather than an empty body a client cannot read.
  if (!ctx.config.telegram.offered) {
    router.use('/telegram', (_req, _res, next) => {
      next(notFound('Telegram notifications are deactivated.', 'CHANNEL_DEACTIVATED'));
    });
  }
  if (!ctx.config.discord.offered) {
    router.use('/discord', (_req, _res, next) => {
      next(notFound('Discord notifications are deactivated.', 'CHANNEL_DEACTIVATED'));
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
      discreetMode: body.discreetMode,
    });
    res.json(settings);
  });

  // ── Home widget board (R2 home-widgets) ────────────────────────────────────
  // Per account rather than per browser, so the board a user composes follows
  // them everywhere they sign in. The document is stored and returned verbatim;
  // only its shape and size are validated (see `homeLayoutSchema`).

  // GET /settings/home — the caller's board, or nulls when they never saved one.
  router.get('/home', async (req, res) => {
    const layout = await ctx.homeLayout.get(req.authUser!.id);
    res.json(layout);
  });

  // PUT /settings/home — replace the board outright (`layout: null` clears it).
  router.put('/home', validateBody(updateHomeLayoutRequestSchema), async (req, res) => {
    const body = req.valid?.body as UpdateHomeLayoutRequest;
    const layout = await ctx.homeLayout.set(req.authUser!.id, body.layout);
    res.json(layout);
  });

  // ── Per-account widget compositions (mobile board #68 item 3) ──────────────
  // One saved composition per (account, client namespace): `mobile` and `web`
  // are independent documents, so a phone board and a desktop board sync
  // across devices without either client clobbering the other's layout.
  //
  // The document is OPAQUE here — validated only as a JSON object of at most
  // 32 KB (`widgetLayoutDocSchema` + the service's size cap). An unknown
  // namespace never reaches a handler: `validateParams` rejects it with a 400
  // before any lookup, so the enum is the whole namespace surface.

  // GET /settings/widget-layout/:namespace — 404 when never saved.
  router.get(
    '/widget-layout/:namespace',
    validateParams(widgetLayoutNamespaceParamSchema),
    async (req, res) => {
      const { namespace } = req.valid?.params as WidgetLayoutNamespaceParam;
      const layout = await ctx.widgetLayouts.get(req.authUser!.id, namespace);
      res.json(layout);
    },
  );

  // PUT /settings/widget-layout/:namespace — upsert, last write wins.
  router.put(
    '/widget-layout/:namespace',
    validateParams(widgetLayoutNamespaceParamSchema),
    validateBody(updateWidgetLayoutRequestSchema),
    async (req, res) => {
      const { namespace } = req.valid?.params as WidgetLayoutNamespaceParam;
      const body = req.valid?.body as UpdateWidgetLayoutRequest;
      const layout = await ctx.widgetLayouts.set(req.authUser!.id, namespace, body.doc);
      res.json(layout);
    },
  );

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

  // GET /settings/taxes/years — account-wide living documentation, newest first.
  router.get('/taxes/years', requireCookieSessionOrTaxYearDocumentationBearer, async (req, res) => {
    res.json(await ctx.tax.getYearChanges(req.authUser!.id));
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
  // Client registration stays session-only. Grant list/revoke also admit the
  // official first-party app under the global + local account:security guards;
  // third-party OAuth tokens and personal keys remain unable to manage grants.

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
      logoUrl: body.logoUrl ?? null,
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
  router.get('/oauth-grants', firstPartyOAuthGrantAccess, async (req, res) => {
    const currentGrantId = req.apiKey?.kind === 'oauth' ? req.apiKey.id : null;
    const grants = await ctx.oauth.listGrants(req.authUser!.id, currentGrantId);
    res.json({ grants });
  });

  /**
   * DELETE /settings/oauth-grants/:id — revoke a grant; kills its tokens instantly.
   * A first-party client revoking its own authenticated grant during logout is
   * intentional; the next authorization presents consent again.
   */
  router.delete(
    '/oauth-grants/:id',
    firstPartyOAuthGrantAccess,
    validateParams(idParamSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      await ctx.oauth.revokeGrant({ userId: req.authUser!.id, id, ip: req.ip ?? null });
      res.status(204).end();
    },
  );

  return router;
}

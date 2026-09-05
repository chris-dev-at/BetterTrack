import { Router, type Request } from 'express';

import {
  adminHealthResponseSchema,
  adminUserListQuerySchema,
  adminUserNoteParamSchema,
  adminUserSupportQuerySchema,
  createAdminUserNoteRequestSchema,
  aiSettingsResponseSchema,
  aiTestConnectionRequestSchema,
  aiTestConnectionResponseSchema,
  aiTestRequestSchema,
  aiTestRequestResponseSchema,
  updateAiSettingsRequestSchema,
  auditQuerySchema,
  bulkUserActionRequestSchema,
  createAnnouncementRequestSchema,
  createInviteRequestSchema,
  createOAuthClientRequestSchema,
  createRegistrationTokenRequestSchema,
  createUserRequestSchema,
  deleteUserRequestSchema,
  emailLogQuerySchema,
  featureFlagKeyParamSchema,
  idParamSchema,
  testEmailRequestSchema,
  updateFeatureFlagRequestSchema,
  updateAccountDefaultsRequestSchema,
  updateAnnouncementRequestSchema,
  updateAppSettingsRequestSchema,
  updateOAuthClientRequestSchema,
  updateUserRequestSchema,
  usageAnalyticsResponseSchema,
  type AdminUserListQuery,
  type AdminUserNoteParam,
  type AdminUserSupportQuery,
  type AuditQuery,
  type BulkUserActionRequest,
  type CreateAdminUserNoteRequest,
  type CreateAnnouncementRequest,
  type UpdateAccountDefaultsRequest,
  type AiTestConnectionRequest,
  type AiTestRequest,
  type UpdateAiSettingsRequest,
  type CreateInviteRequest,
  type CreateOAuthClientRequest,
  type CreateRegistrationTokenRequest,
  type CreateUserRequest,
  type DeleteUserRequest,
  type EmailLogQuery,
  type FeatureFlagKeyParam,
  type TestEmailRequest,
  type UpdateFeatureFlagRequest,
  type UpdateAnnouncementRequest,
  type UpdateAppSettingsRequest,
  type UpdateOAuthClientRequest,
  type UpdateUserRequest,
} from '@bettertrack/contracts';

import { notFound } from '../../errors';
import type { AdminActor } from '../../services/admin/adminService';
import type { AppContext } from '../context';
import { requireAdmin, requireAdminTwoFactor } from '../middleware/session';
import type { RateLimiters } from '../middleware/rateLimit';
import { registerAdminApiKeyRoutes } from './adminApiKeyRoutes';
import { registerAdminFeedbackRoutes } from './adminFeedbackRoutes';
import { registerAdminProblemsRoutes } from './adminProblemsRoutes';
import { registerAdminMonitoringRoutes } from './adminMonitoringRoutes';
import { registerAdminOpsRoutes } from './adminOpsRoutes';
import {
  registerAdminSecurityRoutes,
  registerAdminSessionPolicyRoutes,
} from './adminSecurityRoutes';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import {
  toAdminInvite,
  toAdminUser,
  toAdminUserAccess,
  toAdminUserNote,
  toAdminUserSharing,
  toAdminUserSupportItem,
  toAppSettings,
  toAuditEntry,
  toEmailLogEntry,
  toRegistrationRequest,
  toRegistrationToken,
} from '../serializers';

const actorOf = (req: Request): AdminActor => ({ id: req.authUser!.id, ip: req.ip });

/**
 * Admin endpoints under /api/v1/admin (PROJECTPLAN.md §6.12, §8). The router is
 * gated by `requireAdmin` (404 to everyone else); the forced-password-change
 * guard is applied globally on /api/v1 (see app.ts).
 */
export function createAdminRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();
  // Single-resource responses: the account was read (or just mutated) a moment
  // ago, so a vanished row is a benign delete race — 404 that one resource
  // instead of raising an unexpected 500. It carries the same `USER_NOT_FOUND`
  // code the service uses, so the console can tell this row-gone 404 apart from
  // the bare §6.12 "you are not an admin" 404 that means the session window
  // closed (V5-P13c, #1779) — otherwise the login screen claims an expiry that
  // did not happen.
  const serializeAdminUser = async (
    row: Parameters<typeof toAdminUser>[0],
  ): Promise<ReturnType<typeof toAdminUser>> => {
    const metadata = await ctx.paranoidTransitions.adminMetadata(row.id);
    if (!metadata) throw notFound('This account no longer exists.', 'USER_NOT_FOUND');
    return toAdminUser(row, metadata);
  };

  router.use(limiters.admin);
  router.use(requireAdmin);

  // Admin 2FA management (§6.12, #400, #878) is registered before the general
  // gate, but applies its own per-route assurance/bootstrap gates.
  registerAdminSecurityRoutes(router, ctx);

  // Mandatory admin-login 2FA: every admin endpoint below this line 403s with
  // ADMIN_2FA_SETUP_REQUIRED until the admin has a confirmed 2FA method.
  router.use(requireAdminTwoFactor(ctx));

  // Admin session policy (§13.5 V5-P13c): read/set the early-expiring admin
  // session lifetime. Behind the 2FA gate — a normal admin action, not part of
  // the bootstrap enroll set.
  registerAdminSessionPolicyRoutes(router, ctx);

  // Admin Problems page (§13.5 V5-P2 arc (d), the Sentry replacement): captured
  // errors/failed jobs/provider failures with a resolve flow. Registered flat.
  registerAdminProblemsRoutes(router, ctx);

  // Authenticated web + native submissions converge in one category-priority
  // owner inbox. Registered flat behind the existing admin + 2FA gates.
  registerAdminFeedbackRoutes(router, ctx, limiters);

  // Admin monitoring / Diagnostics (§13.5 V5-P2 arc (a), owner 2026-07-19):
  // Grafana/Prometheus reachability status + the external-access runtime
  // kill-switch. The heavier Grafana reverse proxy is mounted at the app root
  // (bypassing CSRF + the general limiter); these are the small JSON reads.
  registerAdminMonitoringRoutes(router, ctx);

  // API-key governance (§13.5 V5-P10, issue 2/2): admin-configurable rate tiers
  // + per-key request-log audit view. Registered flat like the surfaces above.
  registerAdminApiKeyRoutes(router, ctx);

  // Operator reads for the Overview cockpit (#1406 W1): backup / restore-drill
  // readiness projected off the scheduler's status file. Read-only, registered
  // flat like the surfaces above.
  registerAdminOpsRoutes(router, ctx);

  // First-party usage analytics (§13.5 V5-P2 arc (b)): DAU/WAU/MAU, feature
  // counters, top assets and the registration funnel — computed from our own
  // request/auth stream, no third-party trackers. The read refreshes today's
  // rollup so the current day is fresh between cron runs.
  router.get('/usage-analytics', async (_req, res) => {
    res.json(usageAnalyticsResponseSchema.parse(await ctx.usageAnalytics.overview()));
  });

  router.get('/users', validateQuery(adminUserListQuerySchema), async (req, res) => {
    const query = req.valid?.query as AdminUserListQuery;
    const { rows, total } = await ctx.admin.listUsersPage(query);
    // ONE locked batch for the whole page. Fanning the per-user read out over an
    // unbounded list would hold one lock transaction per account while queueing
    // its own reads behind them, exhausting the pool on a real instance.
    const metadata = await ctx.paranoidTransitions.adminMetadataMany(rows.map((row) => row.id));
    res.json({
      users: rows.flatMap((row) => {
        // Deleted between the list read and this one: drop the single stale row
        // rather than failing the whole page.
        const paranoidMetadata = metadata.get(row.id);
        return paranoidMetadata ? [toAdminUser(row, paranoidMetadata)] : [];
      }),
      // The count is for the FILTER, not the table — it is what the footer means
      // by "47 accounts" when a filter is on. Deliberately NOT `users.length`:
      // that would collapse to the page size and make paging unreadable.
      page: { total, limit: query.limit, offset: query.offset },
    });
  });

  // Bulk actions from the slimmed user list (§6.12, §13.2). Registered before
  // the `/users/:id` routes so `bulk` is never read as an id.
  router.post('/users/bulk', validateBody(bulkUserActionRequestSchema), async (req, res) => {
    const result = await ctx.admin.bulkUserAction(
      req.valid?.body as BulkUserActionRequest,
      actorOf(req),
    );
    res.json(result);
  });

  // ── People 360 (#1406 W2) ──────────────────────────────────────────────────
  // Read-only projections behind the detail page's tabs. Registered after
  // `/users/bulk` so that literal can never be parsed as an id, and each one
  // resolves the account first so an unknown id 404s the same way a
  // non-admin caller does — no existence oracle either way.

  router.get('/users/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    res.json(await serializeAdminUser(await ctx.admin.getUser(id)));
  });

  router.get('/users/:id/access', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    res.json(toAdminUserAccess(await ctx.admin.userAccess(id)));
  });

  router.get('/users/:id/sharing', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    res.json(toAdminUserSharing(await ctx.admin.userSharing(id)));
  });

  router.get(
    '/users/:id/support',
    validateParams(idParamSchema),
    validateQuery(adminUserSupportQuerySchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const { limit } = req.valid?.query as AdminUserSupportQuery;
      const { rows, total, openCount } = await ctx.admin.userSupport(id, limit);
      res.json({ items: rows.map(toAdminUserSupportItem), total, openCount });
    },
  );

  // Operator notes: admin-private annotations on an account. The only write W2
  // adds, and an additive one — a note changes nothing about the account.
  router.get('/users/:id/notes', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const notes = await ctx.admin.listUserNotes(id);
    res.json({ notes: notes.map(toAdminUserNote) });
  });

  router.post(
    '/users/:id/notes',
    validateParams(idParamSchema),
    validateBody(createAdminUserNoteRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const { body } = req.valid?.body as CreateAdminUserNoteRequest;
      const note = await ctx.admin.createUserNote(id, body, actorOf(req));
      res.status(201).json(toAdminUserNote(note));
    },
  );

  router.delete(
    '/users/:id/notes/:noteId',
    validateParams(adminUserNoteParamSchema),
    async (req, res) => {
      const { id, noteId } = req.valid?.params as AdminUserNoteParam;
      await ctx.admin.deleteUserNote(id, noteId, actorOf(req));
      res.json({ ok: true });
    },
  );

  router.post('/users', validateBody(createUserRequestSchema), async (req, res) => {
    const { user, tempPassword } = await ctx.admin.createUser(
      req.valid?.body as CreateUserRequest,
      actorOf(req),
    );
    res.status(201).json({ user: await serializeAdminUser(user), tempPassword });
  });

  router.patch(
    '/users/:id',
    validateParams(idParamSchema),
    validateBody(updateUserRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const user = await ctx.admin.updateUser(
        id,
        req.valid?.body as UpdateUserRequest,
        actorOf(req),
      );
      res.json(await serializeAdminUser(user));
    },
  );

  router.post('/users/:id/reset-password', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const { user, tempPassword } = await ctx.admin.resetPassword(id, actorOf(req));
    res.json({ user: await serializeAdminUser(user), tempPassword });
  });

  router.delete(
    '/users/:id',
    validateParams(idParamSchema),
    validateBody(deleteUserRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const { confirmUsername } = req.valid?.body as DeleteUserRequest;
      await ctx.admin.deleteUser(id, confirmUsername, actorOf(req));
      res.json({ ok: true });
    },
  );

  router.get('/invites', async (_req, res) => {
    const invites = await ctx.admin.listInvites();
    res.json({ invites: invites.map(toAdminInvite) });
  });

  router.post('/invites', validateBody(createInviteRequestSchema), async (req, res) => {
    const { invite, inviteUrl } = await ctx.admin.createInvite(
      req.valid?.body as CreateInviteRequest,
      actorOf(req),
    );
    res.status(201).json({ invite: toAdminInvite(invite), inviteUrl });
  });

  router.post('/invites/:id/revoke', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.admin.revokeInvite(id, actorOf(req));
    res.json({ ok: true });
  });

  // ── Registration access tokens (§6.12, §13.4 V4-P4a) ────────────────────────
  // Admin-managed tokens that gate the `invite_token` registration mode. Create
  // returns the register URL (with the raw token) exactly once.
  router.get('/registration-tokens', async (_req, res) => {
    const tokens = await ctx.admin.listRegistrationTokens();
    res.json({ tokens: tokens.map(toRegistrationToken) });
  });

  router.post(
    '/registration-tokens',
    validateBody(createRegistrationTokenRequestSchema),
    async (req, res) => {
      const { token, registerUrl } = await ctx.admin.createRegistrationToken(
        req.valid?.body as CreateRegistrationTokenRequest,
        actorOf(req),
      );
      res.status(201).json({ token: toRegistrationToken(token), registerUrl });
    },
  );

  router.post(
    '/registration-tokens/:id/revoke',
    validateParams(idParamSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      await ctx.admin.revokeRegistrationToken(id, actorOf(req));
      res.json({ ok: true });
    },
  );

  // ── Approval queue (§6.12, §13.4 V4-P4a) ────────────────────────────────────
  // Pending `approval`-mode applications; approve creates the account + emails
  // the applicant, reject drops the application + emails the applicant.
  router.get('/registration-requests', async (_req, res) => {
    const requests = await ctx.admin.listRegistrationRequests();
    res.json({ requests: requests.map(toRegistrationRequest) });
  });

  router.post(
    '/registration-requests/:id/approve',
    validateParams(idParamSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const user = await ctx.admin.approveRegistrationRequest(id, actorOf(req));
      res.json(await serializeAdminUser(user));
    },
  );

  router.post(
    '/registration-requests/:id/reject',
    validateParams(idParamSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      await ctx.admin.rejectRegistrationRequest(id, actorOf(req));
      res.json({ ok: true });
    },
  );

  router.get('/stats', async (_req, res) => {
    res.json(await ctx.admin.stats());
  });

  // Operator health snapshot (§13.4 V4-P5a): DB/Redis/provider/queue/gateway
  // status + version + uptime. Admin-only (this router is behind requireAdmin);
  // the public `/health` liveness probe stays separate and unauthenticated. The
  // bull-board queue inspector is mounted at the app root (before this router) so
  // it stays a single-level app mount for the OpenAPI coverage walker.
  router.get('/health', async (_req, res) => {
    const body = adminHealthResponseSchema.parse(await ctx.health.check());
    res.json(body);
  });

  // Global app settings (§6.12, §8): registration mode + beta toggle. Reads
  // return defaults when unset; every write is audit-logged in the service, and
  // V1 rejects any registration mode other than `closed`.
  router.get('/settings', async (_req, res) => {
    res.json(toAppSettings(await ctx.admin.getSettings()));
  });

  router.patch('/settings', validateBody(updateAppSettingsRequestSchema), async (req, res) => {
    const settings = await ctx.admin.updateSettings(
      req.valid?.body as UpdateAppSettingsRequest,
      actorOf(req),
    );
    res.json(toAppSettings(settings));
  });

  // Runtime feature kill-switches (§13.5 V5-P2 arc (c)): list the registry and
  // flip one flag. Each flip is audit-logged in the service and invalidates the
  // shared snapshot, so the gated routers/gateway refuse on the very next
  // request/connection — no redeploy. `requireAdmin` on the parent router fences
  // this to admins (404 to everyone else).
  router.get('/feature-flags', async (_req, res) => {
    res.json({ flags: await ctx.featureFlags.listForAdmin() });
  });

  router.patch(
    '/feature-flags/:key',
    validateParams(featureFlagKeyParamSchema),
    validateBody(updateFeatureFlagRequestSchema),
    async (req, res) => {
      const { key } = req.valid?.params as FeatureFlagKeyParam;
      const { enabled } = req.valid?.body as UpdateFeatureFlagRequest;
      const flags = await ctx.featureFlags.setFlag(key, enabled, actorOf(req));
      res.json({ flags });
    },
  );

  // New-account defaults (§13.4 V4-P0d): what every NEW account starts with —
  // chat on/off, default portfolio visibility, an inert developer-status flag, and
  // the seed notification matrix. Applied at registration only, never retroactively;
  // every write is audit-logged in the service.
  router.get('/account-defaults', async (_req, res) => {
    res.json(await ctx.admin.getAccountDefaults());
  });

  router.patch(
    '/account-defaults',
    validateBody(updateAccountDefaultsRequestSchema),
    async (req, res) => {
      const defaults = await ctx.admin.updateAccountDefaults(
        req.valid?.body as UpdateAccountDefaultsRequest,
        actorOf(req),
      );
      res.json(defaults);
    },
  );

  // ── Local-AI provider settings (§13.5 V5-P12, §16 2026-07-22 — LOCAL OLLAMA
  // ONLY) ──────────────────────────────────────────────────────────────────
  // The Ollama endpoint + model + per-user daily cap. NO secrets ride these
  // routes (the endpoint is a URL, never a token) and there is no cloud provider.
  // Writes are audit-logged in the service and take effect on the next request
  // (the registry resolves the active config live — no redeploy). test-connection
  // probes an endpoint and lists the models it serves (the model picker);
  // test-request goes one step further and actually generates, so the round trip
  // (endpoint + model + generation) and its latency are provable from the panel.
  // Both are read-only diagnostics against a candidate config: neither is
  // audit-logged, and test-request never spends a user's daily cap.
  router.get('/ai/settings', async (_req, res) => {
    res.json(aiSettingsResponseSchema.parse(await ctx.ai.getSettings()));
  });

  router.patch('/ai/settings', validateBody(updateAiSettingsRequestSchema), async (req, res) => {
    const settings = await ctx.ai.updateSettings(
      req.valid?.body as UpdateAiSettingsRequest,
      actorOf(req),
    );
    res.json(aiSettingsResponseSchema.parse(settings));
  });

  router.post(
    '/ai/test-connection',
    validateBody(aiTestConnectionRequestSchema),
    async (req, res) => {
      const { endpoint } = req.valid?.body as AiTestConnectionRequest;
      const result = await ctx.ai.testConnection(endpoint ?? undefined);
      res.json(aiTestConnectionResponseSchema.parse(result));
    },
  );

  router.post('/ai/test-request', validateBody(aiTestRequestSchema), async (req, res) => {
    const result = await ctx.ai.testRequest(req.valid?.body as AiTestRequest);
    res.json(aiTestRequestResponseSchema.parse(result));
  });

  router.get('/email/status', async (_req, res) => {
    res.json(ctx.admin.emailStatus());
  });

  router.post('/test-email', validateBody(testEmailRequestSchema), async (req, res) => {
    const { to } = req.valid?.body as TestEmailRequest;
    const result = await ctx.admin.sendTestEmail(to, actorOf(req));
    res.json(result);
  });

  router.get('/audit', validateQuery(auditQuerySchema), async (req, res) => {
    const query = req.valid?.query as AuditQuery;
    const { entries, nextCursor } = await ctx.admin.listAudit({
      limit: query.limit,
      cursor: query.cursor,
    });
    res.json({ entries: entries.map(toAuditEntry), nextCursor });
  });

  // Email send log (§6.10, §6.12): global and per-user, cursor-paged.
  router.get('/emails', validateQuery(emailLogQuerySchema), async (req, res) => {
    const query = req.valid?.query as EmailLogQuery;
    const { entries, nextCursor } = await ctx.admin.listEmails({
      limit: query.limit,
      cursor: query.cursor,
    });
    res.json({ entries: entries.map(toEmailLogEntry), nextCursor });
  });

  router.get(
    '/users/:id/emails',
    validateParams(idParamSchema),
    validateQuery(emailLogQuerySchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const query = req.valid?.query as EmailLogQuery;
      const { entries, nextCursor } = await ctx.admin.listUserEmails(id, {
        limit: query.limit,
        cursor: query.cursor,
      });
      res.json({ entries: entries.map(toEmailLogEntry), nextCursor });
    },
  );

  // Per-user audit history (§6.12): the same shape as the global audit log,
  // scoped to entries targeting this user.
  router.get(
    '/users/:id/audit',
    validateParams(idParamSchema),
    validateQuery(auditQuerySchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const query = req.valid?.query as AuditQuery;
      const { entries, nextCursor } = await ctx.admin.listUserAudit(id, {
        limit: query.limit,
        cursor: query.cursor,
      });
      res.json({ entries: entries.map(toAuditEntry), nextCursor });
    },
  );

  // First-party OAuth apps (§6.13 + admin, V2-P12 follow-up): the official
  // BetterTrack apps (mobile/web) register here as system-owned trusted clients,
  // not under any user account. Trusted ⇒ the consent screen is BetterTrack-branded
  // and auto-approved. Registration returns the client secret exactly once.
  router.get('/oauth-clients', async (_req, res) => {
    res.json({ clients: await ctx.oauth.listFirstPartyClients() });
  });

  router.post('/oauth-clients', validateBody(createOAuthClientRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateOAuthClientRequest;
    const result = await ctx.oauth.registerFirstPartyClient({
      adminId: req.authUser!.id,
      name: body.name,
      redirectUris: body.redirectUris,
      scopes: body.scopes,
      public: body.public,
      logoUrl: body.logoUrl ?? null,
      ip: req.ip ?? null,
    });
    res.status(201).json(result);
  });

  // Edit an existing first-party app: name, redirect URIs and allowed scopes,
  // with the same validation as creation. Consent-safe (§6.13, #341): widening
  // the scopes never widens a live user grant — the effective scope of a token is
  // clamped to the app's current allowed set at the resource layer — while
  // narrowing (removing a scope or redirect URI) takes effect immediately. The
  // client_id and secret are immutable. Audit-logged with the before/after diff.
  router.patch(
    '/oauth-clients/:id',
    validateParams(idParamSchema),
    validateBody(updateOAuthClientRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const body = req.valid?.body as UpdateOAuthClientRequest;
      const client = await ctx.oauth.updateFirstPartyClient({
        adminId: req.authUser!.id,
        id,
        name: body.name,
        redirectUris: body.redirectUris,
        scopes: body.scopes,
        logoUrl: body.logoUrl ?? null,
        ip: req.ip ?? null,
      });
      res.json(client);
    },
  );

  router.delete('/oauth-clients/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.oauth.deleteFirstPartyClient({ adminId: req.authUser!.id, id, ip: req.ip ?? null });
    res.json({ ok: true });
  });

  // ── Announcements (§13.4 V4-P5b) ────────────────────────────────────────
  // Admin CRUD over composed announcements. Every mutation is audit-logged in
  // the service; flipping `active` from off → on fans exactly one inbox row
  // out to every user (deduped per-user via the shared eventKey). Delivery is
  // banner + inbox only — no email/push/matrix routing runs.
  router.get('/announcements', async (_req, res) => {
    const announcements = await ctx.announcements.list();
    res.json({ announcements });
  });

  router.post('/announcements', validateBody(createAnnouncementRequestSchema), async (req, res) => {
    const announcement = await ctx.announcements.create(
      req.valid?.body as CreateAnnouncementRequest,
      actorOf(req),
    );
    res.status(201).json(announcement);
  });

  router.patch(
    '/announcements/:id',
    validateParams(idParamSchema),
    validateBody(updateAnnouncementRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const announcement = await ctx.announcements.update(
        id,
        req.valid?.body as UpdateAnnouncementRequest,
        actorOf(req),
      );
      res.json(announcement);
    },
  );

  router.delete('/announcements/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.announcements.remove(id, actorOf(req));
    res.status(204).send();
  });

  return router;
}

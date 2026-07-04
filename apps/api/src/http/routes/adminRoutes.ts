import { Router, type Request } from 'express';

import {
  adminUserListQuerySchema,
  auditQuerySchema,
  createInviteRequestSchema,
  createUserRequestSchema,
  deleteUserRequestSchema,
  emailLogQuerySchema,
  idParamSchema,
  testEmailRequestSchema,
  updateAppSettingsRequestSchema,
  updateUserRequestSchema,
  type AuditQuery,
  type CreateInviteRequest,
  type CreateUserRequest,
  type DeleteUserRequest,
  type EmailLogQuery,
  type TestEmailRequest,
  type UpdateAppSettingsRequest,
  type UpdateUserRequest,
} from '@bettertrack/contracts';

import type { AdminActor } from '../../services/admin/adminService';
import type { AppContext } from '../context';
import { requireAdmin } from '../middleware/session';
import type { RateLimiters } from '../middleware/rateLimit';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import {
  toAdminInvite,
  toAdminUser,
  toAppSettings,
  toAuditEntry,
  toEmailLogEntry,
} from '../serializers';

const actorOf = (req: Request): AdminActor => ({ id: req.authUser!.id, ip: req.ip });

/**
 * Admin endpoints under /api/v1/admin (PROJECTPLAN.md §6.12, §8). The router is
 * gated by `requireAdmin` (404 to everyone else); the forced-password-change
 * guard is applied globally on /api/v1 (see app.ts).
 */
export function createAdminRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.use(limiters.admin);
  router.use(requireAdmin);

  router.get('/users', validateQuery(adminUserListQuerySchema), async (req, res) => {
    const { search } = (req.valid?.query ?? {}) as { search?: string };
    const users = await ctx.admin.listUsers(search);
    res.json({ users: users.map(toAdminUser) });
  });

  router.post('/users', validateBody(createUserRequestSchema), async (req, res) => {
    const { user, tempPassword } = await ctx.admin.createUser(
      req.valid?.body as CreateUserRequest,
      actorOf(req),
    );
    res.status(201).json({ user: toAdminUser(user), tempPassword });
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
      res.json(toAdminUser(user));
    },
  );

  router.post('/users/:id/reset-password', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const { user, tempPassword } = await ctx.admin.resetPassword(id, actorOf(req));
    res.json({ user: toAdminUser(user), tempPassword });
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

  router.get('/stats', async (_req, res) => {
    res.json(await ctx.admin.stats());
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

  return router;
}

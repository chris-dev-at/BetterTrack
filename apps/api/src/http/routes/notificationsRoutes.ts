import { Router } from 'express';

import {
  announcementIdParamSchema,
  deleteDeviceRequestSchema,
  markReadRequestSchema,
  notificationBulkDeleteQuerySchema,
  notificationIdParamSchema,
  notificationListQuerySchema,
  registerDeviceRequestSchema,
  webPushSubscribeRequestSchema,
  webPushUnsubscribeRequestSchema,
  type DeleteDeviceRequest,
  type MarkReadRequest,
  type NotificationBulkDeleteQuery,
  type NotificationListQuery,
  type RegisterDeviceRequest,
  type WebPushSubscribeRequest,
  type WebPushUnsubscribeRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Notification endpoints (PROJECTPLAN.md §6.10, §8; #368, #437): inbox read +
 * mark-read, archive/unarchive + hard deletion, FCM device-token registration,
 * and web-push subscriptions. Row creation stays the dispatcher's job.
 * Everything under /notifications is covered by the
 * `notifications:read`/`notifications:write` bearer scopes (reads vs.
 * mutations — archive and delete are writes; the mobile app registers its FCM
 * token with `notifications:write`).
 *
 * Route order matters for the `:id` paths: the static `/devices`, `/web-push`
 * and bulk `/` handlers are registered first so they always win the match.
 */
export function createNotificationsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /notifications?view=&cursor=&limit= — newest-first, with unreadCount
  // (§8). `view` (#437) defaults to `active`, so pre-archive clients keep
  // working unchanged and simply stop seeing archived rows.
  router.get('/', validateQuery(notificationListQuerySchema), async (req, res) => {
    const { cursor, limit, view } = req.valid?.query as NotificationListQuery;
    const page = await ctx.notifications.list(req.authUser!.id, { cursor, limit, view });
    res.json(page);
  });

  // POST /notifications/mark-read {ids|all} — idempotent, owner-scoped (§6.10).
  router.post('/mark-read', validateBody(markReadRequestSchema), async (req, res) => {
    const body = req.valid?.body as MarkReadRequest;
    await ctx.notifications.markRead(req.authUser!.id, body);
    res.json({ ok: true });
  });

  // POST /notifications/archive-all-read — bulk-archive every read, active row
  // (#437). Idempotent; unread rows stay in the bell.
  router.post('/archive-all-read', async (req, res) => {
    await ctx.notifications.archiveAllRead(req.authUser!.id);
    res.json({ ok: true });
  });

  // DELETE /notifications?scope=archived|all — bulk hard delete (#437),
  // strictly caller-scoped. `scope` is required: no accidental bare-DELETE wipe.
  router.delete('/', validateQuery(notificationBulkDeleteQuerySchema), async (req, res) => {
    const { scope } = req.valid?.query as NotificationBulkDeleteQuery;
    await ctx.notifications.removeBulk(req.authUser!.id, scope);
    res.status(204).send();
  });

  // POST /notifications/devices {token, platform} — idempotent FCM upsert;
  // re-registering re-binds the token to the caller (#368/#351). Works with the
  // push channel unconfigured (stored for when it comes online).
  router.post('/devices', validateBody(registerDeviceRequestSchema), async (req, res) => {
    const body = req.valid?.body as RegisterDeviceRequest;
    await ctx.notifications.registerDevice(req.authUser!.id, body.token, body.platform);
    res.json({ ok: true });
  });

  // DELETE /notifications/devices {token} — drops the caller's own token only.
  router.delete('/devices', validateBody(deleteDeviceRequestSchema), async (req, res) => {
    const body = req.valid?.body as DeleteDeviceRequest;
    await ctx.notifications.deleteDevice(req.authUser!.id, body.token);
    res.json({ ok: true });
  });

  // POST /notifications/web-push {endpoint, keys} — idempotent subscription
  // upsert for the browser-push channel (#368/#350).
  router.post('/web-push', validateBody(webPushSubscribeRequestSchema), async (req, res) => {
    const body = req.valid?.body as WebPushSubscribeRequest;
    await ctx.notifications.subscribeWebPush(req.authUser!.id, body);
    res.json({ ok: true });
  });

  // DELETE /notifications/web-push {endpoint} — drops the caller's subscription.
  router.delete('/web-push', validateBody(webPushUnsubscribeRequestSchema), async (req, res) => {
    const body = req.valid?.body as WebPushUnsubscribeRequest;
    await ctx.notifications.unsubscribeWebPush(req.authUser!.id, body.endpoint);
    res.json({ ok: true });
  });

  // ── Announcements banner (§13.4 V4-P5b) ─────────────────────────────────────
  // Registered BEFORE the `:id` param routes below so `/announcements/…`
  // never resolves as `/:id/…`. Delivery of the fan-out inbox row itself
  // stays the admin service's job — this router only serves the banner list
  // and the per-user dismissal.

  // GET /notifications/announcements — active-for-me set, rendered in the
  // viewer's stored locale (EN fallback via resolveEmailLocale).
  router.get('/announcements', async (req, res) => {
    const announcements = await ctx.announcements.listActiveForUser(
      req.authUser!.id,
      req.authUser!.locale,
    );
    res.json({ announcements });
  });

  // POST /notifications/announcements/:id/dismiss — per-user dismissal.
  // Idempotent; a foreign/unknown id 404s (indistinguishable, no IDOR).
  router.post(
    '/announcements/:id/dismiss',
    validateParams(announcementIdParamSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      await ctx.announcements.dismiss(req.authUser!.id, id);
      res.json({ ok: true });
    },
  );

  // ── Per-row archive state + deletion (#437) — param routes come LAST ────────

  // POST /notifications/:id/archive — leaves the bell instantly and marks the
  // row read (a hidden-but-unread badge would lie). Foreign/unknown id → 404.
  router.post('/:id/archive', validateParams(notificationIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.notifications.archive(req.authUser!.id, id);
    res.json({ ok: true });
  });

  // POST /notifications/:id/unarchive — back to active (stays read).
  router.post('/:id/unarchive', validateParams(notificationIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.notifications.unarchive(req.authUser!.id, id);
    res.json({ ok: true });
  });

  // DELETE /notifications/:id — hard delete; a repeat (or a foreign id) 404s.
  router.delete('/:id', validateParams(notificationIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.notifications.remove(req.authUser!.id, id);
    res.status(204).send();
  });

  return router;
}

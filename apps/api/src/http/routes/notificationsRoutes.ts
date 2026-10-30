import { Router } from 'express';

import {
  acknowledgeAnnouncementRequestSchema,
  activeAnnouncementListResponseSchema,
  acknowledgeAnnouncementResponseSchema,
  announcementIdParamSchema,
  userAnnouncementQuerySchema,
  userAnnouncementSchema,
  deleteDeviceRequestSchema,
  markReadRequestSchema,
  notificationBulkDeleteQuerySchema,
  notificationIdParamSchema,
  notificationListQuerySchema,
  registerDeviceRequestSchema,
  webPushSubscribeRequestSchema,
  webPushUnsubscribeRequestSchema,
  type AcknowledgeAnnouncementRequest,
  type DeleteDeviceRequest,
  type MarkReadRequest,
  type NotificationBulkDeleteQuery,
  type NotificationListQuery,
  type RegisterDeviceRequest,
  type UserAnnouncementQuery,
  type WebPushSubscribeRequest,
  type WebPushUnsubscribeRequest,
} from '@bettertrack/contracts';

import { forbidden } from '../../errors';
import type { AcknowledgementChannel } from '../../services/announcements/userAnnouncementService';
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

  // ── Announcements (§13.4 V4-P5b; extended by §6.19, contract §4) ────────────
  // Registered BEFORE the `:id` param routes below so `/announcements/…`
  // never resolves as `/:id/…`. Every per-id route answers the same 404 for
  // an unknown id, a draft, a not-yet-open window and an announcement outside
  // the caller's audience — indistinguishable by design.

  // GET /notifications/announcements[?locale=] — the caller's open list.
  router.get(
    '/announcements',
    validateQuery(userAnnouncementQuerySchema),
    async (req, res) => {
      const { locale } = req.valid?.query as UserAnnouncementQuery;
      const announcements = await ctx.userAnnouncements.list(req.authUser!, locale);
      res.json(activeAnnouncementListResponseSchema.parse({ announcements }));
    },
  );

  // GET /notifications/announcements/:id[?locale=] — one item, ended and
  // archived ones included (the inbox deep-link, "what did I acknowledge").
  router.get(
    '/announcements/:id',
    validateParams(announcementIdParamSchema),
    validateQuery(userAnnouncementQuerySchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const { locale } = req.valid?.query as UserAnnouncementQuery;
      const announcement = await ctx.userAnnouncements.get(id, req.authUser!, locale);
      res.json(userAnnouncementSchema.parse(announcement));
    },
  );

  // POST /notifications/announcements/:id/seen — first write wins.
  router.post(
    '/announcements/:id/seen',
    validateParams(announcementIdParamSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      await ctx.userAnnouncements.seen(id, req.authUser!);
      res.json({ ok: true });
    },
  );

  // POST /notifications/announcements/:id/dismiss — notice/once only (409 for
  // ack_required); idempotent.
  router.post(
    '/announcements/:id/dismiss',
    validateParams(announcementIdParamSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      await ctx.userAnnouncements.dismiss(id, req.authUser!);
      res.json({ ok: true });
    },
  );

  // POST /notifications/announcements/:id/acknowledge — a person confirms,
  // never automation: a cookie session or a first-party OAuth token. The
  // bearer policy already refused (and audited) a personal key or a partner
  // token with `API_KEY_FORBIDDEN`; the check below is the route's own
  // default-deny, so a policy-table change can never open this to them.
  router.post(
    '/announcements/:id/acknowledge',
    validateParams(announcementIdParamSchema),
    validateBody(acknowledgeAnnouncementRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const body = req.valid?.body as AcknowledgeAnnouncementRequest;
      let channel: AcknowledgementChannel;
      if (!req.apiKey) {
        channel = { via: 'web_session' };
      } else if (req.apiKey.kind === 'oauth' && req.apiKey.firstParty) {
        channel = { via: 'first_party_oauth', grantId: req.apiKey.id };
      } else {
        throw forbidden(
          'Acknowledging requires the web app or the official app.',
          'API_KEY_FORBIDDEN',
        );
      }
      const result = await ctx.userAnnouncements.acknowledge(id, req.authUser!, body, channel);
      res.json(acknowledgeAnnouncementResponseSchema.parse(result));
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

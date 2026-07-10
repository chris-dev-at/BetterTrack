import { Router } from 'express';

import {
  deleteDeviceRequestSchema,
  markReadRequestSchema,
  notificationListQuerySchema,
  registerDeviceRequestSchema,
  webPushSubscribeRequestSchema,
  webPushUnsubscribeRequestSchema,
  type DeleteDeviceRequest,
  type MarkReadRequest,
  type NotificationListQuery,
  type RegisterDeviceRequest,
  type WebPushSubscribeRequest,
  type WebPushUnsubscribeRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Notification endpoints (PROJECTPLAN.md §6.10, §8; #368): inbox read +
 * mark-read, FCM device-token registration, and web-push subscriptions. Row
 * creation stays the dispatcher's job. Everything under /notifications is
 * covered by the `notifications:read`/`notifications:write` bearer scopes
 * (the mobile app registers its FCM token with `notifications:write`).
 */
export function createNotificationsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /notifications?cursor=&limit= — newest-first, with unreadCount (§8).
  router.get('/', validateQuery(notificationListQuerySchema), async (req, res) => {
    const { cursor, limit } = req.valid?.query as NotificationListQuery;
    const page = await ctx.notifications.list(req.authUser!.id, { cursor, limit });
    res.json(page);
  });

  // POST /notifications/mark-read {ids|all} — idempotent, owner-scoped (§6.10).
  router.post('/mark-read', validateBody(markReadRequestSchema), async (req, res) => {
    const body = req.valid?.body as MarkReadRequest;
    await ctx.notifications.markRead(req.authUser!.id, body);
    res.json({ ok: true });
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

  return router;
}

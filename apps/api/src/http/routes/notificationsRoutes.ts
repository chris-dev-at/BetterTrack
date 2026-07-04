import { Router } from 'express';

import {
  markReadRequestSchema,
  notificationListQuerySchema,
  type MarkReadRequest,
  type NotificationListQuery,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Notification read + mark-read endpoints (PROJECTPLAN.md §6.10, §8). The bell
 * dropdown and Settings → Notifications page both consume `GET /notifications`;
 * this router only exposes read/mark-read — row creation is the dispatcher's job.
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

  return router;
}

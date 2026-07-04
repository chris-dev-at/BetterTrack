import { Router } from 'express';

import {
  updateNotificationSettingsRequestSchema,
  type UpdateNotificationSettingsRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody } from '../middleware/validate';
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

  return router;
}

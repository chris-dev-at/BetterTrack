import { Router } from 'express';

import {
  alertIdParamSchema,
  createAlertRequestSchema,
  updateAlertRequestSchema,
  type CreateAlertRequest,
  type UpdateAlertRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';
import { toAlert } from '../serializers';

/** Price-alert CRUD endpoints (PROJECTPLAN.md §14, V3-P10 arc b). Controllers stay thin. */
export function createAlertsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  router.get('/', async (req, res) => {
    const items = await ctx.alerts.list(req.authUser!.id);
    res.json({ items: items.map(toAlert) });
  });

  router.post('/', validateBody(createAlertRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateAlertRequest;
    const alert = await ctx.alerts.create(req.authUser!.id, body);
    res.status(201).json(toAlert(alert));
  });

  router.patch(
    '/:id',
    validateParams(alertIdParamSchema),
    validateBody(updateAlertRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const body = req.valid?.body as UpdateAlertRequest;
      const alert = await ctx.alerts.update(req.authUser!.id, id, body);
      res.json(toAlert(alert));
    },
  );

  // POST /alerts/:id/rearm — reset a fired one-shot back to active (§14).
  router.post('/:id/rearm', validateParams(alertIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const alert = await ctx.alerts.rearm(req.authUser!.id, id);
    res.json(toAlert(alert));
  });

  router.delete('/:id', validateParams(alertIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.alerts.remove(req.authUser!.id, id);
    res.status(204).send();
  });

  return router;
}

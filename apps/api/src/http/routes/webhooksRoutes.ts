import { Router } from 'express';

import {
  createWebhookSubscriptionRequestSchema,
  idParamSchema,
  updateWebhookSubscriptionRequestSchema,
  type CreateWebhookSubscriptionRequest,
  type UpdateWebhookSubscriptionRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Outbound webhook management (§13.5 V5-P10, issue 1/2) — Settings → API Access.
 * Session-only (the bearer scope guard bars API-key/OAuth-token access to
 * `/settings/webhooks*`, like key management), and every handler is strictly
 * scoped to the caller. Mounted at `/api/v1/settings/webhooks`.
 */
export function createWebhooksRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /settings/webhooks — the caller's subscriptions (never the secret).
  router.get('/', async (req, res) => {
    const subscriptions = await ctx.webhooks.list(req.authUser!.id);
    res.json({ subscriptions });
  });

  // POST /settings/webhooks — create; the signing secret is returned once.
  router.post('/', validateBody(createWebhookSubscriptionRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateWebhookSubscriptionRequest;
    const result = await ctx.webhooks.create({
      userId: req.authUser!.id,
      url: body.url,
      description: body.description,
      eventTypes: body.eventTypes,
      ip: req.ip ?? null,
    });
    res.status(201).json(result);
  });

  // PATCH /settings/webhooks/:id — edit; flipping `enabled` true re-enables
  // (resets the failure streak), false pauses.
  router.patch(
    '/:id',
    validateParams(idParamSchema),
    validateBody(updateWebhookSubscriptionRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const body = req.valid?.body as UpdateWebhookSubscriptionRequest;
      const subscription = await ctx.webhooks.update({
        userId: req.authUser!.id,
        id,
        url: body.url,
        description: body.description,
        eventTypes: body.eventTypes,
        enabled: body.enabled,
        ip: req.ip ?? null,
      });
      res.json({ subscription });
    },
  );

  // DELETE /settings/webhooks/:id — remove (cascades its delivery log).
  router.delete('/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.webhooks.delete({ userId: req.authUser!.id, id, ip: req.ip ?? null });
    res.status(204).end();
  });

  // GET /settings/webhooks/:id/deliveries — the bounded per-subscription log.
  router.get('/:id/deliveries', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const deliveries = await ctx.webhooks.listDeliveries(req.authUser!.id, id);
    res.json({ deliveries });
  });

  return router;
}

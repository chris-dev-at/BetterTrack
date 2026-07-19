import { Router } from 'express';

import {
  createStandingOrderRequestSchema,
  standingOrderIdParamSchema,
  standingOrderListQuerySchema,
  updateStandingOrderRequestSchema,
  type CreateStandingOrderRequest,
  type StandingOrderIdParam,
  type StandingOrderListQuery,
  type UpdateStandingOrderRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Standing orders — scheduled recurring buys / cash movements (PROJECTPLAN.md
 * §13.5 V5-P6b arc (a), issue #593). Controllers stay thin: parse → service →
 * respond. Every `/:id` handler is ownership-scoped in the service (an order
 * owned by another user is a 404, never a 403 — no IDOR, §8/§10). The engine
 * (due computation + booking) is the daily `standingOrders.process` job; these
 * routes are the management surface only. Gated on the same `portfolio` scope
 * pair as the rest of the portfolio surface (see the bearer MODULE_POLICIES).
 */
export function createStandingOrdersRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /standing-orders — the caller's orders (optionally one portfolio), each
  // with its computed next-run day.
  router.get('/', validateQuery(standingOrderListQuerySchema), async (req, res) => {
    const query = req.valid?.query as StandingOrderListQuery;
    const result = await ctx.standingOrders.list(req.authUser!.id, {
      portfolioId: query.portfolioId,
    });
    res.json(result);
  });

  // POST /standing-orders — create a recurring buy / cash-add / cash-deduct.
  router.post('/', validateBody(createStandingOrderRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateStandingOrderRequest;
    const result = await ctx.standingOrders.create(req.authUser!.id, body);
    res.status(201).json(result);
  });

  // GET /standing-orders/:id — one of the caller's own orders.
  router.get('/:id', validateParams(standingOrderIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as StandingOrderIdParam;
    const result = await ctx.standingOrders.get(req.authUser!.id, id);
    res.json(result);
  });

  // PATCH /standing-orders/:id — edit amount / label / end date.
  router.patch(
    '/:id',
    validateParams(standingOrderIdParamSchema),
    validateBody(updateStandingOrderRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as StandingOrderIdParam;
      const patch = req.valid?.body as UpdateStandingOrderRequest;
      const result = await ctx.standingOrders.update(req.authUser!.id, id, patch);
      res.json(result);
    },
  );

  // POST /standing-orders/:id/pause — stop firing (keeps history; no back-fill on resume).
  router.post('/:id/pause', validateParams(standingOrderIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as StandingOrderIdParam;
    const result = await ctx.standingOrders.pause(req.authUser!.id, id);
    res.json(result);
  });

  // POST /standing-orders/:id/resume — resume firing from the current period on.
  router.post('/:id/resume', validateParams(standingOrderIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as StandingOrderIdParam;
    const result = await ctx.standingOrders.resume(req.authUser!.id, id);
    res.json(result);
  });

  // DELETE /standing-orders/:id — remove an order (its run history cascades).
  router.delete('/:id', validateParams(standingOrderIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as StandingOrderIdParam;
    await ctx.standingOrders.remove(req.authUser!.id, id);
    res.status(204).send();
  });

  return router;
}

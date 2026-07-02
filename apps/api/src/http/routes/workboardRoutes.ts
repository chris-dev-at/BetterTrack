import { Router } from 'express';

import {
  addToWorkboardRequestSchema,
  itemIdParamSchema,
  reorderWorkboardRequestSchema,
  type AddToWorkboardRequest,
  type ReorderWorkboardRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';
import { toWorkboardItem } from '../serializers';

/** Workboard endpoints (PROJECTPLAN.md §6.4, §8). Controllers stay thin. */
export function createWorkboardRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  router.get('/', async (req, res) => {
    const items = await ctx.workboard.list(req.authUser!.id);
    res.json({ items: items.map(toWorkboardItem) });
  });

  router.post('/', validateBody(addToWorkboardRequestSchema), async (req, res) => {
    const { assetId } = req.valid?.body as AddToWorkboardRequest;
    const item = await ctx.workboard.addItem(req.authUser!.id, assetId);
    res.status(201).json(toWorkboardItem(item));
  });

  router.delete('/:itemId', validateParams(itemIdParamSchema), async (req, res) => {
    const { itemId } = req.valid?.params as { itemId: string };
    await ctx.workboard.removeItem(req.authUser!.id, itemId);
    res.status(204).send();
  });

  router.patch('/reorder', validateBody(reorderWorkboardRequestSchema), async (req, res) => {
    const { itemIds } = req.valid?.body as ReorderWorkboardRequest;
    await ctx.workboard.reorder(req.authUser!.id, itemIds);
    res.json({ ok: true });
  });

  return router;
}

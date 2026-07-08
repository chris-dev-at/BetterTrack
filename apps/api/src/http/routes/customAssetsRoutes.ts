import { Router } from 'express';

import {
  createCustomAssetRequestSchema,
  customAssetIdParamSchema,
  putValuePointsRequestSchema,
  updateCustomAssetRequestSchema,
  type CreateCustomAssetRequest,
  type PutValuePointsRequest,
  type UpdateCustomAssetRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';

/** Custom-investment endpoints (PROJECTPLAN.md §6.9, §8). Controllers stay thin. */
export function createCustomAssetsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /custom-assets/recategorization — how many custom assets still carry the
  // V3-P2 migration flag (drives the one-time re-categorize banner). Declared
  // before `/:id`-style routes so the literal path is matched first.
  router.get('/recategorization', async (req, res) => {
    const status = await ctx.customAssets.recategorizationStatus(req.authUser!.id);
    res.json(status);
  });

  // POST /custom-assets/recategorization/dismiss — clear every re-categorize flag.
  router.post('/recategorization/dismiss', async (req, res) => {
    await ctx.customAssets.dismissRecategorization(req.authUser!.id);
    res.status(204).send();
  });

  // POST /custom-assets — create a custom asset, optional initial BUY (§6.9).
  router.post('/', validateBody(createCustomAssetRequestSchema), async (req, res) => {
    const input = req.valid?.body as CreateCustomAssetRequest;
    const result = await ctx.customAssets.create(req.authUser!.id, input);
    res.status(201).json(result);
  });

  // PATCH /custom-assets/:id — edit name/category (currency is immutable).
  router.patch(
    '/:id',
    validateParams(customAssetIdParamSchema),
    validateBody(updateCustomAssetRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const patch = req.valid?.body as UpdateCustomAssetRequest;
      const asset = await ctx.customAssets.update(req.authUser!.id, id, patch);
      res.json({ asset });
    },
  );

  // DELETE /custom-assets/:id — remove the asset (cascades to txns + value points).
  router.delete('/:id', validateParams(customAssetIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.customAssets.remove(req.authUser!.id, id);
    res.status(204).send();
  });

  // GET /custom-assets/:id/value-points — list, ascending by date (§6.9).
  router.get('/:id/value-points', validateParams(customAssetIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const points = await ctx.customAssets.getValuePoints(req.authUser!.id, id);
    res.json({ points });
  });

  // PUT /custom-assets/:id/value-points — full replace; add/edit/delete (§6.9).
  router.put(
    '/:id/value-points',
    validateParams(customAssetIdParamSchema),
    validateBody(putValuePointsRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const { points } = req.valid?.body as PutValuePointsRequest;
      const stored = await ctx.customAssets.putValuePoints(req.authUser!.id, id, points);
      res.json({ points: stored });
    },
  );

  return router;
}

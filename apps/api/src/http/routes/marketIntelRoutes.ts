import { Router } from 'express';

import { assetIdParamSchema } from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateParams } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Per-asset market-intelligence reads (PROJECTPLAN.md §13.5 V5-P5): the
 * capability descriptor plus the four event families. Mounted under
 * `/api/v1/assets` alongside the asset detail routes and auth-guarded the same
 * way (`requireUser` + the §10 asset-scoping enforced in the service). Every
 * handler returns 200 with a contract-validated body — the "unconfigured" shape
 * (`available: false`) when the global gate is off, the provider lacks the
 * capability, or the upstream errored — so an asset page never 5xxs on intel.
 */
export function createMarketIntelRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /assets/:id/intel — capability descriptor (gate + per-capability map).
  router.get('/:id/intel', validateParams(assetIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    res.json(await ctx.marketIntel.capabilities(req.authUser!.id, id));
  });

  // GET /assets/:id/intel/dividends — history + upcoming ex/pay + forward yield.
  router.get('/:id/intel/dividends', validateParams(assetIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    res.json(await ctx.marketIntel.dividends(req.authUser!.id, id));
  });

  // GET /assets/:id/intel/earnings — next + recent earnings reports.
  router.get('/:id/intel/earnings', validateParams(assetIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    res.json(await ctx.marketIntel.earnings(req.authUser!.id, id));
  });

  // GET /assets/:id/intel/news — recent headlines.
  router.get('/:id/intel/news', validateParams(assetIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    res.json(await ctx.marketIntel.news(req.authUser!.id, id));
  });

  // GET /assets/:id/intel/splits — past + announced splits.
  router.get('/:id/intel/splits', validateParams(assetIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    res.json(await ctx.marketIntel.splits(req.authUser!.id, id));
  });

  return router;
}

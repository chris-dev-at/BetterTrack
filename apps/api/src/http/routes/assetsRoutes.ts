import { Router } from 'express';

import { assetIdParamSchema, historyQuerySchema, type HistoryQuery } from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/** Asset detail/quote/history endpoints (PROJECTPLAN.md §6.3, §8). */
export function createAssetsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /assets/:id — meta + latest quote.
  router.get('/:id', validateParams(assetIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const detail = await ctx.assets.getDetail(req.authUser!.id, id, {
      baseCurrency: req.authUser!.baseCurrency,
    });
    res.json(detail);
  });

  // GET /assets/:id/quote — latest quote with stale/asOf markers.
  router.get('/:id/quote', validateParams(assetIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const quote = await ctx.assets.getQuote(req.authUser!.id, id);
    res.json(quote);
  });

  // GET /assets/:id/history?range= — series for a range; interval per §5.3.
  router.get(
    '/:id/history',
    validateParams(assetIdParamSchema),
    validateQuery(historyQuerySchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const { range } = req.valid?.query as HistoryQuery;
      const history = await ctx.assets.getHistory(req.authUser!.id, id, range);
      res.json(history);
    },
  );

  // GET /assets/:id/daily-closes — full daily close series for the linked
  // date ↔ price transaction fields (#226). Cached-series only, no per-keystroke
  // provider calls (§5.3); degrades to an empty series rather than erroring.
  router.get('/:id/daily-closes', validateParams(assetIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const series = await ctx.assets.getDailyCloses(req.authUser!.id, id);
    res.json(series);
  });

  return router;
}

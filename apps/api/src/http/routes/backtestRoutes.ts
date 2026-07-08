import { Router } from 'express';

import { backtestPreviewRequestSchema, type BacktestPreviewRequest } from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Backtest endpoints (PROJECTPLAN.md §6.5, §6.6, §7.2). `POST /backtest/preview`
 * backtests the Builder's *unsaved* draft basket over inline positions — no
 * saved Conglomerate required. Authenticated like every other user route; the
 * controller stays thin (parse → service → respond). The saved-conglomerate
 * variant (`GET /conglomerates/:id/backtest`) reuses this service in a later
 * P4 issue.
 */
export function createBacktestRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // POST /backtest/preview — inline {positions, range, benchmark?, mode?} →
  // base-100 series + stats (+ §14 entry events in the late-listing modes).
  router.post('/preview', validateBody(backtestPreviewRequestSchema), async (req, res) => {
    const body = req.valid?.body as BacktestPreviewRequest;
    const result = await ctx.backtest.runPreview(req.authUser!.id, {
      positions: body.positions,
      range: body.range,
      benchmark: body.benchmark ?? null,
      mode: body.mode,
    });
    res.json(result);
  });

  return router;
}

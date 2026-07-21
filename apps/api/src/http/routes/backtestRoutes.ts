import { Router } from 'express';

import {
  backtestComparisonRequestSchema,
  backtestPreviewRequestSchema,
  conglomerateIdParamSchema,
  sharedSandboxPreviewRequestSchema,
  type BacktestComparisonRequest,
  type BacktestPreviewRequest,
  type SharedSandboxPreviewRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
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

  // POST /backtest/preview — inline {positions, range, benchmark?, mode?,
  // rebalance?} → base-100 series + stats (+ §14 entry events in the
  // late-listing modes, + V4-P7 rebalance events under a schedule).
  router.post('/preview', validateBody(backtestPreviewRequestSchema), async (req, res) => {
    const body = req.valid?.body as BacktestPreviewRequest;
    const result = await ctx.backtest.runPreview(
      req.authUser!.id,
      {
        positions: body.positions,
        range: body.range,
        benchmark: body.benchmark ?? null,
        mode: body.mode,
        rebalance: body.rebalance,
      },
      { baseCurrency: req.authUser!.baseCurrency },
    );
    res.json(result);
  });

  // POST /backtest/compare — overlay 2–6 of the caller's own conglomerates on
  // one shared window (§13.5 V5-P6): {conglomerateIds, range, mode?, rebalance?,
  // baselineId?} → per-series base-100 curve + full stats + per-metric deltas
  // vs the baseline. N=7 is rejected by the contract before this runs.
  router.post('/compare', validateBody(backtestComparisonRequestSchema), async (req, res) => {
    const body = req.valid?.body as BacktestComparisonRequest;
    const result = await ctx.backtest.runComparison(
      req.authUser!.id,
      {
        conglomerateIds: body.conglomerateIds,
        range: body.range,
        mode: body.mode,
        rebalance: body.rebalance,
        baselineId: body.baselineId,
      },
      { baseCurrency: req.authUser!.baseCurrency },
    );
    res.json(result);
  });

  // POST /backtest/shared/:conglomerateId/preview — the V5-P6 arc-c what-if
  // sandbox: backtest a FRIEND-SHARED conglomerate with the viewer's local weight
  // tweaks. Guarded by the SAME share authorization the shared view uses (inside
  // the service), so an unauthorized viewer gets a 404; the tweak set is pinned
  // to the shared basket's constituents and only public catalog assets are
  // priced, so nothing beyond the share leaks. A pure read — no writes.
  router.post(
    '/shared/:conglomerateId/preview',
    validateParams(conglomerateIdParamSchema),
    validateBody(sharedSandboxPreviewRequestSchema),
    async (req, res) => {
      const { conglomerateId } = req.valid?.params as { conglomerateId: string };
      const body = req.valid?.body as SharedSandboxPreviewRequest;
      const result = await ctx.backtest.runSharedSandboxPreview(
        req.authUser!.id,
        {
          conglomerateId,
          positions: body.positions,
          range: body.range,
          mode: body.mode,
          rebalance: body.rebalance,
        },
        { baseCurrency: req.authUser!.baseCurrency },
      );
      res.json(result);
    },
  );

  return router;
}

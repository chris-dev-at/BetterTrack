import { Router, type Request } from 'express';

import {
  backtestComparisonRequestSchema,
  backtestPreviewRequestSchema,
  conglomerateIdParamSchema,
  sharedSandboxPreviewRequestSchema,
  COMPARISON_MAX_SERIES,
  COMPARISON_MIN_SERIES,
  MAX_FLATTENED_POSITIONS,
  type BacktestComparisonRequest,
  type BacktestPreviewRequest,
  type SharedSandboxPreviewRequest,
} from '@bettertrack/contracts';

import type { RateLimiters } from '../middleware/rateLimit';
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
/**
 * How many series a comparison asks to overlay — the multiplier on the PER-SERIES
 * `backtestCompare` weight (§10 COST TABLE, #1755). Read off the RAW body,
 * because the meter runs before `validateBody` exactly as `/preview`'s does: a
 * malformed body must not be a free pass to the most expensive read in the app.
 * The count is clamped to the contract's own bounds, so a caller cannot price
 * its own request — an absent or garbage list pays the minimum a valid one
 * would, and an oversized one pays the cap it is about to be refused at.
 */
function comparisonSeriesCount(req: Request): number {
  const ids = (req.body as { conglomerateIds?: unknown } | undefined)?.conglomerateIds;
  const asked = Array.isArray(ids) ? ids.length : 0;
  return Math.min(Math.max(asked, COMPARISON_MIN_SERIES), COMPARISON_MAX_SERIES);
}

/**
 * One priced unit of preview work: the §6.5 per-basket write cap. A Builder
 * draft never exceeds it, so a Builder preview is exactly one unit and costs
 * what it always did.
 */
const PREVIEW_BASKET_UNIT = 50;

/**
 * How many basket units a preview asks for — the multiplier on `backtestPreview`
 * (§10 COST TABLE, #1877). Since the preview bound became
 * {@link MAX_FLATTENED_POSITIONS}, one body may carry a nested blueprint's whole
 * resolved flatten: five Builder drafts' worth of sequential history walking at
 * a one-draft price. Read off the RAW body exactly as the comparison count is,
 * because the meter runs before `validateBody`, and clamped to the contract's
 * own bounds — an absent or garbage list pays the minimum a valid one would, an
 * oversized one pays the cap it is about to be refused at.
 */
function previewBasketUnits(req: Request): number {
  const positions = (req.body as { positions?: unknown } | undefined)?.positions;
  const asked = Array.isArray(positions) ? positions.length : 0;
  const bounded = Math.min(Math.max(asked, 1), MAX_FLATTENED_POSITIONS);
  return Math.ceil(bounded / PREVIEW_BASKET_UNIT);
}

export function createBacktestRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.use(requireUser);

  // POST /backtest/preview — inline {positions, range, benchmark?, mode?,
  // rebalance?} → base-100 series + stats (+ §14 entry events in the
  // late-listing modes, + V4-P7 rebalance events under a schedule).
  //
  // Cost-metered (§10 COST TABLE, #1643): perturbing the weight vector makes
  // every request a cache MISS by construction, and a miss walks the positions'
  // history sequentially through the provider layer — so this one spends 25
  // work units, not one request. Since #1877 that price is PER 50-POSITION
  // BASKET UNIT: the body may carry a nested blueprint's whole 250-asset
  // flatten, and five drafts' worth of work is not one draft's price.
  router.post(
    '/preview',
    limiters.cost('backtestPreview', previewBasketUnits),
    validateBody(backtestPreviewRequestSchema),
    async (req, res) => {
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
    },
  );

  // POST /backtest/compare — overlay 2–6 of the caller's own conglomerates on
  // one shared window (§13.5 V5-P6): {conglomerateIds, range, mode?, rebalance?,
  // baselineId?} → per-series base-100 curve + full stats + per-metric deltas
  // vs the baseline. N=7 is rejected by the contract before this runs.
  //
  // Cost-metered (§10 COST TABLE, #1755) at the per-series `backtestCompare`
  // weight × the number of series asked for: this is `/preview`'s cache-missing
  // history walk done N times over baskets that each flatten to up to 250
  // assets, so pricing it as one flat request — or, as it shipped, not at all —
  // left the single most expensive read in the app bounded only by the app-wide
  // request COUNT at 600/min.
  router.post(
    '/compare',
    limiters.cost('backtestCompare', comparisonSeriesCount),
    validateBody(backtestComparisonRequestSchema),
    async (req, res) => {
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
    },
  );

  // POST /backtest/shared/:conglomerateId/preview — the V5-P6 arc-c what-if
  // sandbox: backtest a FRIEND-SHARED conglomerate with the viewer's local weight
  // tweaks. Guarded by the SAME share authorization the shared view uses (inside
  // the service), so an unauthorized viewer gets a 404; the tweak set is pinned
  // to the shared basket's top-level constituents. Flat baskets keep their
  // original full response, while nested baskets use an aggregate response that
  // never exposes recursively-resolved descendant identities. A pure read — no
  // writes.
  //
  // Cost-metered (§10 COST TABLE, #1755) at a preview's weight: it is the same
  // engine run over a comparable basket, and deliberately has NO Redis memo, so
  // every request computes where a preview may be answered from cache.
  router.post(
    '/shared/:conglomerateId/preview',
    limiters.cost('backtestSharedSandbox'),
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

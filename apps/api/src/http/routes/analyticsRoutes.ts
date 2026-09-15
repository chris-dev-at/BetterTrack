import { Router } from 'express';

import {
  analyticsSeriesQuerySchema,
  portfolioIdParamSchema,
  type AnalyticsSeriesQuery,
} from '@bettertrack/contracts';

import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Analytics deep-dive endpoints (PROJECTPLAN.md §13.3 V3-P9).
 *
 * Session-authenticated (`requireUser`); bearer clients reach these with the
 * `portfolio:read` scope, declared in the module-policy map in `bearerAuth.ts`.
 * Read-only: the entire graph configuration — free date range, value/perf mode,
 * per-asset visibility, category/type filters, an optional compare target and
 * an optional inflation mode — travels in the query string.
 */
export function createAnalyticsRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();
  router.use(requireUser);

  // GET /analytics/portfolios/:portfolioId/series — the configurable main graph
  // (primary + optional compare series with per-series stats) plus the per-asset
  // contribution table. Ownership is enforced in the service (404 on a foreign id).
  //
  // Cost-metered (§10 COST TABLE, #1643): assembling the primary series, an
  // optional compare series and the contribution table is worth 10 work units.
  // That weight is sized against the DATA — `getAssetValueSeries` takes no
  // window, and each compare resolver fetches its full history and post-filters
  // — so `from`/`to` never drove the cost and the separate
  // `ANALYTICS_MAX_RANGE_DAYS` bound in the service is a request-sanity guard,
  // not the reason this number is what it is.
  router.get(
    '/portfolios/:portfolioId/series',
    limiters.cost('analyticsSeries'),
    validateParams(portfolioIdParamSchema),
    validateQuery(analyticsSeriesQuerySchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const query = req.valid?.query as AnalyticsSeriesQuery;
      const result = await ctx.analytics.getSeries(req.authUser!.id, portfolioId, query);
      res.json(result);
    },
  );

  return router;
}

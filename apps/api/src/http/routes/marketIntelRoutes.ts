import { Router } from 'express';

import {
  assetIdParamSchema,
  fundamentalsQuerySchema,
  projectedDividendIncomeQuerySchema,
} from '@bettertrack/contracts';
import type { FundamentalsQuery, ProjectedDividendIncomeQuery } from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Per-asset market-intelligence reads (PROJECTPLAN.md §13.5 V5-P5): the
 * capability descriptor, the four event families and the fundamentals arc
 * (INTEL1). Mounted under `/api/v1/assets` alongside the asset detail routes and
 * auth-guarded the same way (`requireUser` + the §10 asset-scoping enforced in
 * the service; bearer callers are further gated on `market:read` by the module
 * scope map). Every handler returns 200 with a contract-validated body — the
 * "unconfigured" shape (`available: false`) when the global gate is off, the
 * provider lacks the capability, or the upstream errored — so an asset page
 * never 5xxs on intel.
 */
export function createMarketIntelRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // Portfolio-level market-intelligence feeds (§13.5 V5-P5). Registered BEFORE
  // the `/:id/intel*` routes so their literal first segment (`intel` / `portfolio`)
  // is never captured as an `:id`. Each aggregates over the CALLER's own holdings
  // + watchlists, so they need no id param — just the authed user (§10).

  // GET /assets/intel/earnings-calendar — the caller's upcoming-earnings feed
  // across held + watched assets (the Workboard panel, arc b).
  router.get('/intel/earnings-calendar', async (req, res) => {
    res.json(await ctx.marketIntel.earningsCalendar(req.authUser!.id));
  });

  // GET /assets/portfolio/dividend-calendar — upcoming ex/pay across held + watched.
  router.get('/portfolio/dividend-calendar', async (req, res) => {
    res.json(await ctx.portfolioMarketIntel.dividendCalendar(req.authUser!.id));
  });

  // GET /assets/portfolio/dividend-projection[?portfolioId=…] — projected income
  // (monthly/yearly EUR). Unscoped it spans every active portfolio; the optional
  // id narrows it to one, which is what the Forecast's dividend factor needs
  // (its curve is a single portfolio's net worth).
  router.get(
    '/portfolio/dividend-projection',
    validateQuery(projectedDividendIncomeQuerySchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.query as ProjectedDividendIncomeQuery;
      res.json(await ctx.portfolioMarketIntel.projectedIncome(req.authUser!.id, portfolioId));
    },
  );

  // GET /assets/portfolio/news-digest — recent headlines across held + watched,
  // grouped per asset, newest-first (arc c).
  router.get('/portfolio/news-digest', async (req, res) => {
    res.json(await ctx.marketIntel.newsDigest(req.authUser!.id));
  });

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

  // GET /assets/:id/intel/fundamentals?period=annual|quarterly&limit=1..12 —
  // revenue/statements/ratios (INTEL1). A bad `period` is a 400 (VALIDATION_ERROR);
  // `limit` is clamped, not rejected. Registered after `/:id/intel/*` siblings.
  router.get(
    '/:id/intel/fundamentals',
    validateParams(assetIdParamSchema),
    validateQuery(fundamentalsQuerySchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const query = req.valid?.query as FundamentalsQuery;
      res.json(await ctx.marketIntel.fundamentals(req.authUser!.id, id, query));
    },
  );

  return router;
}

import { Router } from 'express';

import { searchQuerySchema, type SearchQuery } from '@bettertrack/contracts';

import type { RateLimiters } from '../middleware/rateLimit';
import { requireAuth } from '../middleware/session';
import { validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/** Search endpoint (PROJECTPLAN.md §6.2, §8). Controller stays thin. */
export function createSearchRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.use(requireAuth);

  // GET /search?q= — provider search merged with the caller's custom assets,
  // rate-limited 60/min/user (§6.2, §10).
  router.get('/', limiters.search, validateQuery(searchQuerySchema), async (req, res) => {
    const { q } = req.valid?.query as SearchQuery;
    const results = await ctx.assets.search(req.authUser!.id, q);
    res.json({ results });
  });

  return router;
}

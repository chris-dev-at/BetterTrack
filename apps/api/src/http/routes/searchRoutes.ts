import { Router } from 'express';

import { searchQuerySchema, type SearchQuery } from '@bettertrack/contracts';

import { conditionalGet, CONDITIONAL_LAST_MODIFIED } from '../middleware/conditional';
import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/** Search endpoint (PROJECTPLAN.md §6.2, §8). Controller stays thin. */
export function createSearchRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.use(requireUser);

  // GET /search?q= — local-first catalog search merged with the caller's custom
  // assets, rate-limited 60/min/user (§6.2, §10). Answers from Postgres only;
  // `enriching: true` means a background provider search was kicked off and the
  // client may refetch shortly ("Searching providers…").
  // Conditional read (V5-P1b, #555): per-user body-derived ETag + a catalog
  // Last-Modified watermark. No live "today" here, so If-Modified-Since may gate
  // a 304 too. The identity-salted ETag keeps validators from crossing the auth
  // boundary — no catalog-state leak between users.
  router.get(
    '/',
    limiters.search,
    validateQuery(searchQuerySchema),
    conditionalGet(),
    async (req, res) => {
      const { q } = req.valid?.query as SearchQuery;
      const { results, enriching } = await ctx.search.search(req.authUser!.id, q);
      const freshness = await ctx.search.catalogFreshness(req.authUser!.id);
      if (freshness) res.locals[CONDITIONAL_LAST_MODIFIED] = freshness;
      res.json({ results, enriching });
    },
  );

  return router;
}

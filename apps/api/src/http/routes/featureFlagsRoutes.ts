import { Router } from 'express';

import { featureFlagsResponseSchema } from '@bettertrack/contracts';

import type { AppContext } from '../context';

/**
 * Public SPA-bootstrap advertisement of the effective feature flags
 * (PROJECTPLAN.md §13.5 V5-P2 arc (c)). Mirrors the deploy-level capability
 * flags: the client reads this once and hides any killed surface. Every gated
 * feature is authenticated anyway, so this read carries nothing sensitive — it
 * is just the on/off map, read per request off the cheap Redis snapshot.
 */
export function createFeatureFlagsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const flags = await ctx.featureFlags.getEffectiveFlags();
    res.json(featureFlagsResponseSchema.parse({ flags }));
  });

  return router;
}

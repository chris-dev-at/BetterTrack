import { Router } from 'express';

import { featureFlagsResponseSchema } from '@bettertrack/contracts';

import type { AppContext } from '../context';

/**
 * Public SPA-bootstrap advertisement of the effective feature flags
 * (PROJECTPLAN.md §13.5 V5-P2 arc (c)) plus this deployment's fixed
 * capabilities: the client reads this once and hides any killed surface. Every
 * gated feature is authenticated anyway, so this read carries nothing sensitive
 * — it is just the on/off map, read per request off the cheap Redis snapshot,
 * next to the env-set capability bits which cost nothing at all.
 *
 * `capabilities.marketIntel` is the very `MARKET_INTEL_ENABLED` value already
 * threaded into `marketIntelService` (§13.5 V5-P5), served here so the SPA can
 * drop the market-intel destinations rather than route to a page that reports a
 * deploy-level kill-switch as an empty feed.
 */
export function createFeatureFlagsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const flags = await ctx.featureFlags.getEffectiveFlags();
    res.json(
      featureFlagsResponseSchema.parse({
        flags,
        capabilities: { marketIntel: ctx.config.marketIntel.enabled },
      }),
    );
  });

  return router;
}

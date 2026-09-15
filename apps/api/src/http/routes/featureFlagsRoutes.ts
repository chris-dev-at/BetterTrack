import { Router } from 'express';

import { featureFlagsResponseSchema } from '@bettertrack/contracts';

import { principalFromUserId } from '../../services/featureFlags/featureFlagResolution';
import type { AppContext } from '../context';

/**
 * Public SPA-bootstrap advertisement of the effective feature flags
 * (PROJECTPLAN.md §13.5 V5-P2 arc (c)) plus this deployment's fixed
 * capabilities: the client reads this and hides any killed surface.
 *
 * `capabilities.marketIntel` is the very `MARKET_INTEL_ENABLED` value already
 * threaded into `marketIntelService` (§13.5 V5-P5), served here so the SPA can
 * drop the market-intel destinations rather than route to a page that reports a
 * deploy-level kill-switch as an empty feed.
 *
 * ## Since #1910 this response is PRINCIPAL-DEPENDENT
 *
 * Two consequences, and both are security properties rather than niceties:
 *
 *  1. **It carries resolved booleans and nothing else.** `rolloutPercent` and
 *     the two user-id lists are operator state; an anonymous endpoint that
 *     published which accounts are in an allowlist would be leaking user
 *     identifiers to the whole internet. `featureFlagsPublicSchema` is
 *     `.strict()` over booleans, so a field added upstream cannot ride along by
 *     accident, and the suite asserts the serialized body as well.
 *  2. **It is `Cache-Control: no-store`.** Two principals legitimately get
 *     different answers from the same URL now, so any shared cache — a CDN, a
 *     reverse proxy, the browser's own store on a shared machine — could serve
 *     one user's resolution to another. `no-store` (not merely `private`) also
 *     keeps the answer from surviving a logout on the client, which is what
 *     makes the SPA's post-login refetch honest.
 *
 * An anonymous caller resolves a partially-rolled flag as OFF (see
 * `resolveFeatureFlag`): advertising a module that most accounts would then get
 * `404 FEATURE_DISABLED` from is worse than not advertising it at all.
 */
export function createFeatureFlagsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const flags = await ctx.featureFlags.resolveAll(principalFromUserId(req.authUser?.id));
    res.set('Cache-Control', 'no-store');
    res.json(
      featureFlagsResponseSchema.parse({
        flags,
        capabilities: { marketIntel: ctx.config.marketIntel.enabled },
      }),
    );
  });

  return router;
}

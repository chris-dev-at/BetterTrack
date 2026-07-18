import type { RequestHandler } from 'express';

import type { FeatureFlagKey } from '@bettertrack/contracts';

import { notFound } from '../../errors';
import type { AppContext } from '../context';

/**
 * Runtime feature guard (PROJECTPLAN.md §13.5 V5-P2 arc (c)). Evaluates the
 * kill-switch AT REQUEST TIME — an admin flip refuses the gated router on the
 * very next request, no redeploy. A killed feature 404s (clean not-found, no
 * leak); the SPA independently hides the surface via the advertised flags, so a
 * request only reaches here on a stale client or a direct API call.
 *
 * Reads `ctx.featureFlags` per request, so the factory stays side-effect free at
 * mount time.
 */
export function requireFeature(ctx: AppContext, key: FeatureFlagKey): RequestHandler {
  return (_req, _res, next) => {
    ctx.featureFlags
      .isEnabled(key)
      .then((enabled) => {
        if (enabled) {
          next();
          return;
        }
        next(notFound('This feature is currently unavailable.', 'FEATURE_DISABLED'));
      })
      .catch(next);
  };
}

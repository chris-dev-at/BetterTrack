import type { RequestHandler } from 'express';

import type { FeatureFlagKey } from '@bettertrack/contracts';

import { notFound } from '../../errors';
import { principalFromUserId } from '../../services/featureFlags/featureFlagResolution';
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
 *
 * Since #1910 it resolves against the CALLING PRINCIPAL: `req.authUser` is set
 * by `loadSession` for a cookie request and by `loadBearerAuth` for an API-key
 * or OAuth one, so both kinds of authenticated caller get their own rollout
 * answer. A request with no identity at all resolves as anonymous, i.e. it sees
 * a partially-rolled feature as OFF — every gated router below is authenticated
 * anyway, so that path ends in a 401 either way; what it must never do is hand
 * an unidentified caller the fully-rolled answer.
 */
export function requireFeature(ctx: AppContext, key: FeatureFlagKey): RequestHandler {
  return (req, _res, next) => {
    ctx.featureFlags
      .isEnabled(key, principalFromUserId(req.authUser?.id))
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

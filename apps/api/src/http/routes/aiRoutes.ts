import { Router } from 'express';

import { aiCapabilityResponseSchema } from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import type { AppContext } from '../context';

/**
 * User-facing AI surface (PROJECTPLAN.md §13.5 V5-P12, §16 2026-07-22 — LOCAL AI
 * ONLY). Mounted at /api/v1/ai behind the session chain. In issue 1/2 it exposes
 * exactly ONE read — the capability descriptor ("is AI available for me + how
 * much of my daily cap is left") the SPA keys visibility off. No provider
 * configured (or the `ai` feature flag off) ⇒ `available: false`, and nothing
 * AI-related renders.
 *
 * Like the market-intel router, this is ALWAYS mounted and returns the "disabled"
 * shape rather than 404ing, so the client has one stable read regardless of
 * config. Issue 2/2's generation endpoints (insights, NL builder) will mount
 * here behind `requireFeature('ai')` and consume `ctx.ai.complete`.
 */
export function createAiRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  router.get('/capability', async (req, res) => {
    res.json(aiCapabilityResponseSchema.parse(await ctx.ai.capability(req.authUser!.id)));
  });

  return router;
}

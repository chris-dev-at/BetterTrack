import { Router } from 'express';

import {
  aiCapabilityResponseSchema,
  aiConglomerateDraftRequestSchema,
  aiConglomerateDraftResponseSchema,
  aiInsightsRequestSchema,
  aiInsightsResponseSchema,
} from '@bettertrack/contracts';

import { requireFeature } from '../middleware/featureFlag';
import { requireUser } from '../middleware/session';
import { validateBody } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * User-facing AI surface (PROJECTPLAN.md §13.5 V5-P12, §16 2026-07-22 — LOCAL AI
 * ONLY). Mounted at /api/v1/ai behind the session chain. The capability read
 * ("is AI available for me + how much of my daily cap is left") is ALWAYS mounted
 * and returns the "disabled" shape rather than 404ing, so the SPA has one stable
 * gate — no provider configured (or the `ai` feature flag off) ⇒ `available:
 * false` and nothing AI-related renders.
 *
 * Issue 2/2 adds the two generation endpoints (insights + NL conglomerate
 * builder) behind `requireFeature('ai')`. Both flow through `ctx.aiFeatures`,
 * which consumes the same guarded, capped `ctx.ai.complete` path — so an
 * unconfigured provider raises the typed 503, and cap exhaustion the typed 429,
 * on both. The model only PHRASES / extracts intent; every number and asset id
 * is service-computed.
 */
export function createAiRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  router.get('/capability', async (req, res) => {
    res.json(aiCapabilityResponseSchema.parse(await ctx.ai.capability(req.authUser!.id)));
  });

  // Portfolio insights: service-computed observations phrased by the model.
  // Informational only — the response carries no action and nothing is mutated.
  router.post(
    '/insights',
    requireFeature(ctx, 'ai'),
    validateBody(aiInsightsRequestSchema),
    async (req, res) => {
      const body = aiInsightsRequestSchema.parse(req.body);
      res.json(
        aiInsightsResponseSchema.parse(await ctx.aiFeatures.insights(req.authUser!.id, body)),
      );
    },
  );

  // NL conglomerate builder: a DRAFT only (model extracts intents, the local
  // catalog resolves assets). The client prefills the builder; the user saves.
  router.post(
    '/conglomerate-draft',
    requireFeature(ctx, 'ai'),
    validateBody(aiConglomerateDraftRequestSchema),
    async (req, res) => {
      const body = aiConglomerateDraftRequestSchema.parse(req.body);
      res.json(
        aiConglomerateDraftResponseSchema.parse(
          await ctx.aiFeatures.conglomerateDraft(req.authUser!.id, body),
        ),
      );
    },
  );

  return router;
}

import { Router } from 'express';

import {
  createIdeaRequestSchema,
  ideaIdParamSchema,
  updateIdeaRequestSchema,
  type CreateIdeaRequest,
  type UpdateIdeaRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Ideas — saved & shareable Workboard analyses (PROJECTPLAN.md §13.4 V4-P9).
 * Controllers stay thin: parse → service → respond. Every `/:ideaId` handler is
 * ownership-scoped in the service (an idea owned by another user is a 404, never
 * a 403 — no IDOR, §8), except `POST /:ideaId/clone`, which is audience-gated
 * through the ONE enforcement layer.
 *
 * Ideas are a Workboard surface, so the bearer middleware maps `/ideas` to the
 * `workboard:read` / `workboard:write` scope pair. Sharing an idea is done via
 * the shared `PUT /social/audience/idea/:subjectId` path — never a route here.
 */
export function createIdeasRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /ideas — the caller's saved ideas, newest first.
  router.get('/', async (req, res) => {
    const list = await ctx.ideas.list(req.authUser!.id);
    res.json(list);
  });

  // POST /ideas — persist a named Workboard state (conglomerate ref | ad-hoc set).
  router.post('/', validateBody(createIdeaRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateIdeaRequest;
    const result = await ctx.ideas.create(req.authUser!.id, body);
    res.status(201).json(result);
  });

  // GET /ideas/:ideaId — one of the caller's own ideas (exact saved state).
  router.get('/:ideaId', validateParams(ideaIdParamSchema), async (req, res) => {
    const { ideaId } = req.valid?.params as { ideaId: string };
    const result = await ctx.ideas.get(req.authUser!.id, ideaId);
    res.json(result);
  });

  // PATCH /ideas/:ideaId — rename, re-note, or re-save the Workboard state.
  router.patch(
    '/:ideaId',
    validateParams(ideaIdParamSchema),
    validateBody(updateIdeaRequestSchema),
    async (req, res) => {
      const { ideaId } = req.valid?.params as { ideaId: string };
      const patch = req.valid?.body as UpdateIdeaRequest;
      const result = await ctx.ideas.update(req.authUser!.id, ideaId, patch);
      res.json(result);
    },
  );

  // DELETE /ideas/:ideaId — hard-delete an own idea (+ its audience row).
  router.delete('/:ideaId', validateParams(ideaIdParamSchema), async (req, res) => {
    const { ideaId } = req.valid?.params as { ideaId: string };
    await ctx.ideas.remove(req.authUser!.id, ideaId);
    res.status(204).send();
  });

  // POST /ideas/:ideaId/clone — clone an audience-admitted idea into an own
  // private copy. A viewer the audience doesn't admit gets a 404 (no leak).
  router.post('/:ideaId/clone', validateParams(ideaIdParamSchema), async (req, res) => {
    const { ideaId } = req.valid?.params as { ideaId: string };
    const result = await ctx.ideas.clone(req.authUser!.id, ideaId);
    res.status(201).json(result);
  });

  return router;
}

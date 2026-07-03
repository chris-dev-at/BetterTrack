import { Router } from 'express';

import {
  allocateRequestSchema,
  conglomerateIdParamSchema,
  createConglomerateRequestSchema,
  replacePositionsRequestSchema,
  updateConglomerateRequestSchema,
  type AllocateRequest,
  type CreateConglomerateRequest,
  type ReplacePositionsRequest,
  type UpdateConglomerateRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Conglomerate CRUD endpoints (PROJECTPLAN.md §6.5, §7.2, §8). Every
 * `/:conglomerateId/…` handler is ownership-scoped in the repository — a
 * Conglomerate owned by another user is a 404, never a 403 (no IDOR, §8).
 * Controllers stay thin: parse → service → respond. The Invest Calculator's
 * `POST /:id/allocate` (§6.7) is mounted here; the backtest endpoint lives on
 * its own router.
 */
export function createConglomerateRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /conglomerates — the caller's Conglomerates with position counts.
  router.get('/', async (req, res) => {
    const list = await ctx.conglomerate.list(req.authUser!.id);
    res.json(list);
  });

  // POST /conglomerates — create a new draft (empty positions).
  router.post('/', validateBody(createConglomerateRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateConglomerateRequest;
    const detail = await ctx.conglomerate.create(req.authUser!.id, body);
    res.status(201).json(detail);
  });

  // GET /conglomerates/:id — detail with positions + embedded asset identity.
  router.get('/:conglomerateId', validateParams(conglomerateIdParamSchema), async (req, res) => {
    const { conglomerateId } = req.valid?.params as { conglomerateId: string };
    const detail = await ctx.conglomerate.get(req.authUser!.id, conglomerateId);
    res.json(detail);
  });

  // PATCH /conglomerates/:id — rename / edit description (409 on a name clash).
  router.patch(
    '/:conglomerateId',
    validateParams(conglomerateIdParamSchema),
    validateBody(updateConglomerateRequestSchema),
    async (req, res) => {
      const { conglomerateId } = req.valid?.params as { conglomerateId: string };
      const patch = req.valid?.body as UpdateConglomerateRequest;
      const detail = await ctx.conglomerate.update(req.authUser!.id, conglomerateId, patch);
      res.json(detail);
    },
  );

  // DELETE /conglomerates/:id — hard-delete (cascades positions).
  router.delete('/:conglomerateId', validateParams(conglomerateIdParamSchema), async (req, res) => {
    const { conglomerateId } = req.valid?.params as { conglomerateId: string };
    await ctx.conglomerate.remove(req.authUser!.id, conglomerateId);
    res.status(204).send();
  });

  // PUT /conglomerates/:id/positions — bulk-replace positions (Builder autosave).
  router.put(
    '/:conglomerateId/positions',
    validateParams(conglomerateIdParamSchema),
    validateBody(replacePositionsRequestSchema),
    async (req, res) => {
      const { conglomerateId } = req.valid?.params as { conglomerateId: string };
      const { positions } = req.valid?.body as ReplacePositionsRequest;
      const detail = await ctx.conglomerate.replacePositions(
        req.authUser!.id,
        conglomerateId,
        positions,
      );
      res.json(detail);
    },
  );

  // POST /conglomerates/:id/activate — draft → active when Σ weights = 100 ± 0.01.
  router.post(
    '/:conglomerateId/activate',
    validateParams(conglomerateIdParamSchema),
    async (req, res) => {
      const { conglomerateId } = req.valid?.params as { conglomerateId: string };
      const detail = await ctx.conglomerate.activate(req.authUser!.id, conglomerateId);
      res.json(detail);
    },
  );

  // POST /conglomerates/:id/allocate — Invest Calculator: EUR budget → buy list (§6.7).
  router.post(
    '/:conglomerateId/allocate',
    validateParams(conglomerateIdParamSchema),
    validateBody(allocateRequestSchema),
    async (req, res) => {
      const { conglomerateId } = req.valid?.params as { conglomerateId: string };
      const body = req.valid?.body as AllocateRequest;
      const result = await ctx.conglomerate.allocate(req.authUser!.id, conglomerateId, body);
      res.json(result);
    },
  );

  return router;
}

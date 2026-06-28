import { Router } from 'express';

import {
  backtestPreviewRequestSchema,
  conglomerateIdParamSchema,
  createConglomerateRequestSchema,
  replaceConglomeratePositionsRequestSchema,
  updateConglomerateRequestSchema,
  type BacktestPreviewRequest,
  type CreateConglomerateRequest,
  type ReplaceConglomeratePositionsRequest,
  type UpdateConglomerateRequest,
} from '@bettertrack/contracts';

import type { AppContext } from '../context';
import { requireAuth } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import { toConglomerateDetail } from '../serializers';

export function createConglomerateRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth);

  router.post('/', validateBody(createConglomerateRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateConglomerateRequest;
    const detail = await ctx.conglomerates.create(req.authUser!.id, body);
    res.status(201).json(toConglomerateDetail(detail));
  });

  router.get('/:id', validateParams(conglomerateIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const detail = await ctx.conglomerates.load(req.authUser!.id, id);
    res.json(toConglomerateDetail(detail));
  });

  router.patch(
    '/:id',
    validateParams(conglomerateIdParamSchema),
    validateBody(updateConglomerateRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const body = req.valid?.body as UpdateConglomerateRequest;
      const detail = await ctx.conglomerates.updateMeta(req.authUser!.id, id, body);
      res.json(toConglomerateDetail(detail));
    },
  );

  router.put(
    '/:id/positions',
    validateParams(conglomerateIdParamSchema),
    validateBody(replaceConglomeratePositionsRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const { positions } = req.valid?.body as ReplaceConglomeratePositionsRequest;
      const detail = await ctx.conglomerates.replacePositions(req.authUser!.id, id, positions);
      res.json(toConglomerateDetail(detail));
    },
  );

  router.post('/:id/activate', validateParams(conglomerateIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const detail = await ctx.conglomerates.activate(req.authUser!.id, id);
    res.json(toConglomerateDetail(detail));
  });

  return router;
}

export function createBacktestPreviewRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth);

  router.post('/preview', validateBody(backtestPreviewRequestSchema), async (req, res) => {
    const body = req.valid?.body as BacktestPreviewRequest;
    res.json(await ctx.conglomerates.preview(req.authUser!.id, body));
  });

  return router;
}

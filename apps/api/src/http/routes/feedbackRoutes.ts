import { Router } from 'express';

import {
  createFeedbackRequestSchema,
  idParamSchema,
  type CreateFeedbackRequest,
} from '@bettertrack/contracts';

import { notFound } from '../../errors';
import type { AppContext } from '../context';
import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';

/** Authenticated feedback capture plus caller-owned lifecycle read-back. */
export function createFeedbackRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.use(requireUser);

  router.get('/mine', async (req, res) => {
    res.json(await ctx.feedback.listMine(req.authUser!.id));
  });

  router.delete('/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    if (!(await ctx.feedback.deleteMine(req.authUser!.id, id))) {
      throw notFound('Feedback not found.');
    }
    res.status(204).send();
  });

  router.post(
    '/',
    limiters.feedback,
    validateBody(createFeedbackRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as CreateFeedbackRequest;
      const result = await ctx.feedback.submit(req.authUser!.id, body);
      res.status(201).json(result);
    },
  );

  return router;
}

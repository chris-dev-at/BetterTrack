import { Router } from 'express';

import { createFeedbackRequestSchema, type CreateFeedbackRequest } from '@bettertrack/contracts';

import type { AppContext } from '../context';
import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateBody } from '../middleware/validate';

/** Authenticated feedback capture plus caller-owned lifecycle read-back. */
export function createFeedbackRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.use(requireUser);

  router.get('/mine', async (req, res) => {
    res.json(await ctx.feedback.listMine(req.authUser!.id));
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

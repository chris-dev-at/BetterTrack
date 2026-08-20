import { Router } from 'express';

import {
  createFeedbackRequestSchema,
  feedbackThreadQuerySchema,
  idParamSchema,
  sendFeedbackMessageRequestSchema,
  type CreateFeedbackRequest,
  type FeedbackThreadQuery,
  type SendFeedbackMessageRequest,
} from '@bettertrack/contracts';

import { notFound } from '../../errors';
import type { AppContext } from '../context';
import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';

/** Authenticated feedback capture plus caller-owned lifecycle read-back. */
export function createFeedbackRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.use(requireUser);

  router.get('/mine', async (req, res) => {
    res.json(await ctx.feedback.listMine(req.authUser!.id));
  });

  router.get(
    '/:id/messages',
    validateParams(idParamSchema),
    validateQuery(feedbackThreadQuerySchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const result = await ctx.feedback.getThreadForSubmitter(
        req.authUser!.id,
        id,
        req.valid?.query as FeedbackThreadQuery,
      );
      if (!result) throw notFound('Feedback not found.');
      res.json(result);
    },
  );

  router.post(
    '/:id/messages',
    limiters.feedback,
    validateParams(idParamSchema),
    validateBody(sendFeedbackMessageRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const result = await ctx.feedback.sendMessageForSubmitter(
        req.authUser!.id,
        id,
        req.valid?.body as SendFeedbackMessageRequest,
      );
      if (!result) throw notFound('Feedback not found.');
      res.status(201).json(result);
    },
  );

  router.post('/:id/read', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    if (!(await ctx.feedback.markReadForSubmitter(req.authUser!.id, id))) {
      throw notFound('Feedback not found.');
    }
    res.json({ ok: true });
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

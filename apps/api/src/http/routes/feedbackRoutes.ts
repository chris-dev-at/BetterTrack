import { Router } from 'express';

import {
  FEEDBACK_THREAD_CURSOR_UNKNOWN,
  createFeedbackRequestSchema,
  feedbackThreadQuerySchema,
  idParamSchema,
  sendFeedbackMessageRequestSchema,
  type CreateFeedbackRequest,
  type FeedbackThreadQuery,
  type SendFeedbackMessageRequest,
} from '@bettertrack/contracts';

import { badRequest, notFound } from '../../errors';
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
      // Ownership is resolved before the cursor, so a foreign submission still
      // 404s exactly like a missing one — the 400 is only ever about the cursor.
      if (result.status === 'not_found') throw notFound('Feedback not found.');
      if (result.status === 'invalid_cursor') {
        throw badRequest('Unknown thread cursor.', FEEDBACK_THREAD_CURSOR_UNKNOWN);
      }
      res.json(result.thread);
    },
  );

  router.post(
    '/:id/messages',
    // Replies carry their own conversation budget: a submitter who has spent
    // the hourly capture allowance must still be able to answer a question,
    // and a submitter mid-conversation must still be able to file something new.
    limiters.feedbackThread,
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

  // Deliberately on the app-wide `general` budget alone: advancing a read marker
  // is one idempotent `UPDATE ... SET now()` that a client fires on every thread
  // open, so metering it against the conversation budget would spend reply
  // allowance on reads. §10's write budget stays where the cost is — the insert.
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

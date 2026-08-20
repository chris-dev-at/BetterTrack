import { type Router } from 'express';

import {
  FEEDBACK_THREAD_CURSOR_UNKNOWN,
  adminFeedbackListQuerySchema,
  feedbackThreadQuerySchema,
  idParamSchema,
  sendFeedbackMessageRequestSchema,
  updateFeedbackStatusRequestSchema,
  type AdminFeedbackListQuery,
  type FeedbackThreadQuery,
  type SendFeedbackMessageRequest,
  type UpdateFeedbackStatusRequest,
} from '@bettertrack/contracts';

import { badRequest, notFound } from '../../errors';
import type { AppContext } from '../context';
import type { RateLimiters } from '../middleware/rateLimit';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';

/**
 * Owner feedback inbox endpoints. Registered flat after the parent admin + 2FA
 * gates, so ordinary users receive the same no-leak 404 as every admin surface.
 */
export function registerAdminFeedbackRoutes(
  router: Router,
  ctx: AppContext,
  limiters: RateLimiters,
): void {
  router.get('/feedback', validateQuery(adminFeedbackListQuerySchema), async (req, res) => {
    const query = req.valid?.query as AdminFeedbackListQuery;
    res.json(await ctx.feedback.listForAdmin(query));
  });

  router.get(
    '/feedback/:id/messages',
    validateParams(idParamSchema),
    validateQuery(feedbackThreadQuerySchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const result = await ctx.feedback.getThreadForAdmin(
        id,
        req.valid?.query as FeedbackThreadQuery,
      );
      if (result.status === 'not_found') throw notFound('Feedback not found.');
      // A cursor from another thread never constrains this one — say so (as on
      // the submitter rail) instead of silently re-serving page one.
      if (result.status === 'invalid_cursor') {
        throw badRequest('Unknown thread cursor.', FEEDBACK_THREAD_CURSOR_UNKNOWN);
      }
      res.json(result.thread);
    },
  );

  router.post(
    '/feedback/:id/messages',
    // The conversation budget (§10), not the capture guard: answering a queue
    // of submissions in one sitting is the workflow this rail exists for.
    limiters.feedbackThread,
    validateParams(idParamSchema),
    validateBody(sendFeedbackMessageRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const result = await ctx.feedback.sendMessageForAdmin(
        req.authUser!.id,
        id,
        req.valid?.body as SendFeedbackMessageRequest,
      );
      if (!result) throw notFound('Feedback not found.');
      res.status(201).json(result);
    },
  );

  // As on the submitter rail: an idempotent marker UPDATE fired on every thread
  // open stays on the router-level `admin` budget rather than spending reply
  // allowance (see feedbackRoutes.ts).
  router.post('/feedback/:id/read', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    if (!(await ctx.feedback.markReadForAdmin(id))) {
      throw notFound('Feedback not found.');
    }
    res.json({ ok: true });
  });

  router.patch(
    '/feedback/:id',
    validateParams(idParamSchema),
    validateBody(updateFeedbackStatusRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const result = await ctx.feedback.updateStatus(
        req.authUser!.id,
        id,
        req.valid?.body as UpdateFeedbackStatusRequest,
      );
      if (!result) throw notFound('Feedback not found.');
      res.json(result);
    },
  );
}

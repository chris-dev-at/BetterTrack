import { type RequestHandler, type Router } from 'express';

import {
  FEEDBACK_THREAD_CURSOR_UNKNOWN,
  adminFeedbackBulkRequestSchema,
  adminFeedbackCountsQuerySchema,
  adminFeedbackListQuerySchema,
  feedbackThreadQuerySchema,
  idParamSchema,
  sendFeedbackMessageRequestSchema,
  updateFeedbackRequestSchema,
  type AdminFeedbackBulkRequest,
  type AdminFeedbackCountsQuery,
  type AdminFeedbackListQuery,
  type FeedbackThreadQuery,
  type SendFeedbackMessageRequest,
  type UpdateFeedbackRequest,
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

  /**
   * Zero-filled per-status / per-category counts under the list's own filters
   * (owner directive 2026-10-29). Registered BEFORE `/feedback/:id`: that
   * route's UUID param validation would otherwise answer `counts` with a 400.
   */
  router.get(
    '/feedback/counts',
    validateQuery(adminFeedbackCountsQuerySchema),
    async (req, res) => {
      res.json(await ctx.feedback.countsForAdmin(req.valid?.query as AdminFeedbackCountsQuery));
    },
  );

  /**
   * One action over up to 100 submissions (owner directive 2026-10-29). Each
   * row is its own transaction; the response carries one result per input id.
   * Metered once per request on the conversation budget — a bulk status
   * action may write up to 100 replies, so it must not be free where a single
   * reply is not. Registered before every `/feedback/:id*` route.
   */
  router.post(
    '/feedback/bulk',
    limiters.feedbackThread,
    validateBody(adminFeedbackBulkRequestSchema),
    async (req, res) => {
      res.json(
        await ctx.feedback.bulkForAdmin(
          { id: req.authUser!.id, ip: req.ip },
          req.valid?.body as AdminFeedbackBulkRequest,
        ),
      );
    },
  );

  /**
   * One submission by id (#1406 W3). The helpdesk's split pane opens whatever
   * `?thread=` names, which the paged inbox cannot answer: a shared link is
   * routinely opened by an operator whose filters exclude that row. Read-only,
   * and the same projection the list already returns.
   */
  router.get('/feedback/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const submission = await ctx.feedback.getForAdmin(id);
    if (!submission) throw notFound('Feedback not found.');
    res.json(submission);
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
        { ip: req.ip },
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

  /**
   * A status change that carries a `reply` writes a thread message, so it
   * spends the same conversation budget a standalone reply does. A body with
   * no reply (every status/archive PATCH before 2026-10-29) stays on the
   * router-level `admin` budget alone, exactly as before. The raw body is read
   * here because this runs ahead of validation; an invalid body is refused by
   * the validator right after whichever branch this took.
   */
  const meterStatusReply: RequestHandler = (req, res, next) => {
    const body: unknown = req.body;
    const carriesReply =
      typeof body === 'object' && body !== null && 'reply' in body && body.reply !== undefined;
    if (carriesReply) {
      limiters.feedbackThread(req, res, next);
      return;
    }
    next();
  };

  router.patch(
    '/feedback/:id',
    meterStatusReply,
    validateParams(idParamSchema),
    validateBody(updateFeedbackRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const body = req.valid?.body as UpdateFeedbackRequest;
      const result =
        'archived' in body
          ? await ctx.feedback.setArchived(id, body.archived, {
              id: req.authUser!.id,
              ip: req.ip,
            })
          : await ctx.feedback.updateStatus(
              req.authUser!.id,
              id,
              body as UpdateFeedbackStatusRequest,
              { ip: req.ip, source: 'single' },
            );
      if (!result) throw notFound('Feedback not found.');
      res.json(result);
    },
  );
}

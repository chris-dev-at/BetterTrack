import { type Router } from 'express';

import {
  adminFeedbackListQuerySchema,
  idParamSchema,
  updateFeedbackStatusRequestSchema,
  type AdminFeedbackListQuery,
  type UpdateFeedbackStatusRequest,
} from '@bettertrack/contracts';

import { notFound } from '../../errors';
import type { AppContext } from '../context';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';

/**
 * Owner feedback inbox endpoints. Registered flat after the parent admin + 2FA
 * gates, so ordinary users receive the same no-leak 404 as every admin surface.
 */
export function registerAdminFeedbackRoutes(router: Router, ctx: AppContext): void {
  router.get('/feedback', validateQuery(adminFeedbackListQuerySchema), async (req, res) => {
    const query = req.valid?.query as AdminFeedbackListQuery;
    res.json(await ctx.feedback.listForAdmin(query));
  });

  router.patch(
    '/feedback/:id',
    validateParams(idParamSchema),
    validateBody(updateFeedbackStatusRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const result = await ctx.feedback.updateStatus(
        id,
        req.valid?.body as UpdateFeedbackStatusRequest,
      );
      if (!result) throw notFound('Feedback not found.');
      res.json(result);
    },
  );
}

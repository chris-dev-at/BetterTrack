import { type Request, type Router } from 'express';

import {
  idParamSchema,
  problemListQuerySchema,
  type ProblemListQuery,
} from '@bettertrack/contracts';

import { notFound } from '../../errors';
import type { ProblemAdminActor } from '../../services/observability/problemService';
import type { AppContext } from '../context';
import { validateParams, validateQuery } from '../middleware/validate';
import { toProblem } from '../serializers';

const actorOf = (req: Request): ProblemAdminActor => ({ id: req.authUser!.id, ip: req.ip });

/**
 * Admin "Problems" endpoints under `/admin/problems` (§13.5 V5-P2 arc (d), the
 * Sentry replacement). Registered FLAT onto the admin router (not a nested
 * sub-router — the OpenAPI coverage checker only reconstructs top-level mounts),
 * AFTER the {@link requireAdminTwoFactor} gate: this is an ordinary diagnostics
 * surface, not a bootstrap route. `requireAdmin` on the parent router fences it
 * to admins (404 to everyone else). Reads `ctx.problems` per-request so the route
 * factory stays side-effect free at mount time.
 *
 * Captured problems are read-only + a status flow: list/filter, get one, and
 * resolve/reopen (audit-logged in the service).
 */
export function registerAdminProblemsRoutes(router: Router, ctx: AppContext): void {
  router.get('/problems', validateQuery(problemListQuerySchema), async (req, res) => {
    const query = req.valid?.query as ProblemListQuery;
    const { problems, openCount, total, hasMore, droppedCaptures, droppedCapturesTotal } =
      await ctx.problems.list({
        kind: query.kind,
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      });
    // The capture budget's refusals ride along with the list: a page showing 60
    // rows of a 200-fingerprint incident must SAY so, and the admin surface is
    // the only management surface (§16 2026-07-17) — the container log is not a
    // channel the operator is expected to read.
    res.json({
      problems: problems.map(toProblem),
      openCount,
      total,
      hasMore,
      droppedCaptures,
      droppedCapturesTotal,
    });
  });

  router.get('/problems/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const row = await ctx.problems.get(id);
    if (!row) throw notFound('Problem not found.');
    res.json(toProblem(row));
  });

  router.post('/problems/:id/resolve', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const row = await ctx.problems.resolve(id, actorOf(req));
    if (!row) throw notFound('Problem not found.');
    res.json(toProblem(row));
  });

  router.post('/problems/:id/reopen', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    const row = await ctx.problems.reopen(id, actorOf(req));
    if (!row) throw notFound('Problem not found.');
    res.json(toProblem(row));
  });
}

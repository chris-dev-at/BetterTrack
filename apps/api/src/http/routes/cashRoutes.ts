import { Router } from 'express';

import {
  cashBudgetIdParamSchema,
  cashBudgetListQuerySchema,
  cashMovementIdParamSchema,
  cashRuleIdParamSchema,
  cashSummaryQuerySchema,
  cashTagIdParamSchema,
  cashTrendQuerySchema,
  createCashBudgetRequestSchema,
  createCashRuleRequestSchema,
  createCashTagRequestSchema,
  setCashMovementTagsRequestSchema,
  updateCashBudgetRequestSchema,
  updateCashRuleRequestSchema,
  updateCashTagRequestSchema,
  type CashBudgetListQuery,
  type CashSummaryQuery,
  type CashTrendQuery,
  type CreateCashBudgetRequest,
  type CreateCashRuleRequest,
  type CreateCashTagRequest,
  type SetCashMovementTagsRequest,
  type UpdateCashBudgetRequest,
  type UpdateCashRuleRequest,
  type UpdateCashTagRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * CASH FLOW — the classification layer on the portfolio cash ledger (V5 cash
 * fusion, phase 2). Tags, movement tagging, budgets and auto-tagging rules. It
 * replaces `/api/v1/expenses`, which is now read-only (see `expensesRoutes.ts`).
 *
 * Controllers stay thin: parse → service → respond, with thrown `ApiError`s
 * reaching the terminal handler. **Ownership scoping lives in the repositories**
 * (§10) — no handler in this file compares a user id to anything. A row belonging
 * to another account resolves to nothing and the service raises a 404 with the
 * message an id that never existed produces, so existence never leaks (§8).
 *
 * The tagged ledger itself is NOT here: movements are read through
 * `GET /portfolios/:portfolioId/cash`, whose DTO now carries each movement's
 * `tags`. Only the classification is a separate resource, because tags, rules and
 * budgets outlive any one movement.
 *
 * Session-only, like the expense area it replaces: `requireUser` and no bearer
 * scope, so an API key or OAuth token cannot reach it. A personal-API surface for
 * cash flow can be added deliberately later.
 */
export function createCashRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // ── Tags ───────────────────────────────────────────────────────────────────

  // GET /cash/tags — every tag the caller has, app-owned ones included.
  router.get('/tags', async (req, res) => {
    res.json(await ctx.cashTags.listTags(req.authUser!.id));
  });

  // POST /cash/tags — a new user tag; 409 when the name is taken (case-insensitively).
  router.post('/tags', validateBody(createCashTagRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateCashTagRequest;
    res.status(201).json(await ctx.cashTags.createTag(req.authUser!.id, body));
  });

  // PATCH /cash/tags/:tagId — rename / re-tint. A system tag may be renamed (the
  // engine addresses it by `systemKey`); `system` itself is not settable.
  router.patch(
    '/tags/:tagId',
    validateParams(cashTagIdParamSchema),
    validateBody(updateCashTagRequestSchema),
    async (req, res) => {
      const { tagId } = req.valid?.params as { tagId: string };
      const body = req.valid?.body as UpdateCashTagRequest;
      res.json(await ctx.cashTags.updateTag(req.authUser!.id, tagId, body));
    },
  );

  // DELETE /cash/tags/:tagId — 409 for an app-owned tag, which is never deletable.
  router.delete('/tags/:tagId', validateParams(cashTagIdParamSchema), async (req, res) => {
    const { tagId } = req.valid?.params as { tagId: string };
    await ctx.cashTags.deleteTag(req.authUser!.id, tagId);
    res.status(204).end();
  });

  // ── Movement tags ──────────────────────────────────────────────────────────

  // PUT /cash/movements/:movementId/tags — replace the movement's tag set.
  //
  // THE BOUNDARY PHASE 1 COULD NOT EXPRESS AS A FOREIGN KEY: a link row is only
  // legal when the tag's owner and the movement's `portfolio.user_id` are the same
  // account. The repository scopes BOTH sides to the caller in one pass and writes
  // nothing unless both resolve, so a foreign id is a not-found and never a
  // partial write.
  router.put(
    '/movements/:movementId/tags',
    validateParams(cashMovementIdParamSchema),
    validateBody(setCashMovementTagsRequestSchema),
    async (req, res) => {
      const { movementId } = req.valid?.params as { movementId: string };
      const body = req.valid?.body as SetCashMovementTagsRequest;
      res.json(await ctx.cashTags.setMovementTags(req.authUser!.id, movementId, body));
    },
  );

  // ── Budgets ────────────────────────────────────────────────────────────────

  // GET /cash/budgets?portfolioId=&month= — the portfolio's budgets with progress.
  router.get('/budgets', validateQuery(cashBudgetListQuerySchema), async (req, res) => {
    const query = req.valid?.query as CashBudgetListQuery;
    res.json(await ctx.cashBudgets.listBudgets(req.authUser!.id, query.portfolioId, query.month));
  });

  // POST /cash/budgets — one per (portfolio, tag, period); a second is a 409.
  router.post('/budgets', validateBody(createCashBudgetRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateCashBudgetRequest;
    res.status(201).json(await ctx.cashBudgets.createBudget(req.authUser!.id, body));
  });

  // PATCH /cash/budgets/:budgetId — retarget the amount. Portfolio, tag and period
  // are fixed at creation, so a budget cannot drift onto another ledger or month.
  router.patch(
    '/budgets/:budgetId',
    validateParams(cashBudgetIdParamSchema),
    validateBody(updateCashBudgetRequestSchema),
    async (req, res) => {
      const { budgetId } = req.valid?.params as { budgetId: string };
      const body = req.valid?.body as UpdateCashBudgetRequest;
      res.json(await ctx.cashBudgets.updateBudget(req.authUser!.id, budgetId, body));
    },
  );

  router.delete('/budgets/:budgetId', validateParams(cashBudgetIdParamSchema), async (req, res) => {
    const { budgetId } = req.valid?.params as { budgetId: string };
    await ctx.cashBudgets.deleteBudget(req.authUser!.id, budgetId);
    res.status(204).end();
  });

  // ── Rules ──────────────────────────────────────────────────────────────────

  // GET /cash/rules — in EVALUATION order (ascending priority, then age).
  router.get('/rules', async (req, res) => {
    res.json(await ctx.cashTags.listRules(req.authUser!.id));
  });

  // POST /cash/rules — a rule assigns MANY tags at once; first match wins.
  router.post('/rules', validateBody(createCashRuleRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateCashRuleRequest;
    res.status(201).json(await ctx.cashTags.createRule(req.authUser!.id, body));
  });

  router.patch(
    '/rules/:ruleId',
    validateParams(cashRuleIdParamSchema),
    validateBody(updateCashRuleRequestSchema),
    async (req, res) => {
      const { ruleId } = req.valid?.params as { ruleId: string };
      const body = req.valid?.body as UpdateCashRuleRequest;
      res.json(await ctx.cashTags.updateRule(req.authUser!.id, ruleId, body));
    },
  );

  router.delete('/rules/:ruleId', validateParams(cashRuleIdParamSchema), async (req, res) => {
    const { ruleId } = req.valid?.params as { ruleId: string };
    await ctx.cashTags.deleteRule(req.authUser!.id, ruleId);
    res.status(204).end();
  });

  // ── Summary + trends ───────────────────────────────────────────────────────

  // GET /cash/summary?portfolioId=&month= — the month's totals and per-tag split.
  router.get('/summary', validateQuery(cashSummaryQuerySchema), async (req, res) => {
    const query = req.valid?.query as CashSummaryQuery;
    res.json(await ctx.cashBudgets.summary(req.authUser!.id, query.portfolioId, query.month));
  });

  // GET /cash/trends?portfolioId=&months= — one point per month, gaps as zeros.
  router.get('/trends', validateQuery(cashTrendQuerySchema), async (req, res) => {
    const query = req.valid?.query as CashTrendQuery;
    res.json(await ctx.cashBudgets.trends(req.authUser!.id, query.portfolioId, query.months));
  });

  return router;
}

import { Router } from 'express';

import {
  createExpenseCategoryRequestSchema,
  createExpenseRuleRequestSchema,
  createExpenseTransactionRequestSchema,
  expenseCategoryIdParamSchema,
  expenseRuleIdParamSchema,
  expenseTransactionIdParamSchema,
  expenseTransactionListQuerySchema,
  recategorizeExpenseTransactionRequestSchema,
  updateExpenseCategoryRequestSchema,
  updateExpenseRuleRequestSchema,
  updateExpenseTransactionRequestSchema,
  type CreateExpenseCategoryRequest,
  type CreateExpenseRuleRequest,
  type CreateExpenseTransactionRequest,
  type ExpenseTransactionListQuery,
  type RecategorizeExpenseTransactionRequest,
  type UpdateExpenseCategoryRequest,
  type UpdateExpenseRuleRequest,
  type UpdateExpenseTransactionRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Expense tracking — a NEW top-level product area (PROJECTPLAN.md §13.5 V5-P9,
 * foundation issue 1/3). Controllers stay thin: parse → service → respond. Every
 * `/:id` handler is owner-scoped in the service (a row owned by another user is a
 * 404, never a 403 — no IDOR, §8). Strictly separate from portfolio money: this
 * router speaks only the expense service, never a portfolio/tax/domain surface.
 *
 * Session-only for now (cookie auth via `requireUser`); no bearer scope is
 * mapped, so an API key/OAuth token can't reach the area — a personal-API/webhook
 * surface for expenses can be added deliberately later.
 */
export function createExpensesRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // ── Categories ──

  // GET /expenses/categories — the caller's categories (defaults seeded on first read).
  router.get('/categories', async (req, res) => {
    const result = await ctx.expenses.listCategories(req.authUser!.id);
    res.json(result);
  });

  // POST /expenses/categories — create a category.
  router.post('/categories', validateBody(createExpenseCategoryRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateExpenseCategoryRequest;
    const result = await ctx.expenses.createCategory(req.authUser!.id, body);
    res.status(201).json(result);
  });

  // PATCH /expenses/categories/:categoryId — rename / re-tint / flip direction.
  router.patch(
    '/categories/:categoryId',
    validateParams(expenseCategoryIdParamSchema),
    validateBody(updateExpenseCategoryRequestSchema),
    async (req, res) => {
      const { categoryId } = req.valid?.params as { categoryId: string };
      const patch = req.valid?.body as UpdateExpenseCategoryRequest;
      const result = await ctx.expenses.updateCategory(req.authUser!.id, categoryId, patch);
      res.json(result);
    },
  );

  // DELETE /expenses/categories/:categoryId — delete (transactions become uncategorized).
  router.delete(
    '/categories/:categoryId',
    validateParams(expenseCategoryIdParamSchema),
    async (req, res) => {
      const { categoryId } = req.valid?.params as { categoryId: string };
      await ctx.expenses.deleteCategory(req.authUser!.id, categoryId);
      res.status(204).send();
    },
  );

  // ── Transactions ──

  // GET /expenses/transactions — the caller's transactions, newest first (optional filters).
  router.get(
    '/transactions',
    validateQuery(expenseTransactionListQuerySchema),
    async (req, res) => {
      const query = req.valid?.query as ExpenseTransactionListQuery;
      const result = await ctx.expenses.listTransactions(req.authUser!.id, query);
      res.json(result);
    },
  );

  // POST /expenses/transactions — record a spend / income row.
  router.post(
    '/transactions',
    validateBody(createExpenseTransactionRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as CreateExpenseTransactionRequest;
      const result = await ctx.expenses.createTransaction(req.authUser!.id, body);
      res.status(201).json(result);
    },
  );

  // GET /expenses/transactions/:transactionId — one of the caller's own transactions.
  router.get(
    '/transactions/:transactionId',
    validateParams(expenseTransactionIdParamSchema),
    async (req, res) => {
      const { transactionId } = req.valid?.params as { transactionId: string };
      const result = await ctx.expenses.getTransaction(req.authUser!.id, transactionId);
      res.json(result);
    },
  );

  // PATCH /expenses/transactions/:transactionId — edit amount / date / description / …
  router.patch(
    '/transactions/:transactionId',
    validateParams(expenseTransactionIdParamSchema),
    validateBody(updateExpenseTransactionRequestSchema),
    async (req, res) => {
      const { transactionId } = req.valid?.params as { transactionId: string };
      const patch = req.valid?.body as UpdateExpenseTransactionRequest;
      const result = await ctx.expenses.updateTransaction(req.authUser!.id, transactionId, patch);
      res.json(result);
    },
  );

  // PUT /expenses/transactions/:transactionId/category — dedicated recategorize (null clears).
  router.put(
    '/transactions/:transactionId/category',
    validateParams(expenseTransactionIdParamSchema),
    validateBody(recategorizeExpenseTransactionRequestSchema),
    async (req, res) => {
      const { transactionId } = req.valid?.params as { transactionId: string };
      const { categoryId } = req.valid?.body as RecategorizeExpenseTransactionRequest;
      const result = await ctx.expenses.recategorizeTransaction(
        req.authUser!.id,
        transactionId,
        categoryId,
      );
      res.json(result);
    },
  );

  // DELETE /expenses/transactions/:transactionId — delete a transaction.
  router.delete(
    '/transactions/:transactionId',
    validateParams(expenseTransactionIdParamSchema),
    async (req, res) => {
      const { transactionId } = req.valid?.params as { transactionId: string };
      await ctx.expenses.deleteTransaction(req.authUser!.id, transactionId);
      res.status(204).send();
    },
  );

  // ── Rules (shapes only; evaluation is issue 2/3) ──

  // GET /expenses/rules — the caller's auto-categorization rules, by evaluation order.
  router.get('/rules', async (req, res) => {
    const result = await ctx.expenses.listRules(req.authUser!.id);
    res.json(result);
  });

  // POST /expenses/rules — create a rule (targets a category the caller owns).
  router.post('/rules', validateBody(createExpenseRuleRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateExpenseRuleRequest;
    const result = await ctx.expenses.createRule(req.authUser!.id, body);
    res.status(201).json(result);
  });

  // PATCH /expenses/rules/:ruleId — edit a rule.
  router.patch(
    '/rules/:ruleId',
    validateParams(expenseRuleIdParamSchema),
    validateBody(updateExpenseRuleRequestSchema),
    async (req, res) => {
      const { ruleId } = req.valid?.params as { ruleId: string };
      const patch = req.valid?.body as UpdateExpenseRuleRequest;
      const result = await ctx.expenses.updateRule(req.authUser!.id, ruleId, patch);
      res.json(result);
    },
  );

  // DELETE /expenses/rules/:ruleId — delete a rule.
  router.delete('/rules/:ruleId', validateParams(expenseRuleIdParamSchema), async (req, res) => {
    const { ruleId } = req.valid?.params as { ruleId: string };
    await ctx.expenses.deleteRule(req.authUser!.id, ruleId);
    res.status(204).send();
  });

  return router;
}

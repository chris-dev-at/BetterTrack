import { Router, type RequestHandler } from 'express';
import multer, { MulterError } from 'multer';

import {
  createExpenseBudgetRequestSchema,
  createExpenseCategoryRequestSchema,
  createExpenseRuleRequestSchema,
  createExpenseTransactionRequestSchema,
  expenseBudgetIdParamSchema,
  expenseBudgetListQuerySchema,
  expenseCategoryIdParamSchema,
  expenseImportApplyFieldsSchema,
  expenseImportOverrideSchema,
  expenseImportPreviewFieldsSchema,
  expenseRuleIdParamSchema,
  expenseSummaryQuerySchema,
  expenseTransactionIdParamSchema,
  expenseTransactionListQuerySchema,
  expenseTrendQuerySchema,
  recategorizeExpenseTransactionRequestSchema,
  updateExpenseBudgetRequestSchema,
  updateExpenseCategoryRequestSchema,
  updateExpenseRuleRequestSchema,
  updateExpenseTransactionRequestSchema,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  type CreateExpenseBudgetRequest,
  type CreateExpenseCategoryRequest,
  type CreateExpenseRuleRequest,
  type CreateExpenseTransactionRequest,
  type ExpenseBudgetListQuery,
  type ExpenseImportApplyFields,
  type ExpenseImportOverride,
  type ExpenseImportPreviewFields,
  type ExpenseSummaryQuery,
  type ExpenseTransactionListQuery,
  type ExpenseTrendQuery,
  type RecategorizeExpenseTransactionRequest,
  type UpdateExpenseBudgetRequest,
  type UpdateExpenseCategoryRequest,
  type UpdateExpenseRuleRequest,
  type UpdateExpenseTransactionRequest,
} from '@bettertrack/contracts';
import { z } from 'zod';

import { ApiError, badRequest } from '../../errors';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/** Preview-time overrides travel as a JSON-encoded multipart field; bounded like the file. */
const importOverridesSchema = z.array(expenseImportOverrideSchema).max(IMPORT_MAX_ROWS);

/** Parse + validate the optional `overrides` multipart field (400 on malformed JSON). */
function parseImportOverrides(raw: string | undefined): ExpenseImportOverride[] {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('Invalid overrides payload.', 'EXPENSE_IMPORT_OVERRIDES_INVALID');
  }
  const result = importOverridesSchema.safeParse(parsed);
  if (!result.success)
    throw badRequest('Invalid overrides payload.', 'EXPENSE_IMPORT_OVERRIDES_INVALID');
  return result.data;
}

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

  /**
   * WRITE RETIREMENT (V5 cash fusion, phase 2). Every expense row now lives on
   * the portfolio cash ledger, classified by `cash_tags` and served by
   * `/api/v1/cash`. Migration 0076 left these tables writable so the old UI kept
   * working, and the price was divergence: anything written here afterwards had
   * to be swept up by `scripts/catchUpCashFusion.ts`. This gate ends that — after
   * the catch-up runs, nothing can add to the gap again.
   *
   * READS STILL WORK, deliberately, for one release: the `expense_*` tables are
   * the rollback and diagnosis path while the fused surfaces bed in, and the
   * paranoid vault still restores into them. The tables are dropped in a later
   * migration once both of those are re-pointed (see the phase-2 report).
   *
   * 410 rather than 404 or 405: the resource genuinely existed and is genuinely
   * gone, and a client that sees it should stop retrying rather than treat it as
   * a transient miss or a wrong verb.
   */
  // Named, not anonymous: the paranoid route table identifies opaque `use`
  // mounts by their handler name, so an anonymous gate would appear there as an
  // unclassifiable surface.
  router.use(function refuseRetiredExpenseWrite(req, _res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    next(
      new ApiError(
        410,
        'EXPENSE_AREA_RETIRED',
        'Expense tracking has moved onto the portfolio cash ledger. Use /api/v1/cash.',
      ),
    );
  });

  // In-memory multipart parsing for the one CSV part of a bank-statement import —
  // files are capped well below anything worth streaming to disk (§13.5 V5-P9).
  // Multipart budget: two text fields (bankId + optional overrides), one file,
  // a parts-limit sentinel of four (Busboy emits at equality, so this admits
  // exactly the three allowed parts), a field-size sentinel of 1,000,001
  // (Busboy truncates at equality, so this admits the machine-generated ASCII
  // overrides contract's 1,000,000-character maximum), and 32 header pairs per
  // part (normally just 1–2).
  //
  // `headerPairs` is declarative: Busboy 1.6 ignores it and hard-codes
  // MAX_HEADER_PAIRS = 2000 (lib/types/multipart.js:21). The bound that actually
  // holds is its MAX_HEADER_SIZE = 16 KiB per part header block (:22), enforced
  // by a hard `Malformed part header` error (:395-398) and reset per part, so
  // header memory stays under 16 KiB x `parts`. That error is a plain Error, not
  // a MulterError — hence the catch-all mapping in `uploadFile`.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: IMPORT_MAX_FILE_BYTES,
      files: 1,
      fields: 2,
      parts: 4,
      fieldSize: 1_000_001,
      headerPairs: 32,
    },
  });

  /**
   * `upload.single('file')` with every multipart failure mapped onto the §8
   * envelope. Multer wraps only its own limit breaches as `MulterError`; Busboy's
   * framing errors (an over-16 KiB part header block, `Unexpected end of form`,
   * an unparseable content-type) surface as plain `Error`s and would otherwise
   * reach the terminal handler as an opaque 500 — reporting hostile input as a
   * server fault. Every one of them is a malformed upload, so every one of them
   * is the same 400; only the file-size breach earns more specific guidance.
   */
  const uploadFile: RequestHandler = (req, res, next) => {
    upload.single('file')(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      const message =
        err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? `The file exceeds the ${Math.round(IMPORT_MAX_FILE_BYTES / (1024 * 1024))} MB upload limit.`
          : 'Invalid file upload.';
      next(badRequest(message, 'EXPENSE_IMPORT_FILE_INVALID'));
    });
  };

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

  // ── Bank-statement CSV import (issue 2/3) ──
  // Stateless: preview persists nothing; apply re-parses the re-uploaded file.

  // GET /expenses/import/banks — the supported bank mappers, for the manual picker.
  router.get('/import/banks', (_req, res) => {
    res.json(ctx.expenseImports.listBanks());
  });

  // POST /expenses/import/preview — upload a CSV (multipart: `file` [+ bankId]);
  // parse/normalize/auto-categorize/flag-duplicates and return the staged preview.
  router.post(
    '/import/preview',
    uploadFile,
    validateBody(expenseImportPreviewFieldsSchema),
    async (req, res) => {
      const fields = req.valid?.body as ExpenseImportPreviewFields;
      if (!req.file) throw badRequest('A CSV file is required.', 'EXPENSE_IMPORT_FILE_REQUIRED');
      const result = await ctx.expenseImports.preview(req.authUser!.id, {
        content: req.file.buffer.toString('utf8'),
        filename: req.file.originalname || 'import.csv',
        bankId: fields.bankId,
      });
      res.json(result);
    },
  );

  // POST /expenses/import/apply — the explicit confirm: re-upload the same CSV
  // (+ optional per-row category overrides) and book the non-duplicate rows.
  router.post(
    '/import/apply',
    uploadFile,
    validateBody(expenseImportApplyFieldsSchema),
    async (req, res) => {
      const fields = req.valid?.body as ExpenseImportApplyFields;
      if (!req.file) throw badRequest('A CSV file is required.', 'EXPENSE_IMPORT_FILE_REQUIRED');
      const result = await ctx.expenseImports.apply(req.authUser!.id, {
        content: req.file.buffer.toString('utf8'),
        filename: req.file.originalname || 'import.csv',
        bankId: fields.bankId,
        overrides: parseImportOverrides(fields.overrides),
      });
      res.json(result);
    },
  );

  // ── Dashboards + budgets (issue 3/3) ──

  // GET /expenses/summary?month= — spend by category + income-vs-spend for a month.
  router.get('/summary', validateQuery(expenseSummaryQuerySchema), async (req, res) => {
    const { month } = req.valid?.query as ExpenseSummaryQuery;
    const result = await ctx.expenseBudgets.monthlySummary(req.authUser!.id, month);
    res.json(result);
  });

  // GET /expenses/trends?months= — income-vs-spend over the trailing months.
  router.get('/trends', validateQuery(expenseTrendQuerySchema), async (req, res) => {
    const { months } = req.valid?.query as ExpenseTrendQuery;
    const result = await ctx.expenseBudgets.trends(req.authUser!.id, months);
    res.json(result);
  });

  // GET /expenses/budgets?month= — the caller's budgets with this period's progress.
  router.get('/budgets', validateQuery(expenseBudgetListQuerySchema), async (req, res) => {
    const { month } = req.valid?.query as ExpenseBudgetListQuery;
    const result = await ctx.expenseBudgets.listBudgets(req.authUser!.id, month);
    res.json(result);
  });

  // POST /expenses/budgets — set a per-category monthly target (one per category).
  router.post('/budgets', validateBody(createExpenseBudgetRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateExpenseBudgetRequest;
    const result = await ctx.expenseBudgets.createBudget(req.authUser!.id, body);
    res.status(201).json(result);
  });

  // PATCH /expenses/budgets/:budgetId — retarget the amount / currency.
  router.patch(
    '/budgets/:budgetId',
    validateParams(expenseBudgetIdParamSchema),
    validateBody(updateExpenseBudgetRequestSchema),
    async (req, res) => {
      const { budgetId } = req.valid?.params as { budgetId: string };
      const patch = req.valid?.body as UpdateExpenseBudgetRequest;
      const result = await ctx.expenseBudgets.updateBudget(req.authUser!.id, budgetId, patch);
      res.json(result);
    },
  );

  // DELETE /expenses/budgets/:budgetId — remove a budget.
  router.delete(
    '/budgets/:budgetId',
    validateParams(expenseBudgetIdParamSchema),
    async (req, res) => {
      const { budgetId } = req.valid?.params as { budgetId: string };
      await ctx.expenseBudgets.deleteBudget(req.authUser!.id, budgetId);
      res.status(204).send();
    },
  );

  return router;
}

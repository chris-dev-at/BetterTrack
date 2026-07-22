import { z } from 'zod';

/**
 * Expense tracking (PROJECTPLAN.md §13.5 V5-P9) — a NEW top-level product area,
 * strictly separate from portfolio money: it never touches TWR, tax or holdings
 * (spec: "zero TWR/tax interaction"). This module is the FOUNDATION (issue 1/3):
 * the shapes for categorized spending — categories (with sensible defaults),
 * transactions (income vs spend, per-transaction recategorize) and the
 * auto-categorization RULE shapes (their evaluation engine lands in issue 2/3).
 *
 * Budgets + the per-period fired-marker have their tables provisioned now (one
 * migration owns the whole P9 schema) but no contract yet — the budget surface +
 * matrix-routed alerts are issue 3/3.
 */

// --- Shared vocabulary -------------------------------------------------------

/**
 * Whether a transaction (or a category) is money going OUT (`expense`) or coming
 * IN (`income`). Drives the "income vs spend" split every dashboard reads (3/3).
 * A transaction carries its own direction independent of its category, so an
 * uncategorized row is still unambiguously a spend or an income.
 */
export const EXPENSE_DIRECTIONS = ['expense', 'income'] as const;
export const expenseDirectionSchema = z.enum(EXPENSE_DIRECTIONS);
export type ExpenseDirection = z.infer<typeof expenseDirectionSchema>;

/**
 * How an auto-categorization rule matches a transaction's description (issue
 * 2/3 evaluates these; the foundation only stores the shape). `contains` /
 * `equals` / `starts_with` are literal, case-insensitive substring tests;
 * `regex` matches the pattern as a regular expression.
 */
export const EXPENSE_RULE_MATCH_TYPES = ['contains', 'equals', 'starts_with', 'regex'] as const;
export const expenseRuleMatchTypeSchema = z.enum(EXPENSE_RULE_MATCH_TYPES);
export type ExpenseRuleMatchType = z.infer<typeof expenseRuleMatchTypeSchema>;

/**
 * Upper bound on a single expense amount's magnitude. The column is
 * `numeric(20,2)`; an unbounded (or non-finite `Infinity`, which `z.number()`
 * otherwise admits) amount would reach Postgres as an overflow and surface as a
 * 500 instead of a clean 400. A trillion cap keeps every realistic entry while
 * failing loud and early — mirrors {@link MAX_CASH_AMOUNT_EUR}.
 */
export const EXPENSE_AMOUNT_MAX = 1_000_000_000_000;

/** Field caps (kept compact per the anti-bloat rule). */
export const EXPENSE_CATEGORY_NAME_MAX = 60;
export const EXPENSE_DESCRIPTION_MAX = 500;
export const EXPENSE_RULE_PATTERN_MAX = 200;
/** Default / max page size for the transaction list. */
export const EXPENSE_TRANSACTION_LIST_DEFAULT = 100;
export const EXPENSE_TRANSACTION_LIST_MAX = 500;

/** ISO `YYYY-MM-DD` calendar day. */
const isoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO YYYY-MM-DD date.');
/** A positive, finite amount within the ledger's representable range. */
const expenseAmountSchema = z.number().positive().finite().max(EXPENSE_AMOUNT_MAX);
/** ISO-4217-shaped 3-letter uppercase currency code. */
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Expected a 3-letter currency code.');
/** `#RRGGBB` hex colour used to tint a category on the dashboards. */
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #RRGGBB hex colour.');

// --- Categories --------------------------------------------------------------

/** One spending/income category as returned to its owner. */
export const expenseCategorySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    direction: expenseDirectionSchema,
    /** `#RRGGBB` tint for the dashboards. */
    color: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;

/** `GET /expenses/categories` — the caller's categories (defaults seeded on first read). */
export const expenseCategoryListResponseSchema = z
  .object({ categories: z.array(expenseCategorySchema) })
  .strict();
export type ExpenseCategoryListResponse = z.infer<typeof expenseCategoryListResponseSchema>;

/** `POST /expenses/categories` body. Colour is optional — the server assigns one when omitted. */
export const createExpenseCategoryRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(EXPENSE_CATEGORY_NAME_MAX),
    direction: expenseDirectionSchema.default('expense'),
    color: hexColorSchema.optional(),
  })
  .strict();
export type CreateExpenseCategoryRequest = z.infer<typeof createExpenseCategoryRequestSchema>;

/** `PATCH /expenses/categories/:categoryId` body — rename / re-tint / flip direction. */
export const updateExpenseCategoryRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(EXPENSE_CATEGORY_NAME_MAX).optional(),
    direction: expenseDirectionSchema.optional(),
    color: hexColorSchema.optional(),
  })
  .strict();
export type UpdateExpenseCategoryRequest = z.infer<typeof updateExpenseCategoryRequestSchema>;

/** `POST` / `PATCH` category response. */
export const expenseCategoryResponseSchema = z.object({ category: expenseCategorySchema }).strict();
export type ExpenseCategoryResponse = z.infer<typeof expenseCategoryResponseSchema>;

/** Route param for the single-category endpoints. */
export const expenseCategoryIdParamSchema = z.object({ categoryId: z.string().uuid() }).strict();
export type ExpenseCategoryIdParam = z.infer<typeof expenseCategoryIdParamSchema>;

// --- Transactions ------------------------------------------------------------

/** One expense/income transaction as returned to its owner. */
export const expenseTransactionSchema = z
  .object({
    id: z.string().uuid(),
    /** The category this row is filed under, or `null` when uncategorized. */
    categoryId: z.string().uuid().nullable(),
    direction: expenseDirectionSchema,
    /** Positive magnitude; `direction` gives the sign. */
    amount: z.number(),
    currency: z.string(),
    /** ISO `YYYY-MM-DD` booking day. */
    bookedOn: z.string(),
    /** Merchant / memo — the text auto-categorization rules match against (2/3). */
    description: z.string(),
    /** Provenance tag: `manual` or `import:<broker>` (2/3). */
    source: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ExpenseTransaction = z.infer<typeof expenseTransactionSchema>;

/** `GET /expenses/transactions` query — optional filters + a bounded page size. */
export const expenseTransactionListQuerySchema = z
  .object({
    categoryId: z.string().uuid().optional(),
    direction: expenseDirectionSchema.optional(),
    from: isoDaySchema.optional(),
    to: isoDaySchema.optional(),
    limit: z.coerce.number().int().positive().max(EXPENSE_TRANSACTION_LIST_MAX).optional(),
  })
  .strict();
export type ExpenseTransactionListQuery = z.infer<typeof expenseTransactionListQuerySchema>;

/** `GET /expenses/transactions` response — newest first. */
export const expenseTransactionListResponseSchema = z
  .object({ transactions: z.array(expenseTransactionSchema) })
  .strict();
export type ExpenseTransactionListResponse = z.infer<typeof expenseTransactionListResponseSchema>;

/** `POST /expenses/transactions` body. */
export const createExpenseTransactionRequestSchema = z
  .object({
    /** Optional at creation; `null`/omitted files the row as uncategorized. */
    categoryId: z.string().uuid().nullish(),
    direction: expenseDirectionSchema.default('expense'),
    amount: expenseAmountSchema,
    currency: currencySchema.default('EUR'),
    bookedOn: isoDaySchema,
    description: z.string().trim().min(1).max(EXPENSE_DESCRIPTION_MAX),
  })
  .strict();
export type CreateExpenseTransactionRequest = z.infer<typeof createExpenseTransactionRequestSchema>;

/** `PATCH /expenses/transactions/:transactionId` body — every field optional. */
export const updateExpenseTransactionRequestSchema = z
  .object({
    categoryId: z.string().uuid().nullish(),
    direction: expenseDirectionSchema.optional(),
    amount: expenseAmountSchema.optional(),
    currency: currencySchema.optional(),
    bookedOn: isoDaySchema.optional(),
    description: z.string().trim().min(1).max(EXPENSE_DESCRIPTION_MAX).optional(),
  })
  .strict();
export type UpdateExpenseTransactionRequest = z.infer<typeof updateExpenseTransactionRequestSchema>;

/**
 * `PUT /expenses/transactions/:transactionId/category` body — the dedicated
 * per-transaction recategorize path. `null` clears the category (uncategorize).
 */
export const recategorizeExpenseTransactionRequestSchema = z
  .object({ categoryId: z.string().uuid().nullable() })
  .strict();
export type RecategorizeExpenseTransactionRequest = z.infer<
  typeof recategorizeExpenseTransactionRequestSchema
>;

/** `POST` / `PATCH` / recategorize transaction response. */
export const expenseTransactionResponseSchema = z
  .object({ transaction: expenseTransactionSchema })
  .strict();
export type ExpenseTransactionResponse = z.infer<typeof expenseTransactionResponseSchema>;

/** Route param for the single-transaction endpoints. */
export const expenseTransactionIdParamSchema = z
  .object({ transactionId: z.string().uuid() })
  .strict();
export type ExpenseTransactionIdParam = z.infer<typeof expenseTransactionIdParamSchema>;

// --- Auto-categorization rules (shapes only; evaluation is issue 2/3) --------

/** One auto-categorization rule as returned to its owner. */
export const expenseRuleSchema = z
  .object({
    id: z.string().uuid(),
    /** The category a matching transaction is filed under. */
    categoryId: z.string().uuid(),
    matchType: expenseRuleMatchTypeSchema,
    /** The literal/regex pattern tested against a transaction's description. */
    pattern: z.string(),
    /** Evaluation order — lower runs first; the first match wins (2/3). */
    priority: z.number().int(),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ExpenseRule = z.infer<typeof expenseRuleSchema>;

/** `GET /expenses/rules` response — by ascending priority then age. */
export const expenseRuleListResponseSchema = z
  .object({ rules: z.array(expenseRuleSchema) })
  .strict();
export type ExpenseRuleListResponse = z.infer<typeof expenseRuleListResponseSchema>;

/** `POST /expenses/rules` body. */
export const createExpenseRuleRequestSchema = z
  .object({
    categoryId: z.string().uuid(),
    matchType: expenseRuleMatchTypeSchema.default('contains'),
    pattern: z.string().trim().min(1).max(EXPENSE_RULE_PATTERN_MAX),
    priority: z.number().int().min(0).max(10_000).default(0),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateExpenseRuleRequest = z.infer<typeof createExpenseRuleRequestSchema>;

/** `PATCH /expenses/rules/:ruleId` body — every field optional. */
export const updateExpenseRuleRequestSchema = z
  .object({
    categoryId: z.string().uuid().optional(),
    matchType: expenseRuleMatchTypeSchema.optional(),
    pattern: z.string().trim().min(1).max(EXPENSE_RULE_PATTERN_MAX).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateExpenseRuleRequest = z.infer<typeof updateExpenseRuleRequestSchema>;

/** `POST` / `PATCH` rule response. */
export const expenseRuleResponseSchema = z.object({ rule: expenseRuleSchema }).strict();
export type ExpenseRuleResponse = z.infer<typeof expenseRuleResponseSchema>;

/** Route param for the single-rule endpoints. */
export const expenseRuleIdParamSchema = z.object({ ruleId: z.string().uuid() }).strict();
export type ExpenseRuleIdParam = z.infer<typeof expenseRuleIdParamSchema>;

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

// --- Bank-statement CSV import (issue 2/3) -----------------------------------

/**
 * Bank-statement CSV import (PROJECTPLAN.md §13.5 V5-P9, issue 2/3). A NEW mapper
 * family distinct from the broker imports (§13.4): those map securities trades;
 * these map a bank account's spend/income rows into expense transactions. The
 * flow mirrors the broker one — upload → autodetect (or pick) the bank → a staged
 * preview with per-row flags + a rule-suggested category → an explicit apply — but
 * is **stateless**: no staging table (P9 owns no import DDL), so the preview holds
 * nothing server-side and apply re-parses the same file, re-runs the rules, and
 * relies on the `expense_transactions` UNIQUE(user, dedup_hash) key for idempotency
 * (a re-import of an already-applied file writes nothing).
 */

/** One supported bank-statement mapper (Erste/George, Raiffeisen ELBA, N26, Revolut). */
export const expenseBankSchema = z.object({ id: z.string(), label: z.string() }).strict();
export type ExpenseBank = z.infer<typeof expenseBankSchema>;

/** `GET /expenses/import/banks` — the supported bank mappers, for the picker. */
export const expenseBankListResponseSchema = z
  .object({ banks: z.array(expenseBankSchema) })
  .strict();
export type ExpenseBankListResponse = z.infer<typeof expenseBankListResponseSchema>;

/**
 * Per-row preview flag: `new` = parsed, will import; `duplicate` = its content
 * hash already exists (or an earlier row of the same file) — skipped on apply;
 * `error` = the row itself is malformed (reported, the rest of the file lands).
 * There is no `unmapped` — an expense row references no catalog instrument.
 */
export const EXPENSE_IMPORT_ROW_FLAGS = ['new', 'duplicate', 'error'] as const;
export const expenseImportRowFlagSchema = z.enum(EXPENSE_IMPORT_ROW_FLAGS);
export type ExpenseImportRowFlag = z.infer<typeof expenseImportRowFlagSchema>;

/**
 * Per-row apply outcome. `applied` landed; `skipped_duplicate` mirrors a
 * `duplicate`/raced row; `skipped_error` mirrors an `error` row (per-row error
 * tolerance, never all-or-nothing).
 */
export const EXPENSE_IMPORT_ROW_RESULTS = [
  'applied',
  'skipped_duplicate',
  'skipped_error',
] as const;
export const expenseImportRowResultSchema = z.enum(EXPENSE_IMPORT_ROW_RESULTS);
export type ExpenseImportRowResult = z.infer<typeof expenseImportRowResultSchema>;

/** Per-flag row counts for the preview header. */
export const expenseImportCountsSchema = z
  .object({
    total: z.number().int(),
    new: z.number().int(),
    duplicate: z.number().int(),
    error: z.number().int(),
  })
  .strict();
export type ExpenseImportCounts = z.infer<typeof expenseImportCountsSchema>;

/**
 * One staged (normalized) bank-statement row. Every field is nullable because an
 * `error` row carries only its `raw` line + `message`. `categoryId` is the rule
 * engine's suggestion (null = uncategorized); `categoryName` is a display snapshot.
 */
export const expenseImportPreviewRowSchema = z
  .object({
    /** 1-based physical line number in the uploaded file (header = line 1). */
    rowIndex: z.number().int(),
    raw: z.string(),
    flag: expenseImportRowFlagSchema,
    message: z.string().nullable(),
    /** ISO `YYYY-MM-DD` booking day. */
    bookedOn: z.string().nullable(),
    direction: expenseDirectionSchema.nullable(),
    /** Positive magnitude; `direction` gives the sign. */
    amount: z.number().nullable(),
    currency: z.string().nullable(),
    description: z.string().nullable(),
    categoryId: z.string().uuid().nullable(),
    categoryName: z.string().nullable(),
  })
  .strict();
export type ExpenseImportPreviewRow = z.infer<typeof expenseImportPreviewRowSchema>;

/** `POST /expenses/import/preview` response — the staged preview (nothing persisted). */
export const expenseImportPreviewResponseSchema = z
  .object({
    bankId: z.string(),
    bankLabel: z.string(),
    filename: z.string(),
    counts: expenseImportCountsSchema,
    rows: z.array(expenseImportPreviewRowSchema),
  })
  .strict();
export type ExpenseImportPreviewResponse = z.infer<typeof expenseImportPreviewResponseSchema>;

/**
 * The non-file multipart field of `POST /expenses/import/preview` (the CSV itself
 * travels as the `file` part). `bankId` overrides autodetection; omitted → the
 * server detects the bank (400 when it cannot).
 */
export const expenseImportPreviewFieldsSchema = z
  .object({ bankId: z.string().min(1).max(64).optional() })
  .strict();
export type ExpenseImportPreviewFields = z.infer<typeof expenseImportPreviewFieldsSchema>;

/**
 * A preview-time category override the user made before applying. `categoryId:
 * null` files the row uncategorized (overriding a rule suggestion); an absent
 * `rowIndex` keeps the rule suggestion. Matched to the re-parsed file by the
 * deterministic physical `rowIndex`.
 */
export const expenseImportOverrideSchema = z
  .object({
    rowIndex: z.number().int(),
    categoryId: z.string().uuid().nullable(),
  })
  .strict();
export type ExpenseImportOverride = z.infer<typeof expenseImportOverrideSchema>;

/**
 * The non-file multipart fields of `POST /expenses/import/apply`. The same CSV is
 * re-uploaded as the `file` part (the server stays authoritative on amounts/dates
 * — never trusting client-echoed money); `overrides` is a JSON-encoded
 * {@link ExpenseImportOverride}[] the route parses + validates.
 */
export const expenseImportApplyFieldsSchema = z
  .object({
    bankId: z.string().min(1).max(64).optional(),
    // A WYSIWYG apply sends one override per importable row, so a max-size file
    // (IMPORT_MAX_ROWS) yields a large field — bounded under Multer's 1 MB field
    // default (and its content re-bounded to IMPORT_MAX_ROWS entries in the route).
    overrides: z.string().max(1_000_000).optional(),
  })
  .strict();
export type ExpenseImportApplyFields = z.infer<typeof expenseImportApplyFieldsSchema>;

/** One row's apply outcome inside the result report. */
export const expenseImportApplyRowSchema = z
  .object({
    rowIndex: z.number().int(),
    result: expenseImportRowResultSchema,
    message: z.string().nullable(),
  })
  .strict();
export type ExpenseImportApplyRow = z.infer<typeof expenseImportApplyRowSchema>;

/** `POST /expenses/import/apply` response — the per-row result report. */
export const expenseImportApplyResponseSchema = z
  .object({
    bankId: z.string(),
    bankLabel: z.string(),
    applied: z.number().int(),
    duplicate: z.number().int(),
    error: z.number().int(),
    rows: z.array(expenseImportApplyRowSchema),
  })
  .strict();
export type ExpenseImportApplyResponse = z.infer<typeof expenseImportApplyResponseSchema>;

// --- Dashboards + budgets (issue 3/3) ----------------------------------------

/**
 * Spend-by-category/month, income-vs-spend and trend dashboards plus per-category
 * monthly budgets with matrix-routed alerts (PROJECTPLAN.md §13.5 V5-P9, issue
 * 3/3). All aggregates are **currency-naive magnitude sums** in the category's
 * recorded amounts: the expense area is single-currency by design and imports no
 * FX/currency service (the strict-separation wall) — so a budget/dashboard never
 * converts, it sums the amounts as stored. A month is the calendar period
 * (`YYYY-MM`); a budget's `spent` and every dashboard total counts only
 * EXPENSE-direction rows unless a field says otherwise.
 */

/** A calendar month `YYYY-MM` (the dashboard + budget period key). */
export const expenseMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a YYYY-MM month.');

/** Default / max number of trailing months a trend query returns. */
export const EXPENSE_TREND_MONTHS_DEFAULT = 6;
export const EXPENSE_TREND_MONTHS_MAX = 24;

// ── Monthly summary (spend by category, income vs spend) ──

/**
 * One category's totals for a month. `categoryId: null` is the uncategorized
 * bucket (its `name`/`color` are null — the UI labels it locally). Both an
 * `expense` and an `income` magnitude are reported so the same row feeds the
 * spend donut and the income breakdown without a second query.
 */
export const expenseCategorySummarySchema = z
  .object({
    categoryId: z.string().uuid().nullable(),
    name: z.string().nullable(),
    color: z.string().nullable(),
    expense: z.number(),
    income: z.number(),
  })
  .strict();
export type ExpenseCategorySummary = z.infer<typeof expenseCategorySummarySchema>;

/** `GET /expenses/summary?month=` query — omitted month ⇒ the current month. */
export const expenseSummaryQuerySchema = z
  .object({ month: expenseMonthSchema.optional() })
  .strict();
export type ExpenseSummaryQuery = z.infer<typeof expenseSummaryQuerySchema>;

/**
 * `GET /expenses/summary` response. `totalExpense`/`totalIncome` reconcile
 * exactly to the sum of `categories[].expense`/`.income` (and thus to the
 * recorded/imported transaction sum for the month — the done-when invariant).
 */
export const expenseMonthlySummaryResponseSchema = z
  .object({
    month: z.string(),
    totalExpense: z.number(),
    totalIncome: z.number(),
    /** `totalIncome - totalExpense`. */
    net: z.number(),
    /** Per-category totals, expense-heaviest first; the uncategorized bucket last. */
    categories: z.array(expenseCategorySummarySchema),
  })
  .strict();
export type ExpenseMonthlySummaryResponse = z.infer<typeof expenseMonthlySummaryResponseSchema>;

// ── Trends (income vs spend over the trailing months) ──

/** One month's expense + income magnitude for the trend chart. */
export const expenseTrendPointSchema = z
  .object({ month: z.string(), expense: z.number(), income: z.number() })
  .strict();
export type ExpenseTrendPoint = z.infer<typeof expenseTrendPointSchema>;

/** `GET /expenses/trends?months=` query — trailing-month count (default 6, max 24). */
export const expenseTrendQuerySchema = z
  .object({
    months: z.coerce.number().int().positive().max(EXPENSE_TREND_MONTHS_MAX).optional(),
  })
  .strict();
export type ExpenseTrendQuery = z.infer<typeof expenseTrendQuerySchema>;

/** `GET /expenses/trends` response — oldest→newest, one point per month in the window. */
export const expenseTrendResponseSchema = z
  .object({ points: z.array(expenseTrendPointSchema) })
  .strict();
export type ExpenseTrendResponse = z.infer<typeof expenseTrendResponseSchema>;

// ── Budgets (per-category monthly targets + matrix-routed alerts) ──

/** One per-category monthly budget as returned to its owner. */
export const expenseBudgetSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    /** Positive monthly spend target. */
    amount: z.number(),
    currency: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ExpenseBudget = z.infer<typeof expenseBudgetSchema>;

/**
 * A budget with its evaluated progress for a period — what the budgets surface
 * lists. `spent` is the period's expense total in the category; `exceeded` is
 * `spent > amount` (the exact condition that fires the `budget.exceeded` alert).
 */
export const expenseBudgetProgressSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    /** Category snapshot for the row (a budget always targets a live category). */
    categoryName: z.string(),
    categoryColor: z.string(),
    amount: z.number(),
    currency: z.string(),
    /** The evaluated period (`YYYY-MM`). */
    period: z.string(),
    /** Expense spend recorded in the category this period. */
    spent: z.number(),
    /** `amount - spent` (negative once over budget). */
    remaining: z.number(),
    exceeded: z.boolean(),
  })
  .strict();
export type ExpenseBudgetProgress = z.infer<typeof expenseBudgetProgressSchema>;

/** `GET /expenses/budgets?month=` query — omitted month ⇒ the current month. */
export const expenseBudgetListQuerySchema = z
  .object({ month: expenseMonthSchema.optional() })
  .strict();
export type ExpenseBudgetListQuery = z.infer<typeof expenseBudgetListQuerySchema>;

/** `GET /expenses/budgets` response — the caller's budgets with this period's progress. */
export const expenseBudgetListResponseSchema = z
  .object({ period: z.string(), budgets: z.array(expenseBudgetProgressSchema) })
  .strict();
export type ExpenseBudgetListResponse = z.infer<typeof expenseBudgetListResponseSchema>;

/**
 * `POST /expenses/budgets` body. One budget per category (a second create for the
 * same category is a 409); `categoryId` must be a category the caller owns.
 */
export const createExpenseBudgetRequestSchema = z
  .object({
    categoryId: z.string().uuid(),
    amount: expenseAmountSchema,
    currency: currencySchema.default('EUR'),
  })
  .strict();
export type CreateExpenseBudgetRequest = z.infer<typeof createExpenseBudgetRequestSchema>;

/**
 * `PATCH /expenses/budgets/:budgetId` body — retarget the amount (and optionally
 * the currency). The category is fixed at creation (move = delete + create).
 */
export const updateExpenseBudgetRequestSchema = z
  .object({
    amount: expenseAmountSchema.optional(),
    currency: currencySchema.optional(),
  })
  .strict();
export type UpdateExpenseBudgetRequest = z.infer<typeof updateExpenseBudgetRequestSchema>;

/** `POST` / `PATCH` budget response. */
export const expenseBudgetResponseSchema = z.object({ budget: expenseBudgetSchema }).strict();
export type ExpenseBudgetResponse = z.infer<typeof expenseBudgetResponseSchema>;

/** Route param for the single-budget endpoints. */
export const expenseBudgetIdParamSchema = z.object({ budgetId: z.string().uuid() }).strict();
export type ExpenseBudgetIdParam = z.infer<typeof expenseBudgetIdParamSchema>;

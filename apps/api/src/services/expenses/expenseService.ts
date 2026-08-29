import type {
  CreateExpenseCategoryRequest,
  CreateExpenseRuleRequest,
  CreateExpenseTransactionRequest,
  ExpenseCategory,
  ExpenseCategoryListResponse,
  ExpenseCategoryResponse,
  ExpenseRule,
  ExpenseRuleListResponse,
  ExpenseRuleResponse,
  ExpenseTransaction,
  ExpenseTransactionListQuery,
  ExpenseTransactionListResponse,
  ExpenseTransactionResponse,
  UpdateExpenseCategoryRequest,
  UpdateExpenseRuleRequest,
  UpdateExpenseTransactionRequest,
} from '@bettertrack/contracts';
import { EXPENSE_TRANSACTION_LIST_DEFAULT } from '@bettertrack/contracts';

import { badRequest, conflict, notFound } from '../../errors';
import type {
  ExpenseCategoryRecord,
  ExpenseCategoryRepository,
  ExpenseRuleRecord,
  ExpenseRuleRepository,
  ExpenseTransactionRecord,
  ExpenseTransactionRepository,
} from '../../data/repositories/expenseRepository';
import { isSupportedExpenseRuleRegex } from './ruleEngine';

/**
 * Expense tracking — CRUD orchestration (PROJECTPLAN.md §13.5 V5-P9, foundation
 * issue 1/3). A NEW top-level area, STRICTLY separate from portfolio money: this
 * service imports nothing from `domain/**` money-math, tax or portfolio services,
 * and its repositories touch no portfolio table (spec: "zero TWR/tax
 * interaction").
 *
 * The service owns the rules the thin handlers stay out of:
 *  - **Owner validation of a referenced category (§8).** A transaction or rule
 *    may only point at a category the caller owns; a foreign/unknown id is a
 *    uniform 400, never an IDOR or an existence probe.
 *  - **Rule shapes only.** Rules are stored and CRUD-ed here; their evaluation
 *    (auto-categorization on import) is issue 2/3.
 */

/**
 * Called after a transaction write so budgets (issue 3/3) can re-evaluate the
 * current month and fire an over-budget alert (exactly once per period). Injected
 * as a plain callback — NOT a service import — so this CRUD service keeps its
 * strict separation from the notification/budget wiring and imports nothing new.
 * Best-effort: the hook swallows its own failures and never throws.
 */
export type ExpenseWriteHook = (userId: string) => Promise<void>;

/**
 * The minimum facts the expense service needs from a restored row. The caller
 * keeps the full row shape (including stable ids and timestamps) and passes it
 * unchanged to its transaction-bound writer.
 */
export interface ExpenseRestoreRow {
  categoryId: string | null;
  bookedOn: string;
}

/**
 * Caller-owned transaction seam for bulk restore. All three operations must use
 * repositories bound to the same transaction. Keeping the writer here as a
 * callback lets paranoid rehydration preserve its richer source-row shape
 * without this service importing vault contracts or opening a transaction.
 */
export interface ExpenseRestoreScope<TRow extends ExpenseRestoreRow> {
  ownsCategory(userId: string, categoryId: string): Promise<boolean>;
  insertTransactions(userId: string, rows: readonly TRow[]): Promise<void>;
  reconcileBudgets(userId: string, affectedPeriods: readonly string[]): Promise<void>;
}

export interface ExpenseServiceDeps {
  categories: ExpenseCategoryRepository;
  transactions: ExpenseTransactionRepository;
  rules: ExpenseRuleRepository;
  /** Budget re-evaluation hook (issue 3/3); omit to disable (foundation tests). */
  onTransactionWrite?: ExpenseWriteHook;
}

export interface ExpenseService {
  // Categories
  listCategories(userId: string): Promise<ExpenseCategoryListResponse>;
  createCategory(
    userId: string,
    input: CreateExpenseCategoryRequest,
  ): Promise<ExpenseCategoryResponse>;
  updateCategory(
    userId: string,
    categoryId: string,
    patch: UpdateExpenseCategoryRequest,
  ): Promise<ExpenseCategoryResponse>;
  deleteCategory(userId: string, categoryId: string): Promise<void>;
  // Transactions
  listTransactions(
    userId: string,
    query: ExpenseTransactionListQuery,
  ): Promise<ExpenseTransactionListResponse>;
  getTransaction(userId: string, transactionId: string): Promise<ExpenseTransactionResponse>;
  createTransaction(
    userId: string,
    input: CreateExpenseTransactionRequest,
  ): Promise<ExpenseTransactionResponse>;
  updateTransaction(
    userId: string,
    transactionId: string,
    patch: UpdateExpenseTransactionRequest,
  ): Promise<ExpenseTransactionResponse>;
  recategorizeTransaction(
    userId: string,
    transactionId: string,
    categoryId: string | null,
  ): Promise<ExpenseTransactionResponse>;
  deleteTransaction(userId: string, transactionId: string): Promise<void>;
  /**
   * Restore a batch through a caller-provided transaction. Category references
   * are validated before the first write, rows are inserted as one logical
   * batch, and budget effects run once through the no-replay restore fence.
   */
  restoreTransactions<TRow extends ExpenseRestoreRow>(
    userId: string,
    rows: readonly TRow[],
    scope: ExpenseRestoreScope<TRow>,
  ): Promise<void>;
  // Rules (shapes only; evaluation is issue 2/3)
  listRules(userId: string): Promise<ExpenseRuleListResponse>;
  createRule(userId: string, input: CreateExpenseRuleRequest): Promise<ExpenseRuleResponse>;
  updateRule(
    userId: string,
    ruleId: string,
    patch: UpdateExpenseRuleRequest,
  ): Promise<ExpenseRuleResponse>;
  deleteRule(userId: string, ruleId: string): Promise<void>;
}

const CATEGORY_NOT_FOUND = () => notFound('Category not found.', 'EXPENSE_CATEGORY_NOT_FOUND');
const TRANSACTION_NOT_FOUND = () =>
  notFound('Transaction not found.', 'EXPENSE_TRANSACTION_NOT_FOUND');
const RULE_NOT_FOUND = () => notFound('Rule not found.', 'EXPENSE_RULE_NOT_FOUND');
const CATEGORY_REF_INVALID = () =>
  badRequest('Referenced category not found.', 'EXPENSE_CATEGORY_REF_NOT_FOUND');
const CATEGORY_NAME_TAKEN = () =>
  conflict('A category with that name already exists.', 'EXPENSE_CATEGORY_NAME_TAKEN');
const RULE_REGEX_UNSUPPORTED = () =>
  badRequest('This regex pattern uses unsupported syntax.', 'EXPENSE_RULE_REGEX_UNSUPPORTED');

/** A Postgres unique-constraint violation (23505) — both postgres-js and PGlite set `.code`. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}

function toCategory(record: ExpenseCategoryRecord): ExpenseCategory {
  return {
    id: record.id,
    name: record.name,
    direction: record.direction,
    color: record.color,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toTransaction(record: ExpenseTransactionRecord): ExpenseTransaction {
  return {
    id: record.id,
    categoryId: record.categoryId,
    direction: record.direction,
    amount: record.amount,
    currency: record.currency,
    bookedOn: record.bookedOn,
    description: record.description,
    source: record.source,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toRule(record: ExpenseRuleRecord): ExpenseRule {
  return {
    id: record.id,
    categoryId: record.categoryId,
    matchType: record.matchType,
    pattern: record.pattern,
    priority: record.priority,
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function createExpenseService(deps: ExpenseServiceDeps): ExpenseService {
  const { categories, transactions, rules, onTransactionWrite } = deps;

  /** A referenced category must be one the caller actually owns (§8). */
  async function assertOwnsCategory(userId: string, categoryId: string): Promise<void> {
    if (!(await categories.ownsCategory(userId, categoryId))) throw CATEGORY_REF_INVALID();
  }

  /** Fire the budget re-evaluation hook after a write (no-op when unwired). */
  async function afterWrite(userId: string): Promise<void> {
    if (onTransactionWrite) await onTransactionWrite(userId);
  }

  return {
    // ── Categories ──
    async listCategories(userId) {
      // A PURE READ. This used to seed a starter set when the owner had none,
      // which outlived its purpose at the cash fusion: the expense area's writes
      // are retired (410) and its rows now live on the portfolio cash ledger, so
      // an implicit insert here only re-opens the divergence the retirement gate
      // exists to close — and re-enters the account into the catch-up script's
      // owner set, materialising starter `cash_tags` the user never created.
      const records = await categories.listForOwner(userId);
      return { categories: records.map(toCategory) };
    },

    async createCategory(userId, input) {
      let record: ExpenseCategoryRecord;
      try {
        record = await categories.create(userId, {
          name: input.name,
          direction: input.direction,
          color: input.color ?? '#64748b',
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw CATEGORY_NAME_TAKEN();
        throw err;
      }
      return { category: toCategory(record) };
    },

    async updateCategory(userId, categoryId, patch) {
      let record: ExpenseCategoryRecord | null;
      try {
        record = await categories.update(userId, categoryId, {
          name: patch.name,
          direction: patch.direction,
          color: patch.color,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw CATEGORY_NAME_TAKEN();
        throw err;
      }
      if (!record) throw CATEGORY_NOT_FOUND();
      return { category: toCategory(record) };
    },

    async deleteCategory(userId, categoryId) {
      const deleted = await categories.delete(userId, categoryId);
      if (!deleted) throw CATEGORY_NOT_FOUND();
    },

    // ── Transactions ──
    async listTransactions(userId, query) {
      const records = await transactions.listForOwner(userId, {
        categoryId: query.categoryId,
        direction: query.direction,
        from: query.from,
        to: query.to,
        limit: query.limit ?? EXPENSE_TRANSACTION_LIST_DEFAULT,
      });
      return { transactions: records.map(toTransaction) };
    },

    async getTransaction(userId, transactionId) {
      const record = await transactions.findByIdForOwner(userId, transactionId);
      if (!record) throw TRANSACTION_NOT_FOUND();
      return { transaction: toTransaction(record) };
    },

    async createTransaction(userId, input) {
      const categoryId = input.categoryId ?? null;
      if (categoryId !== null) await assertOwnsCategory(userId, categoryId);
      const record = await transactions.create(userId, {
        categoryId,
        direction: input.direction,
        amount: input.amount,
        currency: input.currency,
        bookedOn: input.bookedOn,
        description: input.description,
        source: 'manual',
      });
      await afterWrite(userId);
      return { transaction: toTransaction(record) };
    },

    async updateTransaction(userId, transactionId, patch) {
      if (patch.categoryId != null) await assertOwnsCategory(userId, patch.categoryId);
      const record = await transactions.update(userId, transactionId, {
        // `undefined` leaves the category untouched; `null` uncategorizes.
        categoryId: patch.categoryId === undefined ? undefined : (patch.categoryId ?? null),
        direction: patch.direction,
        amount: patch.amount,
        currency: patch.currency,
        bookedOn: patch.bookedOn,
        description: patch.description,
      });
      if (!record) throw TRANSACTION_NOT_FOUND();
      await afterWrite(userId);
      return { transaction: toTransaction(record) };
    },

    async recategorizeTransaction(userId, transactionId, categoryId) {
      if (categoryId !== null) await assertOwnsCategory(userId, categoryId);
      const record = await transactions.setCategory(userId, transactionId, categoryId);
      if (!record) throw TRANSACTION_NOT_FOUND();
      await afterWrite(userId);
      return { transaction: toTransaction(record) };
    },

    async deleteTransaction(userId, transactionId) {
      const deleted = await transactions.delete(userId, transactionId);
      if (!deleted) throw TRANSACTION_NOT_FOUND();
    },

    async restoreTransactions(userId, rows, scope) {
      if (rows.length === 0) return;

      // Validate every foreign key before the caller's writer can persist the
      // first row. The unique set avoids one ownership query per restored row.
      const categoryIds = new Set(
        rows.flatMap((row) => (row.categoryId === null ? [] : [row.categoryId])),
      );
      for (const categoryId of categoryIds) {
        if (!(await scope.ownsCategory(userId, categoryId))) throw CATEGORY_REF_INVALID();
      }

      await scope.insertTransactions(userId, rows);

      // Budget reconciliation is once per batch, never once per restored row.
      // Its errors intentionally propagate so the caller rolls back both the
      // expense rows and any closed-period no-replay markers.
      const periods = [...new Set(rows.map((row) => row.bookedOn.slice(0, 7)))].sort();
      await scope.reconcileBudgets(userId, periods);
    },

    // ── Rules ──
    async listRules(userId) {
      const records = await rules.listForOwner(userId);
      return { rules: records.map(toRule) };
    },

    async createRule(userId, input) {
      if (input.matchType === 'regex' && !isSupportedExpenseRuleRegex(input.pattern)) {
        throw RULE_REGEX_UNSUPPORTED();
      }
      await assertOwnsCategory(userId, input.categoryId);
      const record = await rules.create(userId, {
        categoryId: input.categoryId,
        matchType: input.matchType,
        pattern: input.pattern,
        priority: input.priority,
        enabled: input.enabled,
      });
      return { rule: toRule(record) };
    },

    async updateRule(userId, ruleId, patch) {
      if (patch.categoryId !== undefined) await assertOwnsCategory(userId, patch.categoryId);

      // Resolve the next shape before persisting. A PATCH may change only the
      // pattern of an existing regex rule, or change a literal rule into a regex.
      if (patch.matchType !== undefined || patch.pattern !== undefined) {
        const existing = await rules.findByIdForOwner(userId, ruleId);
        if (!existing) throw RULE_NOT_FOUND();
        const matchType = patch.matchType ?? existing.matchType;
        const pattern = patch.pattern ?? existing.pattern;
        if (matchType === 'regex' && !isSupportedExpenseRuleRegex(pattern)) {
          throw RULE_REGEX_UNSUPPORTED();
        }
      }

      const record = await rules.update(userId, ruleId, {
        categoryId: patch.categoryId,
        matchType: patch.matchType,
        pattern: patch.pattern,
        priority: patch.priority,
        enabled: patch.enabled,
      });
      if (!record) throw RULE_NOT_FOUND();
      return { rule: toRule(record) };
    },

    async deleteRule(userId, ruleId) {
      const deleted = await rules.delete(userId, ruleId);
      if (!deleted) throw RULE_NOT_FOUND();
    },
  };
}

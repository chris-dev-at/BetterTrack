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
  CreateExpenseCategoryInput,
  ExpenseCategoryRecord,
  ExpenseCategoryRepository,
  ExpenseRuleRecord,
  ExpenseRuleRepository,
  ExpenseTransactionRecord,
  ExpenseTransactionRepository,
} from '../../data/repositories/expenseRepository';

/**
 * Expense tracking — CRUD orchestration (PROJECTPLAN.md §13.5 V5-P9, foundation
 * issue 1/3). A NEW top-level area, STRICTLY separate from portfolio money: this
 * service imports nothing from `domain/**` money-math, tax or portfolio services,
 * and its repositories touch no portfolio table (spec: "zero TWR/tax
 * interaction").
 *
 * The service owns the rules the thin handlers stay out of:
 *  - **Default seeding.** Listing categories seeds a sensible starter set the
 *    first time a user has none (idempotent, race-safe) — so the category
 *    manager is never an empty void.
 *  - **Owner validation of a referenced category (§8).** A transaction or rule
 *    may only point at a category the caller owns; a foreign/unknown id is a
 *    uniform 400, never an IDOR or an existence probe.
 *  - **Rule shapes only.** Rules are stored and CRUD-ed here; their evaluation
 *    (auto-categorization on import) is issue 2/3.
 */

/**
 * The starter category set seeded on first use. These are editable seed DATA
 * (the user renames/deletes them; rules match on them) — not app chrome — so
 * they intentionally ship as neutral English names rather than i18n keys; the
 * rendered UI around them is fully localized. AT-relevant everyday buckets, kept
 * compact per the anti-bloat rule.
 */
export const DEFAULT_EXPENSE_CATEGORIES: readonly CreateExpenseCategoryInput[] = [
  { name: 'Groceries', direction: 'expense', color: '#22c55e' },
  { name: 'Rent & Housing', direction: 'expense', color: '#6366f1' },
  { name: 'Utilities', direction: 'expense', color: '#06b6d4' },
  { name: 'Transport', direction: 'expense', color: '#f59e0b' },
  { name: 'Dining & Takeout', direction: 'expense', color: '#ef4444' },
  { name: 'Shopping', direction: 'expense', color: '#ec4899' },
  { name: 'Health', direction: 'expense', color: '#14b8a6' },
  { name: 'Entertainment', direction: 'expense', color: '#a855f7' },
  { name: 'Insurance', direction: 'expense', color: '#64748b' },
  { name: 'Subscriptions', direction: 'expense', color: '#8b5cf6' },
  { name: 'Travel', direction: 'expense', color: '#0ea5e9' },
  { name: 'Other', direction: 'expense', color: '#94a3b8' },
  { name: 'Salary', direction: 'income', color: '#10b981' },
  { name: 'Other income', direction: 'income', color: '#34d399' },
];

export interface ExpenseServiceDeps {
  categories: ExpenseCategoryRepository;
  transactions: ExpenseTransactionRepository;
  rules: ExpenseRuleRepository;
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
  const { categories, transactions, rules } = deps;

  /** A referenced category must be one the caller actually owns (§8). */
  async function assertOwnsCategory(userId: string, categoryId: string): Promise<void> {
    if (!(await categories.ownsCategory(userId, categoryId))) throw CATEGORY_REF_INVALID();
  }

  return {
    // ── Categories ──
    async listCategories(userId) {
      // Seed the sensible starter set the first time a user opens the area, so
      // the category manager is never empty. Idempotent + race-safe.
      if ((await categories.countForOwner(userId)) === 0) {
        await categories.insertDefaults(userId, [...DEFAULT_EXPENSE_CATEGORIES]);
      }
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
      return { transaction: toTransaction(record) };
    },

    async recategorizeTransaction(userId, transactionId, categoryId) {
      if (categoryId !== null) await assertOwnsCategory(userId, categoryId);
      const record = await transactions.setCategory(userId, transactionId, categoryId);
      if (!record) throw TRANSACTION_NOT_FOUND();
      return { transaction: toTransaction(record) };
    },

    async deleteTransaction(userId, transactionId) {
      const deleted = await transactions.delete(userId, transactionId);
      if (!deleted) throw TRANSACTION_NOT_FOUND();
    },

    // ── Rules ──
    async listRules(userId) {
      const records = await rules.listForOwner(userId);
      return { rules: records.map(toRule) };
    },

    async createRule(userId, input) {
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

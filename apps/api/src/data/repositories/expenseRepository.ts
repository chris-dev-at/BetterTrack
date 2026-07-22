import { and, asc, desc, eq, gte, isNotNull, lte } from 'drizzle-orm';

import type { ExpenseDirection, ExpenseRuleMatchType } from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  expenseCategories,
  expenseRules,
  expenseTransactions,
  type ExpenseCategoryRow,
  type ExpenseRuleRow,
  type ExpenseTransactionRow,
} from '../schema';

/**
 * Expense-tracking persistence (PROJECTPLAN.md §13.5 V5-P9, foundation issue
 * 1/3). Three owner-scoped repositories — categories, transactions and rules.
 * Every mutation carries `WHERE user_id = :userId` at the SQL layer, so a row
 * belonging to another user is simply not found: callers 404 without leaking
 * existence, no IDOR by construction (§8).
 *
 * This layer is STRICTLY SEPARATE from portfolio money — it imports no portfolio
 * / domain / tax module and touches no portfolio table (the P9 mandate: zero
 * TWR/tax interaction). Budgets get their table in the same migration but no
 * repository yet — the budget surface is issue 3/3.
 */

// ── Categories ───────────────────────────────────────────────────────────────

/** A category as stored. */
export interface ExpenseCategoryRecord {
  id: string;
  userId: string;
  name: string;
  direction: ExpenseDirection;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields a category create persists. */
export interface CreateExpenseCategoryInput {
  name: string;
  direction: ExpenseDirection;
  color: string;
}

/** Fields a category update may touch (all optional). */
export interface UpdateExpenseCategoryPatch {
  name?: string;
  direction?: ExpenseDirection;
  color?: string;
}

function toCategory(row: ExpenseCategoryRow): ExpenseCategoryRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    direction: row.direction,
    color: row.color,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createExpenseCategoryRepository(db: Database) {
  return {
    /** Every category the owner has, by name. */
    async listForOwner(userId: string): Promise<ExpenseCategoryRecord[]> {
      const rows = await db
        .select()
        .from(expenseCategories)
        .where(eq(expenseCategories.userId, userId))
        .orderBy(asc(expenseCategories.name));
      return rows.map(toCategory);
    },

    /** Count the owner's categories — the seed-on-first-use gate. */
    async countForOwner(userId: string): Promise<number> {
      const rows = await db
        .select({ id: expenseCategories.id })
        .from(expenseCategories)
        .where(eq(expenseCategories.userId, userId));
      return rows.length;
    },

    /** A single category scoped to its owner (§8): null when unknown or foreign. */
    async findByIdForOwner(userId: string, id: string): Promise<ExpenseCategoryRecord | null> {
      const [row] = await db
        .select()
        .from(expenseCategories)
        .where(and(eq(expenseCategories.id, id), eq(expenseCategories.userId, userId)))
        .limit(1);
      return row ? toCategory(row) : null;
    },

    /** Whether `userId` owns category `id` — gates transaction/rule references (§8). */
    async ownsCategory(userId: string, id: string): Promise<boolean> {
      const [row] = await db
        .select({ id: expenseCategories.id })
        .from(expenseCategories)
        .where(and(eq(expenseCategories.id, id), eq(expenseCategories.userId, userId)))
        .limit(1);
      return row !== undefined;
    },

    /** Persist a new category; returns the stored record. */
    async create(
      userId: string,
      input: CreateExpenseCategoryInput,
    ): Promise<ExpenseCategoryRecord> {
      const [row] = await db
        .insert(expenseCategories)
        .values({ userId, name: input.name, direction: input.direction, color: input.color })
        .returning();
      if (!row) throw new Error('Expense category vanished after insert');
      return toCategory(row);
    },

    /**
     * Seed the owner's default categories, race-safe. `ON CONFLICT DO NOTHING`
     * against UNIQUE(user, name) makes a concurrent seed (two tabs opening the
     * area at once) idempotent — never a duplicate, never a 500.
     */
    async insertDefaults(userId: string, entries: CreateExpenseCategoryInput[]): Promise<void> {
      if (entries.length === 0) return;
      await db
        .insert(expenseCategories)
        .values(
          entries.map((e) => ({ userId, name: e.name, direction: e.direction, color: e.color })),
        )
        .onConflictDoNothing();
    },

    /** Update mutable fields, owner-scoped (§8). Null when the id is not the caller's. */
    async update(
      userId: string,
      id: string,
      patch: UpdateExpenseCategoryPatch,
    ): Promise<ExpenseCategoryRecord | null> {
      const set: Partial<{
        name: string;
        direction: ExpenseDirection;
        color: string;
        updatedAt: Date;
      }> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.direction !== undefined) set.direction = patch.direction;
      if (patch.color !== undefined) set.color = patch.color;
      if (Object.keys(set).length === 0) return this.findByIdForOwner(userId, id);
      set.updatedAt = new Date();
      const [row] = await db
        .update(expenseCategories)
        .set(set)
        .where(and(eq(expenseCategories.id, id), eq(expenseCategories.userId, userId)))
        .returning();
      return row ? toCategory(row) : null;
    },

    /**
     * Hard-delete, owner-scoped. Returns false when the id is not owned. The FK
     * SET-NULLs any transactions filed under it (they become uncategorized) and
     * cascades its rules/budget away.
     */
    async delete(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(expenseCategories)
        .where(and(eq(expenseCategories.id, id), eq(expenseCategories.userId, userId)))
        .returning({ id: expenseCategories.id });
      return rows.length > 0;
    },
  };
}

export type ExpenseCategoryRepository = ReturnType<typeof createExpenseCategoryRepository>;

// ── Transactions ─────────────────────────────────────────────────────────────

/** A transaction as stored (`amount` parsed to number; `bookedOn` an ISO day). */
export interface ExpenseTransactionRecord {
  id: string;
  userId: string;
  categoryId: string | null;
  direction: ExpenseDirection;
  amount: number;
  currency: string;
  bookedOn: string;
  description: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields a transaction create persists. */
export interface CreateExpenseTransactionInput {
  categoryId: string | null;
  direction: ExpenseDirection;
  amount: number;
  currency: string;
  bookedOn: string;
  description: string;
  source: string;
}

/** Fields a transaction update may touch (all optional). */
export interface UpdateExpenseTransactionPatch {
  categoryId?: string | null;
  direction?: ExpenseDirection;
  amount?: number;
  currency?: string;
  bookedOn?: string;
  description?: string;
}

/** Optional filters for the transaction list. */
export interface ExpenseTransactionListFilters {
  categoryId?: string;
  direction?: ExpenseDirection;
  from?: string;
  to?: string;
  limit: number;
}

/**
 * One bank-import row to persist (issue 2/3). Like a manual create but carries an
 * `import:<bank>` `source` and the `dedupHash` that keys idempotency — the CSV
 * importer sets both; manual creates leave the hash null (NULLs never collide in
 * the UNIQUE(user, dedup_hash) index).
 */
export interface InsertImportedExpenseInput {
  categoryId: string | null;
  direction: ExpenseDirection;
  amount: number;
  currency: string;
  bookedOn: string;
  description: string;
  source: string;
  dedupHash: string;
}

function toTransaction(row: ExpenseTransactionRow): ExpenseTransactionRecord {
  return {
    id: row.id,
    userId: row.userId,
    categoryId: row.categoryId,
    direction: row.direction,
    amount: Number(row.amount),
    currency: row.currency,
    bookedOn: row.bookedOn,
    description: row.description,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createExpenseTransactionRepository(db: Database) {
  return {
    /** The owner's transactions, newest first, honoring the filters. */
    async listForOwner(
      userId: string,
      filters: ExpenseTransactionListFilters,
    ): Promise<ExpenseTransactionRecord[]> {
      const conditions = [eq(expenseTransactions.userId, userId)];
      if (filters.categoryId !== undefined)
        conditions.push(eq(expenseTransactions.categoryId, filters.categoryId));
      if (filters.direction !== undefined)
        conditions.push(eq(expenseTransactions.direction, filters.direction));
      if (filters.from !== undefined)
        conditions.push(gte(expenseTransactions.bookedOn, filters.from));
      if (filters.to !== undefined) conditions.push(lte(expenseTransactions.bookedOn, filters.to));
      const rows = await db
        .select()
        .from(expenseTransactions)
        .where(and(...conditions))
        .orderBy(
          desc(expenseTransactions.bookedOn),
          desc(expenseTransactions.createdAt),
          desc(expenseTransactions.id),
        )
        .limit(filters.limit);
      return rows.map(toTransaction);
    },

    /** A single transaction scoped to its owner (§8): null when unknown or foreign. */
    async findByIdForOwner(userId: string, id: string): Promise<ExpenseTransactionRecord | null> {
      const [row] = await db
        .select()
        .from(expenseTransactions)
        .where(and(eq(expenseTransactions.id, id), eq(expenseTransactions.userId, userId)))
        .limit(1);
      return row ? toTransaction(row) : null;
    },

    /** Persist a new transaction; returns the stored record. */
    async create(
      userId: string,
      input: CreateExpenseTransactionInput,
    ): Promise<ExpenseTransactionRecord> {
      const [row] = await db
        .insert(expenseTransactions)
        .values({
          userId,
          categoryId: input.categoryId,
          direction: input.direction,
          amount: input.amount.toString(),
          currency: input.currency,
          bookedOn: input.bookedOn,
          description: input.description,
          source: input.source,
        })
        .returning();
      if (!row) throw new Error('Expense transaction vanished after insert');
      return toTransaction(row);
    },

    /**
     * The owner's non-null import dedup hashes — the CSV importer's existing-set
     * (issue 2/3). Manual rows carry a null hash and are excluded, so a manual
     * entry can never mask or be masked by an import.
     */
    async dedupHashesForOwner(userId: string): Promise<Set<string>> {
      const rows = await db
        .select({ dedupHash: expenseTransactions.dedupHash })
        .from(expenseTransactions)
        .where(
          and(eq(expenseTransactions.userId, userId), isNotNull(expenseTransactions.dedupHash)),
        );
      const hashes = new Set<string>();
      for (const row of rows) if (row.dedupHash !== null) hashes.add(row.dedupHash);
      return hashes;
    },

    /**
     * Bulk-insert imported rows in ONE statement (transactional), skipping any
     * whose `(user, dedup_hash)` already exists — the UNIQUE index is the
     * idempotency backstop against a concurrent apply / a row that raced in since
     * the caller computed its existing-set. Returns the hashes that actually
     * landed, so the caller can report the rest as duplicates. The caller has
     * already de-duplicated against the existing-set + within the file, so a
     * conflict here is only a race, never the common path.
     */
    async insertImported(
      userId: string,
      inputs: InsertImportedExpenseInput[],
    ): Promise<Set<string>> {
      if (inputs.length === 0) return new Set();
      const rows = await db
        .insert(expenseTransactions)
        .values(
          inputs.map((input) => ({
            userId,
            categoryId: input.categoryId,
            direction: input.direction,
            amount: input.amount.toString(),
            currency: input.currency,
            bookedOn: input.bookedOn,
            description: input.description,
            source: input.source,
            dedupHash: input.dedupHash,
          })),
        )
        .onConflictDoNothing({
          target: [expenseTransactions.userId, expenseTransactions.dedupHash],
        })
        .returning({ dedupHash: expenseTransactions.dedupHash });
      const inserted = new Set<string>();
      for (const row of rows) if (row.dedupHash !== null) inserted.add(row.dedupHash);
      return inserted;
    },

    /** Update mutable fields, owner-scoped (§8). Null when the id is not the caller's. */
    async update(
      userId: string,
      id: string,
      patch: UpdateExpenseTransactionPatch,
    ): Promise<ExpenseTransactionRecord | null> {
      const set: Partial<{
        categoryId: string | null;
        direction: ExpenseDirection;
        amount: string;
        currency: string;
        bookedOn: string;
        description: string;
        updatedAt: Date;
      }> = {};
      if (patch.categoryId !== undefined) set.categoryId = patch.categoryId;
      if (patch.direction !== undefined) set.direction = patch.direction;
      if (patch.amount !== undefined) set.amount = patch.amount.toString();
      if (patch.currency !== undefined) set.currency = patch.currency;
      if (patch.bookedOn !== undefined) set.bookedOn = patch.bookedOn;
      if (patch.description !== undefined) set.description = patch.description;
      if (Object.keys(set).length === 0) return this.findByIdForOwner(userId, id);
      set.updatedAt = new Date();
      const [row] = await db
        .update(expenseTransactions)
        .set(set)
        .where(and(eq(expenseTransactions.id, id), eq(expenseTransactions.userId, userId)))
        .returning();
      return row ? toTransaction(row) : null;
    },

    /**
     * Recategorize a single transaction (owner-scoped) — the dedicated
     * per-transaction path. `categoryId = null` uncategorizes. Null return when
     * the id is not the caller's.
     */
    async setCategory(
      userId: string,
      id: string,
      categoryId: string | null,
    ): Promise<ExpenseTransactionRecord | null> {
      const [row] = await db
        .update(expenseTransactions)
        .set({ categoryId, updatedAt: new Date() })
        .where(and(eq(expenseTransactions.id, id), eq(expenseTransactions.userId, userId)))
        .returning();
      return row ? toTransaction(row) : null;
    },

    /** Hard-delete, owner-scoped. False when the id is not owned. */
    async delete(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(expenseTransactions)
        .where(and(eq(expenseTransactions.id, id), eq(expenseTransactions.userId, userId)))
        .returning({ id: expenseTransactions.id });
      return rows.length > 0;
    },
  };
}

export type ExpenseTransactionRepository = ReturnType<typeof createExpenseTransactionRepository>;

// ── Rules (shapes only; evaluation is issue 2/3) ─────────────────────────────

/** A rule as stored. */
export interface ExpenseRuleRecord {
  id: string;
  userId: string;
  categoryId: string;
  matchType: ExpenseRuleMatchType;
  pattern: string;
  priority: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields a rule create persists. */
export interface CreateExpenseRuleInput {
  categoryId: string;
  matchType: ExpenseRuleMatchType;
  pattern: string;
  priority: number;
  enabled: boolean;
}

/** Fields a rule update may touch (all optional). */
export interface UpdateExpenseRulePatch {
  categoryId?: string;
  matchType?: ExpenseRuleMatchType;
  pattern?: string;
  priority?: number;
  enabled?: boolean;
}

function toRule(row: ExpenseRuleRow): ExpenseRuleRecord {
  return {
    id: row.id,
    userId: row.userId,
    categoryId: row.categoryId,
    matchType: row.matchType,
    pattern: row.pattern,
    priority: row.priority,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createExpenseRuleRepository(db: Database) {
  return {
    /** Every rule the owner has, by ascending priority then age (evaluation order). */
    async listForOwner(userId: string): Promise<ExpenseRuleRecord[]> {
      const rows = await db
        .select()
        .from(expenseRules)
        .where(eq(expenseRules.userId, userId))
        .orderBy(asc(expenseRules.priority), asc(expenseRules.createdAt), asc(expenseRules.id));
      return rows.map(toRule);
    },

    /** A single rule scoped to its owner (§8): null when unknown or foreign. */
    async findByIdForOwner(userId: string, id: string): Promise<ExpenseRuleRecord | null> {
      const [row] = await db
        .select()
        .from(expenseRules)
        .where(and(eq(expenseRules.id, id), eq(expenseRules.userId, userId)))
        .limit(1);
      return row ? toRule(row) : null;
    },

    /** Persist a new rule; returns the stored record. */
    async create(userId: string, input: CreateExpenseRuleInput): Promise<ExpenseRuleRecord> {
      const [row] = await db
        .insert(expenseRules)
        .values({
          userId,
          categoryId: input.categoryId,
          matchType: input.matchType,
          pattern: input.pattern,
          priority: input.priority,
          enabled: input.enabled,
        })
        .returning();
      if (!row) throw new Error('Expense rule vanished after insert');
      return toRule(row);
    },

    /** Update mutable fields, owner-scoped (§8). Null when the id is not the caller's. */
    async update(
      userId: string,
      id: string,
      patch: UpdateExpenseRulePatch,
    ): Promise<ExpenseRuleRecord | null> {
      const set: Partial<{
        categoryId: string;
        matchType: ExpenseRuleMatchType;
        pattern: string;
        priority: number;
        enabled: boolean;
        updatedAt: Date;
      }> = {};
      if (patch.categoryId !== undefined) set.categoryId = patch.categoryId;
      if (patch.matchType !== undefined) set.matchType = patch.matchType;
      if (patch.pattern !== undefined) set.pattern = patch.pattern;
      if (patch.priority !== undefined) set.priority = patch.priority;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      if (Object.keys(set).length === 0) return this.findByIdForOwner(userId, id);
      set.updatedAt = new Date();
      const [row] = await db
        .update(expenseRules)
        .set(set)
        .where(and(eq(expenseRules.id, id), eq(expenseRules.userId, userId)))
        .returning();
      return row ? toRule(row) : null;
    },

    /** Hard-delete, owner-scoped. False when the id is not owned. */
    async delete(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(expenseRules)
        .where(and(eq(expenseRules.id, id), eq(expenseRules.userId, userId)))
        .returning({ id: expenseRules.id });
      return rows.length > 0;
    },
  };
}

export type ExpenseRuleRepository = ReturnType<typeof createExpenseRuleRepository>;

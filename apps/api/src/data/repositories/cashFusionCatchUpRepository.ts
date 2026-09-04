import { and, eq, inArray, sql } from 'drizzle-orm';

import { CASH_SYSTEM_TAGS } from '@bettertrack/contracts';

import type { Database } from '../db';
import { newId } from '../ids';
import {
  cashBudgetFires,
  cashBudgets,
  cashMovementTags,
  cashRuleTags,
  cashRules,
  cashTags,
  expenseBudgetFires,
  expenseBudgets,
  expenseCategories,
  expenseRules,
  expenseTransactions,
  portfolioCashMovements,
  portfolioCashSources,
  portfolioDailySnapshots,
  portfolioSnapshotState,
  portfolios,
} from '../schema';
import {
  MICROS_PER_CENT,
  parseCents,
  parseMicros,
  type OwnerPlan,
  type OwnerSnapshot,
} from '../../scripts/cashFusionCatchUpCore';

/**
 * Persistence for the V5 cash-fusion catch-up (`scripts/catchUpCashFusion.ts`).
 * All decisions live in `scripts/cashFusionCatchUpCore.ts`; this file only reads
 * one owner's rows and applies a plan the core already produced.
 *
 * SCOPING. Every read and every write is filtered by the owner: the four source
 * tables carry `user_id` directly, and the fused rows are reached through
 * `portfolios.user_id` (movements, budgets) or `cash_tags.user_id` (tags, rules).
 * No query in this file is written against a bare id.
 *
 * ATOMICITY. `applyOwnerPlan` runs one owner's whole plan in ONE transaction and
 * re-derives the reconciliation inside it, throwing — and therefore rolling the
 * owner back — when the count or the signed sum disagrees. That is 0076's final
 * `DO` block applied per owner: an owner either lands completely and reconciles
 * to the cent, or is left exactly as it was and reported as failed. The daily
 * snapshots those backdated movements invalidate are marked dirty inside that
 * same transaction, so a caught-up ledger and a stale series cannot coexist.
 */

/**
 * The journal `when` of `0076_cash_fusion`. drizzle's postgres migrator records
 * the journal's `when` in `drizzle.__drizzle_migrations.created_at` (NOT the
 * instant the migration ran — see `scripts/checkMigrationsImmutable.ts`), so this
 * constant is how "has the fusion been applied" is asked. A test pins it against
 * the journal so it cannot drift.
 */
export const CASH_FUSION_MIGRATION_WHEN = 1_785_377_115_695;

export interface CashFusionCatchUpRepository {
  /**
   * The instant migration 0076 ran, or `null` when it has not been applied.
   *
   * Preferred signal is `min(cash_tags.created_at)` over the app-owned tags: 0076
   * seeded them inside its own transaction with the column default, so that value
   * IS the migration instant, as recorded by the database rather than by the repo.
   * When 0076 ran against a database with no users there is nothing to read, so
   * the journal `when` stands in — earlier than the real deploy, which only ever
   * widens the "genuinely new" window and never narrows it.
   */
  fusionAppliedAt(): Promise<Date | null>;
  /** Every user owning at least one row in any of the four source tables. */
  listOwners(): Promise<string[]>;
  loadOwner(
    userId: string,
    spendingPortfolioId: string,
    spendingSourceId: string,
  ): Promise<OwnerSnapshot>;
  /**
   * Apply one owner's plan atomically; throws on a reconciliation mismatch.
   * Returns the UTC day of the earliest movement it actually inserted — the day
   * the owner's snapshots were invalidated from — or `null` when it wrote none.
   */
  applyOwnerPlan(plan: OwnerPlan, fusionAppliedAt: Date): Promise<ApplyOwnerPlanResult>;
}

export interface ApplyOwnerPlanResult {
  /** ISO `YYYY-MM-DD` the snapshots were invalidated from; null = nothing written. */
  invalidatedFrom: string | null;
}

/** `db.execute` hands back `{ rows }`; narrow it once here. */
function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

export function createCashFusionCatchUpRepository(db: Database): CashFusionCatchUpRepository {
  return {
    async fusionAppliedAt(): Promise<Date | null> {
      const applied = rowsOf<{ max: string | number | null }>(
        await db.execute(
          sql`SELECT max("created_at") AS "max" FROM "drizzle"."__drizzle_migrations"`,
        ),
      );
      const highest = applied[0]?.max;
      if (highest === null || highest === undefined) return null;
      if (Number(highest) < CASH_FUSION_MIGRATION_WHEN) return null;

      const seeded = await db
        .select({ at: sql<Date | string | null>`min(${cashTags.createdAt})` })
        .from(cashTags)
        .where(eq(cashTags.system, true));
      const at = seeded[0]?.at ?? null;
      // Driver-dependent: postgres-js hands back a Date, PGlite a timestamp
      // string. Anything unparseable falls back rather than yielding NaN.
      if (at instanceof Date) return at;
      if (typeof at === 'string') {
        const parsed = new Date(at);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
      return new Date(CASH_FUSION_MIGRATION_WHEN);
    },

    async listOwners(): Promise<string[]> {
      // Two populations, because the catch-up does two jobs:
      //  1. anyone owning an `expense_*` row — the divergence to migrate;
      //  2. anyone with an INCOMPLETE app-owned tag set — the backfill. 0076
      //     seeded system tags `FROM users`, so only accounts that existed when it
      //     ran got them; every account registered afterwards has none, and
      //     auto-tagging would have nowhere to land. Compared against the expected
      //     count rather than "has any", so an account that lost one key to a name
      //     collision is picked up too.
      // UNION (not UNION ALL) de-duplicates an owner that qualifies both ways.
      const rows = rowsOf<{ user_id: string }>(
        await db.execute(sql`
          SELECT "user_id" FROM "expense_transactions"
          UNION SELECT "user_id" FROM "expense_categories"
          UNION SELECT "user_id" FROM "expense_budgets"
          UNION SELECT "user_id" FROM "expense_rules"
          UNION
          SELECT u."id" FROM "users" u
          WHERE (
            SELECT count(*) FROM "cash_tags" t
            WHERE t."user_id" = u."id" AND t."system" = true
          ) < ${CASH_SYSTEM_TAGS.length}
          ORDER BY 1
        `),
      );
      return rows.map((row) => row.user_id);
    },

    async loadOwner(
      userId: string,
      spendingPortfolioId: string,
      spendingSourceId: string,
    ): Promise<OwnerSnapshot> {
      const [
        ownerPortfolios,
        categories,
        transactions,
        budgets,
        rules,
        existingTags,
        existingBudgets,
        existingRules,
      ] = await Promise.all([
        db
          .select({ id: portfolios.id, name: portfolios.name, sortOrder: portfolios.sortOrder })
          .from(portfolios)
          .where(eq(portfolios.userId, userId)),
        db
          .select({
            id: expenseCategories.id,
            name: expenseCategories.name,
            color: expenseCategories.color,
            createdAt: expenseCategories.createdAt,
            updatedAt: expenseCategories.updatedAt,
          })
          .from(expenseCategories)
          .where(eq(expenseCategories.userId, userId)),
        db
          .select({
            id: expenseTransactions.id,
            categoryId: expenseTransactions.categoryId,
            direction: expenseTransactions.direction,
            amount: expenseTransactions.amount,
            currency: expenseTransactions.currency,
            bookedOn: expenseTransactions.bookedOn,
            description: expenseTransactions.description,
            source: expenseTransactions.source,
            dedupHash: expenseTransactions.dedupHash,
            createdAt: expenseTransactions.createdAt,
          })
          .from(expenseTransactions)
          .where(eq(expenseTransactions.userId, userId)),
        db
          .select({
            id: expenseBudgets.id,
            categoryId: expenseBudgets.categoryId,
            amount: expenseBudgets.amount,
            currency: expenseBudgets.currency,
            createdAt: expenseBudgets.createdAt,
            updatedAt: expenseBudgets.updatedAt,
          })
          .from(expenseBudgets)
          .where(eq(expenseBudgets.userId, userId)),
        db
          .select({
            id: expenseRules.id,
            categoryId: expenseRules.categoryId,
            matchType: expenseRules.matchType,
            pattern: expenseRules.pattern,
            priority: expenseRules.priority,
            enabled: expenseRules.enabled,
            createdAt: expenseRules.createdAt,
            updatedAt: expenseRules.updatedAt,
          })
          .from(expenseRules)
          .where(eq(expenseRules.userId, userId)),
        db
          .select({
            id: cashTags.id,
            name: cashTags.name,
            system: cashTags.system,
            systemKey: cashTags.systemKey,
          })
          .from(cashTags)
          .where(eq(cashTags.userId, userId)),
        // Budgets reach the owner through the portfolio, like every other
        // portfolio-scoped table — there is no redundant user_id to trust.
        db
          .select({
            id: cashBudgets.id,
            tagId: cashBudgets.tagId,
            periodKey: cashBudgets.periodKey,
          })
          .from(cashBudgets)
          .innerJoin(portfolios, eq(portfolios.id, cashBudgets.portfolioId))
          .where(eq(portfolios.userId, userId)),
        db.select({ id: cashRules.id }).from(cashRules).where(eq(cashRules.userId, userId)),
      ]);

      const transactionIds = transactions.map((row) => row.id);
      // Already-fused movements covering this owner's expense rows, each with the
      // tags it carries. The portfolio join is the ownership check 0076's
      // verification used: a movement sitting in someone else's portfolio must NOT
      // read as a successful migration.
      const fusedRows =
        transactionIds.length === 0
          ? []
          : await db
              .select({
                id: portfolioCashMovements.id,
                amountEur: portfolioCashMovements.amountEur,
                tagId: cashMovementTags.tagId,
              })
              .from(portfolioCashMovements)
              .innerJoin(portfolios, eq(portfolios.id, portfolioCashMovements.portfolioId))
              .leftJoin(
                cashMovementTags,
                eq(cashMovementTags.movementId, portfolioCashMovements.id),
              )
              .where(
                and(
                  eq(portfolios.userId, userId),
                  inArray(portfolioCashMovements.id, transactionIds),
                ),
              );
      const fusedById = new Map<string, { id: string; amountEur: string; tagIds: string[] }>();
      for (const row of fusedRows) {
        const entry = fusedById.get(row.id) ?? {
          id: row.id,
          amountEur: row.amountEur,
          tagIds: [],
        };
        if (row.tagId !== null) entry.tagIds.push(row.tagId);
        fusedById.set(row.id, entry);
      }
      const existingMovements = [...fusedById.values()];

      const budgetIds = budgets.map((row) => row.id);
      const [fires, existingFires] = await Promise.all([
        budgetIds.length === 0
          ? Promise.resolve([])
          : db
              .select({
                id: expenseBudgetFires.id,
                budgetId: expenseBudgetFires.budgetId,
                periodKey: expenseBudgetFires.periodKey,
                firedAt: expenseBudgetFires.firedAt,
              })
              .from(expenseBudgetFires)
              .where(inArray(expenseBudgetFires.budgetId, budgetIds)),
        db
          .select({
            budgetId: cashBudgetFires.budgetId,
            periodKey: cashBudgetFires.periodKey,
          })
          .from(cashBudgetFires)
          .innerJoin(cashBudgets, eq(cashBudgets.id, cashBudgetFires.budgetId))
          .innerJoin(portfolios, eq(portfolios.id, cashBudgets.portfolioId))
          .where(eq(portfolios.userId, userId)),
      ]);

      const spendingPortfolio = ownerPortfolios.find((row) => row.id === spendingPortfolioId);
      const spendingSourceExists =
        spendingPortfolio === undefined
          ? false
          : (
              await db
                .select({ id: portfolioCashSources.id })
                .from(portfolioCashSources)
                .where(
                  and(
                    eq(portfolioCashSources.portfolioId, spendingPortfolioId),
                    eq(portfolioCashSources.id, spendingSourceId),
                  ),
                )
                .limit(1)
            ).length > 0;

      return {
        userId,
        portfolioNames: ownerPortfolios.map((row) => row.name),
        maxSortOrder: ownerPortfolios.reduce((max, row) => Math.max(max, row.sortOrder), 0),
        spendingPortfolioExists: spendingPortfolio !== undefined,
        spendingSourceExists,
        categories,
        transactions,
        budgets,
        fires,
        rules,
        existingTags,
        existingMovements,
        existingBudgets,
        existingFires,
        existingRuleIds: existingRules.map((row) => row.id),
      };
    },

    async applyOwnerPlan(plan: OwnerPlan, fusionAppliedAt: Date): Promise<ApplyOwnerPlanResult> {
      return db.transaction(async (tx) => {
        if (plan.createPortfolio !== null) {
          await tx
            .insert(portfolios)
            .values({
              id: plan.createPortfolio.id,
              userId: plan.userId,
              name: plan.createPortfolio.name,
              sortOrder: plan.createPortfolio.sortOrder,
            })
            .onConflictDoNothing();
        }
        if (plan.createSource !== null) {
          // name/type/is_main exactly as migration 0019 provisions a Main, so the
          // ledger's one-Main-per-portfolio invariant holds from birth.
          await tx
            .insert(portfolioCashSources)
            .values({
              id: plan.createSource.id,
              portfolioId: plan.portfolioId,
              name: plan.createSource.name,
              type: 'cash',
              isMain: true,
            })
            .onConflictDoNothing();
        }

        if (plan.tags.length > 0) {
          await tx
            .insert(cashTags)
            .values(
              plan.tags.map((tag) => ({
                id: tag.id,
                userId: plan.userId,
                name: tag.name,
                color: tag.color,
                system: tag.system,
                systemKey: tag.systemKey,
                createdAt: tag.createdAt,
                updatedAt: tag.updatedAt,
              })),
            )
            // Bare, like 0076's seed: safe against the primary key AND against a
            // name already in use case-insensitively.
            .onConflictDoNothing();
        }

        // The day the earliest movement this transaction actually WROTE lands
        // on. Taken from the returned rows, not from the plan: a row the insert
        // skipped was already in the ledger, and re-invalidating for it would
        // make every re-run of a caught-up owner throw the series away again.
        let invalidatedFrom: string | null = null;
        if (plan.movements.length > 0) {
          const inserted = await tx
            .insert(portfolioCashMovements)
            .values(
              plan.movements.map((movement) => ({
                id: movement.id,
                portfolioId: plan.portfolioId,
                sourceId: movement.sourceId,
                kind: movement.kind,
                amountEur: movement.amountEur,
                executedAt: movement.executedAt,
                note: movement.note,
                source: movement.source,
                dedupHash: movement.dedupHash,
                originalCurrency: movement.originalCurrency,
                createdAt: movement.createdAt,
              })),
            )
            .onConflictDoNothing()
            .returning({ executedAt: portfolioCashMovements.executedAt });
          for (const row of inserted) {
            const day = row.executedAt.toISOString().slice(0, 10);
            if (invalidatedFrom === null || day < invalidatedFrom) invalidatedFrom = day;
          }
        }

        if (plan.movementTags.length > 0) {
          await tx
            .insert(cashMovementTags)
            .values(
              plan.movementTags.map((link) => ({
                id: newId(),
                movementId: link.movementId,
                tagId: link.tagId,
              })),
            )
            .onConflictDoNothing({
              target: [cashMovementTags.movementId, cashMovementTags.tagId],
            });
        }

        if (plan.budgets.length > 0) {
          await tx
            .insert(cashBudgets)
            .values(
              plan.budgets.map((budget) => ({
                id: budget.id,
                portfolioId: plan.portfolioId,
                tagId: budget.tagId,
                periodKey: budget.periodKey,
                amount: budget.amount,
                currency: budget.currency,
                createdAt: budget.createdAt,
                updatedAt: budget.updatedAt,
              })),
            )
            .onConflictDoNothing();
        }

        if (plan.fires.length > 0) {
          await tx
            .insert(cashBudgetFires)
            .values(
              plan.fires.map((fire) => ({
                id: fire.id,
                budgetId: fire.budgetId,
                periodKey: fire.periodKey,
                firedAt: fire.firedAt,
              })),
            )
            .onConflictDoNothing({
              target: [cashBudgetFires.budgetId, cashBudgetFires.periodKey],
            });
        }

        if (plan.rules.length > 0) {
          await tx
            .insert(cashRules)
            .values(
              plan.rules.map((rule) => ({
                id: rule.id,
                userId: plan.userId,
                matchType: rule.matchType,
                pattern: rule.pattern,
                priority: rule.priority,
                enabled: rule.enabled,
                createdAt: rule.createdAt,
                updatedAt: rule.updatedAt,
              })),
            )
            .onConflictDoNothing();
        }

        if (plan.ruleTags.length > 0) {
          await tx
            .insert(cashRuleTags)
            .values(
              plan.ruleTags.map((link) => ({
                id: newId(),
                ruleId: link.ruleId,
                tagId: link.tagId,
              })),
            )
            .onConflictDoNothing({ target: [cashRuleTags.ruleId, cashRuleTags.tagId] });
        }

        // ── The proof (0076 §13, per owner) ───────────────────────────────────
        // In-scope rows are those that already have a fused counterpart plus those
        // created after the fusion ran; a pre-fusion row with no counterpart was
        // deleted on the fused side on purpose and is excluded here exactly as it
        // was excluded from the plan. Every in-scope row must have landed, in a
        // portfolio this same owner owns, and the signed sums must match.
        const verified = rowsOf<{
          in_scope: string | number;
          matched: string | number;
          expected_net: string | null;
          fused_net: string | null;
        }>(
          await tx.execute(sql`
            SELECT
              count(*) AS "in_scope",
              count(p."id") AS "matched",
              sum(CASE x."direction" WHEN 'income' THEN x."amount" ELSE -x."amount" END)
                AS "expected_net",
              coalesce(sum(pm."amount_eur"), 0) AS "fused_net"
            FROM "expense_transactions" x
            LEFT JOIN "portfolio_cash_movements" pm ON pm."id" = x."id"
            LEFT JOIN "portfolios" p
              ON p."id" = pm."portfolio_id" AND p."user_id" = x."user_id"
            WHERE x."user_id" = ${plan.userId}
              AND (pm."id" IS NOT NULL OR x."created_at" > ${fusionAppliedAt})
          `),
        );
        const row = verified[0];
        if (row === undefined) throw new Error('catch-up reconciliation returned no row');

        const inScope = Number(row.in_scope);
        const matched = Number(row.matched);
        // Compared in MICROS: the expense side is 2dp, the ledger 6dp, so the
        // source figure is scaled up rather than the ledger figure rounded down —
        // a stray sub-cent on the ledger must fail the check, not vanish into it.
        const expectedMicros = parseCents(row.expected_net ?? '0') * MICROS_PER_CENT;
        const fusedMicros = parseMicros(row.fused_net ?? '0');
        if (inScope !== matched || expectedMicros !== fusedMicros) {
          throw new Error(
            `cash-fusion catch-up does not reconcile for ${plan.userId}: ` +
              `${matched}/${inScope} rows landed, net ${fusedMicros} vs expected ` +
              `${expectedMicros} (micros). Rolled back; nothing written for this owner.`,
          );
        }

        // ── Snapshot invalidation (§16 2026-07-17) ────────────────────────────
        // These movements are backdated EXTERNAL flows, so every precomputed
        // daily snapshot from the earliest of them is now wrong — in value and
        // in TWR flow alike. The nightly roll only overwrites its trailing heal
        // window, so a marker not written here is never written at all and an
        // older day stays wrong forever. Same two statements
        // `portfolioSnapshotRepository`'s markDirty/deleteFrom run, issued in
        // THIS transaction so the ledger rows and their invalidation land or
        // roll back together.
        if (invalidatedFrom !== null) {
          await tx
            .insert(portfolioSnapshotState)
            .values({
              portfolioId: plan.portfolioId,
              computedThrough: invalidatedFrom,
              dirtyFrom: invalidatedFrom,
            })
            .onConflictDoUpdate({
              target: portfolioSnapshotState.portfolioId,
              set: {
                dirtyFrom: sql`least(coalesce(${portfolioSnapshotState.dirtyFrom}, excluded.dirty_from), excluded.dirty_from)`,
                updatedAt: sql`now()`,
              },
            });
          await tx
            .delete(portfolioDailySnapshots)
            .where(
              sql`${portfolioDailySnapshots.portfolioId} = ${plan.portfolioId} and ${portfolioDailySnapshots.date} >= ${invalidatedFrom}`,
            );
        }

        return { invalidatedFrom };
      });
    },
  };
}

/** The journal tag the constant above belongs to, for the CLI's error copy. */
export const CASH_FUSION_TAG = '0076_cash_fusion';

import { and, asc, eq, inArray } from 'drizzle-orm';

import type { CashRuleMatchType } from '@bettertrack/contracts';

import type { Database } from '../db';
import { cashRuleTags, cashRules, cashTags, type CashRuleRow } from '../schema';
import { applyCashRulesForOwner } from './cashRuleTagStamp';

/**
 * Cash auto-tagging rule persistence (V5 cash fusion). A rule tests a movement's
 * `note` and, on a match, applies ALL of its tags. Per-user like the tags they
 * assign — the same merchant means the same thing in every ledger the user owns.
 *
 * SCOPING (§10). `cash_rules.user_id` is filtered on every read and write, and a
 * rule's tag set is only ever written from ids proved to belong to the same owner
 * — the same invariant `cash_movement_tags` has, and equally unexpressible as a
 * foreign key.
 *
 * EVALUATION ORDER IS THIS FILE'S RESPONSIBILITY. `listForOwner` returns rules by
 * ascending `priority`, then age, then id; the engine walks that order and stops
 * at the first match. The tie-breakers matter: without them two rules of equal
 * priority would evaluate in whatever order Postgres returned them, so the same
 * note could tag differently between two requests.
 */

export interface CashRuleRecord {
  id: string;
  userId: string;
  matchType: CashRuleMatchType;
  pattern: string;
  priority: number;
  enabled: boolean;
  /** The tags a matching movement receives; ordered for a stable response. */
  tagIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCashRuleInput {
  matchType: CashRuleMatchType;
  pattern: string;
  priority: number;
  enabled: boolean;
  tagIds: readonly string[];
}

export interface UpdateCashRulePatch {
  matchType?: CashRuleMatchType;
  pattern?: string;
  priority?: number;
  enabled?: boolean;
  /** When present, REPLACES the rule's whole tag set. */
  tagIds?: readonly string[];
}

function toRule(row: CashRuleRow, tagIds: string[]): CashRuleRecord {
  return {
    id: row.id,
    userId: row.userId,
    matchType: row.matchType,
    pattern: row.pattern,
    priority: row.priority,
    enabled: row.enabled,
    tagIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createCashRuleRepository(db: Database) {
  /**
   * Tag sets for a set of rules, joined through `cash_tags.user_id` so a link row
   * pointing at a foreign tag could never surface in a response.
   *
   * TAKES ITS EXECUTOR. Called from inside `update`'s transaction, so it must
   * read on that transaction's handle: issuing the query on the outer `db`
   * instead deadlocks the request against its own open transaction under PGlite
   * (one connection) and, in production, reads outside the transaction while
   * holding two pool connections for one update.
   */
  async function tagIdsForRules(
    executor: Database,
    userId: string,
    ruleIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const byRule = new Map<string, string[]>();
    if (ruleIds.length === 0) return byRule;
    const rows = await executor
      .select({ ruleId: cashRuleTags.ruleId, tagId: cashRuleTags.tagId, name: cashTags.name })
      .from(cashRuleTags)
      .innerJoin(cashTags, eq(cashTags.id, cashRuleTags.tagId))
      .where(and(inArray(cashRuleTags.ruleId, [...ruleIds]), eq(cashTags.userId, userId)))
      .orderBy(asc(cashTags.name));
    for (const row of rows) {
      const existing = byRule.get(row.ruleId);
      if (existing) existing.push(row.tagId);
      else byRule.set(row.ruleId, [row.tagId]);
    }
    return byRule;
  }

  return {
    /**
     * Every rule the owner has, IN EVALUATION ORDER. The engine relies on this
     * ordering and does not sort — see the note at the top of the file.
     */
    async listForOwner(userId: string): Promise<CashRuleRecord[]> {
      const rows = await db
        .select()
        .from(cashRules)
        .where(eq(cashRules.userId, userId))
        .orderBy(asc(cashRules.priority), asc(cashRules.createdAt), asc(cashRules.id));
      const tags = await tagIdsForRules(
        db,
        userId,
        rows.map((row) => row.id),
      );
      return rows.map((row) => toRule(row, tags.get(row.id) ?? []));
    },

    async findByIdForOwner(userId: string, ruleId: string): Promise<CashRuleRecord | null> {
      const rows = await db
        .select()
        .from(cashRules)
        .where(and(eq(cashRules.userId, userId), eq(cashRules.id, ruleId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const tags = await tagIdsForRules(db, userId, [row.id]);
      return toRule(row, tags.get(row.id) ?? []);
    },

    /**
     * Create the rule and its tag set atomically. A rule with no tag could never
     * do anything, so the contract requires at least one and the transaction keeps
     * a half-created rule from ever being observable.
     */
    async create(userId: string, input: CreateCashRuleInput): Promise<CashRuleRecord> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(cashRules)
          .values({
            userId,
            matchType: input.matchType,
            pattern: input.pattern,
            priority: input.priority,
            enabled: input.enabled,
          })
          .returning();
        const tagIds = [...new Set(input.tagIds)];
        if (tagIds.length > 0) {
          await tx
            .insert(cashRuleTags)
            .values(tagIds.map((tagId) => ({ ruleId: row!.id, tagId })))
            .onConflictDoNothing({ target: [cashRuleTags.ruleId, cashRuleTags.tagId] });
        }
        return toRule(row!, tagIds);
      });
    },

    /**
     * Patch a rule, optionally replacing its tag set wholesale. Ownership is
     * re-proved by the `WHERE`, so a rule id from another account updates nothing
     * and the service 404s.
     */
    async update(
      userId: string,
      ruleId: string,
      patch: UpdateCashRulePatch,
    ): Promise<CashRuleRecord | null> {
      return db.transaction(async (tx) => {
        const touchesFields =
          patch.matchType !== undefined ||
          patch.pattern !== undefined ||
          patch.priority !== undefined ||
          patch.enabled !== undefined;

        let row: CashRuleRow | undefined;
        if (touchesFields) {
          [row] = await tx
            .update(cashRules)
            .set({
              ...(patch.matchType !== undefined ? { matchType: patch.matchType } : {}),
              ...(patch.pattern !== undefined ? { pattern: patch.pattern } : {}),
              ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
              ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
              updatedAt: new Date(),
            })
            .where(and(eq(cashRules.userId, userId), eq(cashRules.id, ruleId)))
            .returning();
        } else {
          [row] = await tx
            .select()
            .from(cashRules)
            .where(and(eq(cashRules.userId, userId), eq(cashRules.id, ruleId)))
            .limit(1);
        }
        if (!row) return null;

        if (patch.tagIds !== undefined) {
          const tagIds = [...new Set(patch.tagIds)];
          await tx.delete(cashRuleTags).where(eq(cashRuleTags.ruleId, ruleId));
          if (tagIds.length > 0) {
            await tx
              .insert(cashRuleTags)
              .values(tagIds.map((tagId) => ({ ruleId, tagId })))
              .onConflictDoNothing({ target: [cashRuleTags.ruleId, cashRuleTags.tagId] });
          }
          return toRule(row, tagIds);
        }

        // On `tx`, not `db`: the tag set this patch left untouched is read
        // inside the same transaction that just wrote the rule's fields.
        const held = await tagIdsForRules(tx as unknown as Database, userId, [ruleId]);
        return toRule(row, held.get(ruleId) ?? []);
      });
    },

    async delete(userId: string, ruleId: string): Promise<boolean> {
      const deleted = await db
        .delete(cashRules)
        .where(and(eq(cashRules.userId, userId), eq(cashRules.id, ruleId)))
        .returning({ id: cashRules.id });
      return deleted.length > 0;
    },

    /**
     * Run the owner's rules over the movements they ALREADY have — the
     * back-catalogue half of auto-tagging, behind an explicit request.
     *
     * The work itself lives in `cashRuleTagStamp`, shared verbatim with the
     * book-time path, so "what a rule does to a movement" is decided once and
     * cannot drift between the two. Additive: it attaches tags and never
     * removes one.
     */
    async applyToExistingMovements(userId: string): Promise<number> {
      return applyCashRulesForOwner(db, userId);
    },
  };
}

export type CashRuleRepository = ReturnType<typeof createCashRuleRepository>;

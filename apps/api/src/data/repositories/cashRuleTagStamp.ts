import { sql } from 'drizzle-orm';

import type { CashRuleMatchType } from '@bettertrack/contracts';

import { tagsByRules } from '../../services/cash/cashRuleEngine';

/**
 * AUTO-TAGGING BY THE USER'S OWN RULES — the half of `cashRuleEngine` that was
 * missing (owner decision, 2026-07-30).
 *
 * Phase 2 shipped both ends of this and never joined them: `tagsByRules()` was
 * pure, unit-tested and called from nowhere, and `attachTagWithinPortfolio()`
 * was documented as "the auto-tagging path" with no caller either. So the Rules
 * page stored rules that could not affect a single movement, while its own
 * subtitle promised "Rules tag imports and manual entries automatically". This
 * file is the join.
 *
 * ── WHERE IT RUNS ──
 *
 * Two callers, one function, deliberately:
 *
 *   1. **At book time**, from `stampMovementTags` — the same three INSERT paths
 *      that stamp the app-owned tag, so a new booking site gets rule tagging by
 *      construction rather than by somebody remembering (see the argument in
 *      `cashSystemTagStamp.ts`, which this follows exactly).
 *   2. **On demand**, from `POST /cash/rules/apply` — because a rule is usually
 *      written AFTER the movements it describes. Book-time-only tagging can
 *      never reach a back catalogue, and a back catalogue is precisely what an
 *      imported statement is.
 *
 * Both go through `applyCashRuleTags`, so "what a rule does to a movement" is
 * decided in one place and cannot drift between the live path and the re-run.
 *
 * ── ONLY MOVEMENTS THAT CARRY A NOTE ──
 *
 * A rule matches a note; a movement with no note has nothing to match, and the
 * engine would return an empty set for it anyway. Skipping them early keeps the
 * hot path — booking a trade, which normally has no note — free of the rules
 * query entirely.
 *
 * ── ADDITIVE, NEVER SUBTRACTIVE ──
 *
 * Like system stamping: this attaches tags and never removes one, and
 * `UNIQUE(movement_id, tag_id)` makes a replay a no-op. A user's hand-set tags
 * always survive. The one visible consequence is that re-running rules can
 * restore a rule-assigned tag the user had removed by hand — which is the
 * honest meaning of pressing a button labelled "apply my rules now", and why
 * the re-run is explicit rather than automatic.
 *
 * ── NEVER THROWS AT BOOK TIME ──
 *
 * Inherited from `stampSystemTags` and for the same reason: booking the money
 * is what the caller came for. A labelling failure must not roll back a
 * recorded trade. The on-demand path is different — there the labelling IS the
 * request, so its errors surface.
 */

/** Minimal executor: `Database` or a drizzle transaction both satisfy it. */
export interface RuleTagStampExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/** A movement the rules may match — the note is the whole input. */
export interface RuleTaggableMovement {
  id: string;
  note: string | null;
}

/**
 * A rule in evaluation order, shaped for `tagsByRules`. Structurally a
 * `CashRuleRecord` minus the fields the engine never reads (`userId`, the
 * timestamps), so the loader below does not have to invent them.
 */
export interface EvaluationRule {
  id: string;
  matchType: CashRuleMatchType;
  pattern: string;
  priority: number;
  enabled: boolean;
  tagIds: string[];
}

/** `db.execute` hands back `{ rows }` on some drivers and a bare array on others. */
function resultRows(result: unknown): unknown[] {
  const rows = (result as { rows?: unknown[] }).rows ?? result;
  return Array.isArray(rows) ? rows : [];
}

/**
 * How many (movement, tag) pairs go into one INSERT. A statement per pair would
 * be one round trip per label on a re-run over a whole ledger; an unbounded
 * VALUES list would build a single statement of arbitrary size. This is the
 * usual middle.
 */
const LINK_CHUNK = 500;

/**
 * The ENABLED rules of one owner, already in evaluation order.
 *
 * `owner` is a scalar SQL expression yielding the user id, so the two callers
 * can name their owner the way they actually know them — the book-time path
 * has a portfolio, the re-run has a user — without either one taking a user id
 * from a caller it would then have to re-check. Both spellings appear directly
 * below; nothing else builds one.
 *
 * Ordering is `priority`, then age, then id — the identical tie-break chain
 * `cashRuleRepository.listForOwner` uses, because the engine walks whatever
 * order it is given and stops at the first match. Two rules of equal priority
 * evaluating in whatever order Postgres happened to return them would tag the
 * same note differently between two requests.
 *
 * Rules with no tags are dropped by the INNER JOIN rather than by the engine:
 * they can never assign anything, and carrying them only makes the first-match
 * walk longer.
 */
async function loadRules(
  executor: RuleTagStampExecutor,
  owner: ReturnType<typeof sql>,
): Promise<EvaluationRule[]> {
  const result = await executor.execute(sql`
    SELECT
      r."id",
      r."match_type" AS "matchType",
      r."pattern",
      r."priority",
      r."enabled",
      array_agg(rt."tag_id"::text) AS "tagIds"
    FROM "cash_rules" r
    JOIN "cash_rule_tags" rt ON rt."rule_id" = r."id"
    -- The tag must still belong to the same owner; a link row pointing anywhere
    -- else could not produce a legal cash_movement_tags row downstream.
    JOIN "cash_tags" t ON t."id" = rt."tag_id" AND t."user_id" = r."user_id"
    WHERE r."enabled" = true AND r."user_id" = ${owner}
    GROUP BY r."id", r."match_type", r."pattern", r."priority", r."enabled", r."created_at"
    ORDER BY r."priority" ASC, r."created_at" ASC, r."id" ASC
  `);
  return resultRows(result).map((row) => {
    const record = row as {
      id: string;
      matchType: CashRuleMatchType;
      pattern: string;
      priority: number | string;
      enabled: boolean;
      tagIds: string[];
    };
    return {
      id: record.id,
      matchType: record.matchType,
      pattern: record.pattern,
      priority: Number(record.priority),
      enabled: record.enabled,
      tagIds: record.tagIds,
    };
  });
}

/**
 * The rules of whoever owns `portfolioId`. The owner is resolved FROM THE
 * PORTFOLIO, never from an argument, so there is no input to this path that
 * could load another account's rules.
 */
export async function loadCashRulesForPortfolioOwner(
  executor: RuleTagStampExecutor,
  portfolioId: string,
): Promise<EvaluationRule[]> {
  return loadRules(
    executor,
    sql`(SELECT "user_id" FROM "portfolios" WHERE "id" = ${portfolioId} AND "vault_id" IS NULL)`,
  );
}

/**
 * Link the (movement, tag) pairs the rules produced.
 *
 * THE OWNERSHIP INVARIANT, IN SQL — the same one `cashSystemTagStamp` states: a
 * `cash_movement_tags` row is only legal when the tag's `user_id` equals the
 * movement's `portfolio.user_id`, and no foreign key can express that. The
 * statement resolves BOTH sides through `portfolioId` — the movement must be in
 * that portfolio and the tag must belong to that portfolio's owner — so a pair
 * that would cross accounts inserts nothing instead of inserting wrongly.
 *
 * Returns the number of movements that gained at least one tag, which is what a
 * user means by "23 movements tagged" (a movement picking up three tags is one
 * movement, not three).
 */
async function linkRuleTags(
  executor: RuleTagStampExecutor,
  portfolioId: string,
  pairs: readonly (readonly [movementId: string, tagId: string])[],
): Promise<number> {
  const touched = new Set<string>();
  for (let i = 0; i < pairs.length; i += LINK_CHUNK) {
    const chunk = pairs.slice(i, i + LINK_CHUNK);
    const values = chunk.map(([movementId, tagId]) => sql`(${movementId}::uuid, ${tagId}::uuid)`);
    const result = await executor.execute(sql`
      INSERT INTO "cash_movement_tags" ("id", "movement_id", "tag_id")
      SELECT gen_random_uuid(), v."movement_id", t."id"
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v("movement_id", "tag_id")
      JOIN "portfolio_cash_movements" pm
        ON pm."id" = v."movement_id" AND pm."portfolio_id" = ${portfolioId}
      JOIN "portfolios" p ON p."id" = pm."portfolio_id" AND p."vault_id" IS NULL
      JOIN "cash_tags" t ON t."id" = v."tag_id" AND t."user_id" = p."user_id"
      ON CONFLICT ("movement_id", "tag_id") DO NOTHING
      RETURNING "movement_id"
    `);
    for (const row of resultRows(result)) {
      touched.add((row as { movement_id?: string; movementId?: string }).movement_id ?? '');
    }
  }
  touched.delete('');
  return touched.size;
}

/**
 * Run `rules` over `movements` and attach what matches.
 *
 * The engine decides WHICH tags (first match wins, its whole set, case
 * insensitively); this decides only that they get written and that they get
 * written safely. Returns the number of movements that gained a tag.
 */
export async function applyCashRuleTags(
  executor: RuleTagStampExecutor,
  portfolioId: string,
  movements: readonly RuleTaggableMovement[],
  rules: readonly EvaluationRule[],
): Promise<number> {
  if (rules.length === 0) return 0;
  const pairs: [string, string][] = [];
  for (const movement of movements) {
    const note = movement.note?.trim() ?? '';
    if (note === '') continue;
    for (const tagId of tagsByRules(note, rules)) pairs.push([movement.id, tagId]);
  }
  if (pairs.length === 0) return 0;
  return linkRuleTags(executor, portfolioId, pairs);
}

/**
 * Book-time entry point: load the owner's rules and apply them, or do nothing
 * at all when no movement in the batch carries a note.
 *
 * The early return matters — it is what keeps a plain buy or sell, which almost
 * never has a note, from paying for a rules query it could not have used.
 */
export async function applyCashRulesAtBookTime(
  executor: RuleTagStampExecutor,
  portfolioId: string,
  movements: readonly RuleTaggableMovement[],
): Promise<void> {
  if (!movements.some((movement) => (movement.note?.trim() ?? '') !== '')) return;
  const rules = await loadCashRulesForPortfolioOwner(executor, portfolioId);
  await applyCashRuleTags(executor, portfolioId, movements, rules);
}

/**
 * ON-DEMAND entry point: run the user's rules across every movement they own
 * that carries a note, in every portfolio they own. Returns how many movements
 * gained at least one tag.
 *
 * WHY THIS EXISTS AT ALL. A rule is normally written after the movements it
 * describes — you look at a month of statements and only then decide that
 * everything from that supermarket is groceries. Book-time tagging can by
 * definition never reach that back catalogue, so without this the feature only
 * ever works for a user who guessed their rules in advance.
 *
 * PER USER, NOT PER PORTFOLIO, because rules are per user: "the same merchant
 * means the same thing in every ledger I own" (`cashRuleRepository`). Tagging
 * one portfolio and leaving its sibling stale would contradict that.
 *
 * NOT CAPPED, and deliberately so. A cap here would silently leave part of a
 * ledger untagged while reporting a cheerful number, which is worse than the
 * cost it avoids: this reads two small columns at personal-finance scale, from
 * an explicit button press, not a hot path.
 */
export async function applyCashRulesForOwner(
  executor: RuleTagStampExecutor,
  userId: string,
): Promise<number> {
  const rules = await loadRules(executor, sql`${userId}::uuid`);
  if (rules.length === 0) return 0;

  const portfolioRows = resultRows(
    await executor.execute(
      sql`SELECT "id" FROM "portfolios" WHERE "user_id" = ${userId}::uuid AND "vault_id" IS NULL`,
    ),
  );

  let movementsTagged = 0;
  for (const portfolioRow of portfolioRows) {
    const portfolioId = (portfolioRow as { id: string }).id;
    // Only rows a rule could possibly match. `btrim` mirrors the engine's own
    // treatment of a whitespace-only note as no note at all.
    const movements = resultRows(
      await executor.execute(sql`
        SELECT "id", "note"
        FROM "portfolio_cash_movements"
        WHERE "portfolio_id" = ${portfolioId}::uuid
          AND "note" IS NOT NULL
          AND btrim("note") <> ''
      `),
    ) as RuleTaggableMovement[];
    movementsTagged += await applyCashRuleTags(executor, portfolioId, movements, rules);
  }
  return movementsTagged;
}

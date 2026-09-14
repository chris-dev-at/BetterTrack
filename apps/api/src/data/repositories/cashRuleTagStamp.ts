import { sql } from 'drizzle-orm';

import { CASH_MOVEMENT_NOTE_MAX, type CashRuleMatchType } from '@bettertrack/contracts';

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
 * How many movements one keyset page of the on-demand re-run reads.
 *
 * The scan used to have neither a LIMIT nor a cursor: it selected every noted
 * movement of every portfolio the user owns into one array and matched in JS,
 * so a long-lived ledger was materialized whole on a single request (#1743).
 * Paging keeps the resident set to one page regardless of ledger size, at one
 * round trip per page — the same bargain `LINK_CHUNK` already makes for writes.
 */
const SCAN_PAGE = 500;

/**
 * The most noted movements ONE press of "apply to existing" may read.
 *
 * This is a BACKSTOP, not a pager: it is far above any personal-finance ledger
 * (a decade of daily noted movements is ~3 600 rows), so a normal account never
 * meets it and always gets a complete pass. It exists so that one request's
 * cost has a ceiling at all — the endpoint is authenticated but freely
 * repeatable, and matching is `O(scanned notes × rules)`, with the rule count
 * now capped alongside it in `cashTagService`.
 *
 * NEWEST FIRST WITHIN EACH PORTFOLIO, and the budget is spent portfolio by
 * portfolio — NOT newest-first across the whole account. A global recency order
 * would need one sort over every portfolio's movements, which is the
 * materialize-the-ledger cost this bound exists to remove; the per-portfolio
 * walk rides the `(portfolio_id, executed_at)` index instead. The consequence
 * is real and the user-facing copy says it: when the bound bites, it is "the
 * most recent movements in each portfolio that was reached", and a portfolio
 * the walk never got to is untouched. Pressing again re-covers the same window —
 * the bound is not a cursor — which is why saying so honestly matters.
 */
export const CASH_RULE_APPLY_MOVEMENT_SCAN_MAX = 20_000;

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
 *
 * ── THE MATCHED STRING IS BOUNDED (#1743) ─────────────────────────────────
 *
 * Only the first `CASH_MOVEMENT_NOTE_MAX` characters of a note are handed to
 * the engine, because matching costs `O(note length × rules)` and this function
 * is the single door BOTH callers go through — book time and the on-demand
 * re-run — so bounding it here bounds every pass at once.
 *
 * It is not theoretical. Every HTTP cash write validates `note` against that
 * same ceiling (`cashEntryRequestSchema`), but the import apply path calls
 * `depositCash`/`withdrawCash` SERVICE-DIRECT with the raw CSV cell, and
 * `portfolio_cash_movements.note` is `text` — so a 5 MB memo can already be
 * sitting in the ledger, and the re-run reads whatever is stored. Clipping the
 * MATCHING INPUT here bounds the cost of both without touching what is stored.
 *
 * It also keeps import preview and import booking agreeing: `stagedRuleTags`
 * clips the same way before previewing, so a needle sitting past the ceiling is
 * untagged in BOTH — instead of previewing untagged and booking tagged, which
 * is precisely the drift `importService` documents its divergences to avoid.
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
    const note = (movement.note?.trim() ?? '').slice(0, CASH_MOVEMENT_NOTE_MAX);
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

/** What one on-demand re-run did, and whether it reached the whole ledger. */
export interface CashRuleApplyOutcome {
  /** Movements that gained at least one tag in this run. */
  movementsTagged: number;
  /**
   * `false` when {@link CASH_RULE_APPLY_MOVEMENT_SCAN_MAX} stopped the walk
   * while movements it had not read were still there — the pass covered the
   * newest movements of the portfolios it reached, and no more. A run that
   * lands exactly on the bound with nothing left is `true`: the walk proves
   * exhaustion by reading rather than inferring it from a spent budget.
   */
  complete: boolean;
}

/** One page of the keyset scan: the note to match, plus its cursor position. */
interface ScannedMovement extends RuleTaggableMovement {
  /**
   * `executed_at` rendered as TEXT by Postgres and handed straight back as the
   * next page's bound. Text, not a `Date`, because a driver that parses
   * timestamps into JS Dates truncates microseconds — and a cursor that is a
   * hair off either re-reads a page or silently skips a movement.
   */
  cursorExecutedAt: string;
}

/**
 * ON-DEMAND entry point: run the user's rules across the movements they own
 * that carry a note, in every portfolio they own. Returns how many movements
 * gained at least one tag, and whether the run reached the end of the ledger.
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
 * BOUNDED AND PAGED (#1743). It used to select every noted movement of every
 * portfolio into one array — the resident set grew with the ledger on a freely
 * repeatable request. Now each portfolio is walked by keyset page of
 * {@link SCAN_PAGE}, newest first, and the whole run stops at
 * {@link CASH_RULE_APPLY_MOVEMENT_SCAN_MAX} scanned movements. Memory is one
 * page of rows whatever the ledger holds — and one row is bounded too, because
 * `applyCashRuleTags` matches at most `CASH_MOVEMENT_NOTE_MAX` characters of a
 * note however long the stored text is. A run that hit the bound says so
 * instead of reporting a number that looks like a complete pass.
 *
 * The cursor is `(executed_at, id)`, matching the `ORDER BY` and the
 * `(portfolio_id, executed_at)` index, so a page is a range read rather than a
 * re-sort. `id` breaks ties: two movements booked in the same microsecond would
 * otherwise make the cursor ambiguous, which is how paging loses or repeats a
 * row.
 */
export async function applyCashRulesForOwner(
  executor: RuleTagStampExecutor,
  userId: string,
): Promise<CashRuleApplyOutcome> {
  const rules = await loadRules(executor, sql`${userId}::uuid`);
  if (rules.length === 0) return { movementsTagged: 0, complete: true };

  const portfolioRows = resultRows(
    await executor.execute(
      sql`SELECT "id" FROM "portfolios" WHERE "user_id" = ${userId}::uuid AND "vault_id" IS NULL`,
    ),
  );

  let movementsTagged = 0;
  let scanned = 0;
  for (const portfolioRow of portfolioRows) {
    const portfolioId = (portfolioRow as { id: string }).id;
    let cursor: { executedAt: string; id: string } | null = null;
    for (;;) {
      const remaining = CASH_RULE_APPLY_MOVEMENT_SCAN_MAX - scanned;
      // A SPENT BUDGET IS NOT THE SAME AS A CUT-SHORT LEDGER. The walk only
      // ever learns it is finished by reading a page and finding it short, so
      // stopping the moment the budget runs out would report a run that landed
      // exactly on the bound — 20 000 noted movements, or a last page that
      // happens to fill the remainder — as partial, to a user whose pass was in
      // fact complete. With nothing left to spend the loop therefore reads ONE
      // row: it is bought from the same index range read, it is never tagged,
      // and it answers the only question left. No row means this portfolio is
      // done and the walk moves on; a row means the bound really did bite.
      const probing = remaining <= 0;
      const limit = probing ? 1 : Math.min(SCAN_PAGE, remaining);
      const after =
        cursor === null
          ? sql``
          : sql`AND ("executed_at", "id") < (${cursor.executedAt}::timestamptz, ${cursor.id}::uuid)`;
      // Only rows a rule could possibly match. `btrim` mirrors the engine's own
      // treatment of a whitespace-only note as no note at all.
      const page = resultRows(
        await executor.execute(sql`
          SELECT "id", "note", "executed_at"::text AS "cursorExecutedAt"
          FROM "portfolio_cash_movements"
          WHERE "portfolio_id" = ${portfolioId}::uuid
            AND "note" IS NOT NULL
            AND btrim("note") <> ''
            ${after}
          ORDER BY "executed_at" DESC, "id" DESC
          LIMIT ${limit}
        `),
      ) as ScannedMovement[];
      if (page.length === 0) break;
      if (probing) return { movementsTagged, complete: false };
      scanned += page.length;
      movementsTagged += await applyCashRuleTags(executor, portfolioId, page, rules);
      const last = page[page.length - 1]!;
      cursor = { executedAt: last.cursorExecutedAt, id: last.id };
      // A short page is the end of this portfolio; a full one may not be.
      if (page.length < limit) break;
    }
  }
  return { movementsTagged, complete: true };
}

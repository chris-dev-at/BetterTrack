import { createHash } from 'node:crypto';

import { CASH_SYSTEM_TAGS, type CashSystemTagKey } from '@bettertrack/contracts';

/**
 * CATCH-UP CORE for the V5 cash fusion (migration `0076_cash_fusion`).
 *
 * Migration 0076 moved every `expense_*` row onto the portfolio cash ledger, but
 * it deliberately left the old tables in place and `/api/v1/expenses` writable —
 * so every row written through those routes AFTER the deploy is a fused-table
 * gap. This module is the pure, database-free half of the script that closes it:
 * it takes one owner's rows as data and returns the exact set of inserts, using
 * the SAME id-borrowing, name-collapsing, sign and merge rules 0076 used. The
 * SQL lives in `data/repositories/cashFusionCatchUpRepository.ts`; the CLI in
 * `scripts/catchUpCashFusion.ts`.
 *
 * IDEMPOTENT BY CONSTRUCTION, exactly like 0076: every inserted row's primary
 * key is either borrowed from its source row (movement = expense transaction id,
 * tag = category id, budget = budget id, fire = fire id, rule = rule id) or
 * derived deterministically from the owner ({@link fusionUuid}). A second run
 * plans nothing because it sees the first run's rows as already present, and even
 * a plan applied twice collides on the primary key and inserts nothing.
 *
 * ── WHAT IS IN SCOPE, AND WHY IT IS NOT SIMPLY "EVERYTHING MISSING" ──
 *
 * "Not yet migrated" is ambiguous for one specific shape: an expense row that
 * 0076 already migrated, whose fused counterpart was later DELETED (a user
 * deleting the Spending portfolio cascades its movements away). Re-inserting it
 * would resurrect data the user removed on purpose.
 *
 * The rows are told apart by time. `fusionAppliedAt` is read from
 * `__drizzle_migrations`, so a source row is genuinely NEW when its `created_at`
 * is after the migration ran, and PRE-EXISTING otherwise. The catch-up migrates
 * the new rows; a pre-existing row with no counterpart is reported as
 * `orphanedPreFusion` and left alone. That is the safe direction — the report
 * names the count so an operator can decide, and nothing is resurrected silently.
 *
 * ── WHAT IT WILL NOT OVERWRITE ──
 *
 * Tag links on a movement that ALREADY exists are only ever added when the
 * movement carries no tags at all. A fused movement whose tag set disagrees with
 * its old category is reported as `divergedTagLinks`, never rewritten: after
 * phase 2 both sides are writable, there is no timestamp to arbitrate between a
 * deliberate retag and a stale category, and destroying user intent is worse than
 * leaving a stale label visible in a report.
 */

// ── Deterministic id derivation (the SQL `bt_cash_fusion_uuid`, ported) ────────

/**
 * The TypeScript twin of migration 0076's `bt_cash_fusion_uuid(seed)`: md5 of a
 * namespaced seed with the version nibble forced to `5` and the variant nibble
 * forced into `8..b`, so the digest reads as a well-formed RFC-4122 UUID (the
 * contracts' `z.string().uuid()` rejects a raw md5 digest).
 *
 * It MUST agree with the SQL for every seed or the catch-up would mint a second
 * Spending portfolio beside the one 0076 created. `cashFusionCatchUp.test.ts`
 * pins that by running the original SQL function against this implementation.
 */
export function fusionUuid(seed: string): string {
  const digest = createHash('md5').update(seed, 'utf8').digest('hex');
  const chars = [...digest];
  // `overlay(md5(seed) placing '5' from 13 for 1)` — 1-indexed in SQL.
  chars[12] = '5';
  // `substr('89ab', (('x' || substr(md5(seed), 17, 1))::bit(4)::int % 4) + 1, 1)`:
  // the 17th hex digit of the ORIGINAL digest picks the variant nibble.
  chars[16] = '89ab'[Number.parseInt(digest[16]!, 16) % 4]!;
  const hex = chars.join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

const SEED_PREFIX = 'bettertrack:v5-cash-fusion:';

/** The id 0076 gave (or would have given) this owner's cash-only Spending portfolio. */
export function spendingPortfolioId(userId: string): string {
  return fusionUuid(`${SEED_PREFIX}spending-portfolio:${userId}`);
}

/** The id of that portfolio's `Main` cash source. */
export function spendingSourceId(userId: string): string {
  return fusionUuid(`${SEED_PREFIX}spending-main-source:${userId}`);
}

/** The id of one app-owned system tag for this owner. */
export function systemTagId(key: CashSystemTagKey, userId: string): string {
  return fusionUuid(`${SEED_PREFIX}system-tag:${key}:${userId}`);
}

/** How many `Spending`, `Spending 2`, … names 0076 was willing to try. */
export const SPENDING_NAME_ATTEMPTS = 64;

// ── Exact money ───────────────────────────────────────────────────────────────

/**
 * TWO SCALES, ONE COMPARISON UNIT. Numerics arrive from Postgres as decimal
 * STRINGS, and the two sides of this migration do not share a scale:
 * `expense_transactions.amount` is `numeric(20,2)` while
 * `portfolio_cash_movements.amount_eur` is `numeric(20,6)` — the ledger is
 * sub-cent capable. So the source side is read as exact CENTS (a sub-cent expense
 * amount cannot exist and would be a corrupt row worth failing on), and anything
 * read back off the ledger is read as integer MICROS, the ledger's own precision.
 *
 * Everything is integer arithmetic; no figure in this file is ever routed through
 * a binary float.
 */
export const MICROS_PER_CENT = 10_000;

/** Strict 2dp — for `expense_transactions.amount` and the amounts we write. */
export function parseCents(numericText: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(numericText.trim());
  if (!match) throw new Error(`Not a 2dp decimal: ${JSON.stringify(numericText)}`);
  const [, sign, whole, fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`Amount out of exact range: ${numericText}`);
  return sign === '-' ? -cents : cents;
}

/**
 * Up to 6dp — for `amount_eur` and any `sum()` over it. Nothing is rounded: a
 * value with more precision than the column can hold is an error, not a truncation.
 */
export function parseMicros(numericText: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(numericText.trim());
  if (!match) throw new Error(`Not a 6dp decimal: ${JSON.stringify(numericText)}`);
  const [, sign, whole, fraction = ''] = match;
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(micros)) throw new Error(`Amount out of exact range: ${numericText}`);
  return sign === '-' ? -micros : micros;
}

/** Integer cents back to the `numeric(20,2)` text a movement is written with. */
export function centsToNumericText(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const magnitude = Math.abs(cents);
  return `${sign}${Math.trunc(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}`;
}

// ── Source rows (what the repository hands the core) ──────────────────────────

export type ExpenseDirection = 'expense' | 'income';
export type ExpenseRuleMatch = 'contains' | 'equals' | 'starts_with' | 'regex';

export interface SourceCategory {
  id: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SourceTransaction {
  id: string;
  categoryId: string | null;
  direction: ExpenseDirection;
  /** Positive magnitude, `numeric(20,2)` text. */
  amount: string;
  currency: string;
  /** `YYYY-MM-DD`. */
  bookedOn: string;
  description: string;
  source: string;
  dedupHash: string | null;
  createdAt: Date;
}

export interface SourceBudget {
  id: string;
  categoryId: string;
  amount: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SourceFire {
  id: string;
  budgetId: string;
  periodKey: string;
  firedAt: Date;
}

export interface SourceRule {
  id: string;
  categoryId: string;
  matchType: ExpenseRuleMatch;
  pattern: string;
  priority: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A `cash_tags` row the owner already has (from 0076, the app, or a prior run). */
export interface ExistingTag {
  id: string;
  name: string;
  system: boolean;
  systemKey: string | null;
}

/** A fused movement already standing in a portfolio THIS owner owns. */
export interface ExistingMovement {
  id: string;
  /** Signed `numeric(20,2)` text, as stored. */
  amountEur: string;
  /** The tags it already carries — the ids, not a count, so "already correct" and
   *  "labelled with something else" can be told apart. */
  tagIds: readonly string[];
}

/**
 * One owner's complete picture: the five source tables, and every fused row that
 * could already cover them. `movements` is pre-filtered by the repository to ids
 * that appear in `transactions` AND sit in a portfolio this owner owns — the same
 * predicate 0076's verification block used, so a mis-scoped row can never be
 * mistaken for a successful migration.
 */
export interface OwnerSnapshot {
  userId: string;
  /** Names of every portfolio the owner has, for the free-name search. */
  portfolioNames: readonly string[];
  maxSortOrder: number;
  spendingPortfolioExists: boolean;
  spendingSourceExists: boolean;
  categories: readonly SourceCategory[];
  transactions: readonly SourceTransaction[];
  budgets: readonly SourceBudget[];
  fires: readonly SourceFire[];
  rules: readonly SourceRule[];
  existingTags: readonly ExistingTag[];
  existingMovements: readonly ExistingMovement[];
  /** Ids of `cash_budgets` rows the owner already has, with their (tag, period). */
  existingBudgets: readonly { id: string; tagId: string; periodKey: string | null }[];
  /** `(budgetId, periodKey)` pairs already marked as fired. */
  existingFires: readonly { budgetId: string; periodKey: string }[];
  existingRuleIds: readonly string[];
}

// ── Planned rows (what the core hands the repository) ─────────────────────────

export interface PlannedTag {
  id: string;
  name: string;
  color: string;
  system: boolean;
  systemKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlannedMovement {
  id: string;
  sourceId: string;
  kind: 'deposit' | 'withdrawal';
  /** Signed `numeric(20,2)` text — the authoritative figure. */
  amountEur: string;
  executedAt: Date;
  note: string;
  source: string;
  dedupHash: string | null;
  originalCurrency: string | null;
  createdAt: Date;
}

export interface PlannedBudget {
  id: string;
  tagId: string;
  periodKey: null;
  amount: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlannedRule {
  id: string;
  matchType: ExpenseRuleMatch;
  pattern: string;
  priority: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The reconciliation the apply step must prove INSIDE its transaction, mirroring
 * 0076's final `DO` block: after the inserts, the owner's in-scope expense rows
 * and the fused movements covering them must agree on both count and signed sum.
 */
export interface OwnerReconciliation {
  /** In-scope source rows: already migrated, plus everything this plan inserts. */
  expectedMovements: number;
  /** Signed cents those rows sum to. */
  expectedNetCents: number;
}

export interface OwnerPlan {
  userId: string;
  portfolioId: string;
  sourceId: string;
  createPortfolio: { id: string; name: string; sortOrder: number } | null;
  createSource: { id: string; name: string } | null;
  tags: PlannedTag[];
  movements: PlannedMovement[];
  movementTags: { movementId: string; tagId: string }[];
  budgets: PlannedBudget[];
  fires: SourceFire[];
  rules: PlannedRule[];
  ruleTags: { ruleId: string; tagId: string }[];
  reconciliation: OwnerReconciliation;
  /** Pre-fusion source rows with no fused counterpart — reported, never migrated. */
  orphanedPreFusion: number;
  /** Already-fused movements whose tag set disagrees with the old category. */
  divergedTagLinks: number;
  /**
   * Set when the owner cannot be planned at all (today: all
   * {@link SPENDING_NAME_ATTEMPTS} Spending names are taken). Nothing is applied.
   */
  blocked: string | null;
}

/** Whether the plan would write anything. */
export function planIsEmpty(plan: OwnerPlan): boolean {
  return (
    plan.createPortfolio === null &&
    plan.createSource === null &&
    plan.tags.length === 0 &&
    plan.movements.length === 0 &&
    plan.movementTags.length === 0 &&
    plan.budgets.length === 0 &&
    plan.fires.length === 0 &&
    plan.rules.length === 0 &&
    plan.ruleTags.length === 0
  );
}

// ── Planning ─────────────────────────────────────────────────────────────────

/** `MAIN_CASH_SOURCE_NAME`, restated here so the core imports no repository. */
const MAIN_SOURCE_NAME = 'Main';

/**
 * The first free name of `Spending`, `Spending 2`, … — 0076's own rule, needed
 * because `portfolios_user_name_unique` means a user may already own a portfolio
 * called "Spending".
 */
export function freeSpendingName(taken: readonly string[]): string | null {
  const used = new Set(taken);
  for (let index = 1; index <= SPENDING_NAME_ATTEMPTS; index += 1) {
    const candidate = index === 1 ? 'Spending' : `Spending ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Plan one owner's catch-up. Pure: no clock, no database, no randomness — every
 * id is borrowed or derived, so the same snapshot always yields the same plan and
 * a test can assert the money without a database.
 *
 * The two join tables (`cash_movement_tags`, `cash_rule_tags`) are planned as
 * `(movement, tag)` / `(rule, tag)` pairs rather than as rows: 0076 filled their
 * primary keys with `gen_random_uuid()` because it is their NATURAL unique key,
 * not their id, that makes them idempotent. The repository mints the ids.
 */
export function planOwnerCatchUp(snapshot: OwnerSnapshot, fusionAppliedAt: Date): OwnerPlan {
  const { userId } = snapshot;
  const portfolioId = spendingPortfolioId(userId);
  const sourceId = spendingSourceId(userId);

  // ── Tags ────────────────────────────────────────────────────────────────────
  // Names are unique per owner CASE-INSENSITIVELY, so the whole tag resolution
  // runs on lowered names. 0076 seeded the system tags first (bare ON CONFLICT
  // DO NOTHING, i.e. a name already in use means no seed), then gave each
  // remaining category a tag, then resolved EVERY category by lowered name.
  const tagsByLowerName = new Map<string, string>();
  const systemKeys = new Set<string>();
  for (const tag of snapshot.existingTags) {
    tagsByLowerName.set(tag.name.toLowerCase(), tag.id);
    if (tag.systemKey !== null) systemKeys.add(tag.systemKey);
  }

  const tags: PlannedTag[] = [];
  // The app-owned set, for anyone missing it. Migration 0076 seeded `FROM users`,
  // so ONLY accounts that existed when it ran were covered — every account
  // registered afterwards has none, which would leave auto-tagging with nowhere
  // to land. This is the backfill for those, and it is why the catch-up's owner
  // list is not just "users with expense rows".
  //
  // `createdAt` is the migration instant on purpose: `fusionAppliedAt` is derived
  // from `min(created_at)` over system tags, so seeding at that same value keeps
  // the signal stable across runs instead of dragging it forward.
  for (const seed of CASH_SYSTEM_TAGS) {
    if (systemKeys.has(seed.key)) continue;
    const id = systemTagId(seed.key, userId);
    // A NAME COLLISION MUST NOT LEAVE A GAP. 0076 used a bare ON CONFLICT DO
    // NOTHING, so a user who already owned a tag called "Fees" got no `fees`
    // system tag at all and auto-tagging for that kind would silently do nothing
    // forever. A system tag's identity is its `systemKey`, not its name, so the
    // name is disambiguated rather than the tag skipped; the user may rename it
    // afterwards without breaking assignment.
    const taken = tagsByLowerName.has(seed.name.toLowerCase());
    const name = taken ? `${seed.name} (built-in)` : seed.name;
    // Both names taken is genuinely unresolvable; skip rather than loop.
    if (taken && tagsByLowerName.has(name.toLowerCase())) continue;
    tags.push({
      id,
      name,
      color: seed.color,
      system: true,
      systemKey: seed.key,
      createdAt: fusionAppliedAt,
      updatedAt: fusionAppliedAt,
    });
    tagsByLowerName.set(name.toLowerCase(), id);
    systemKeys.add(seed.key);
  }

  // Categories → user tags, id borrowed. 0076's `DISTINCT ON (user, lower(name))
  // ORDER BY created_at, id` picks one winner per lowered name; the losers get no
  // tag of their own and resolve onto the winner below.
  const orderedCategories = [...snapshot.categories].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : 1),
  );
  for (const category of orderedCategories) {
    const lower = category.name.toLowerCase();
    if (tagsByLowerName.has(lower)) continue;
    tags.push({
      id: category.id,
      name: category.name,
      color: category.color,
      system: false,
      systemKey: null,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt,
    });
    tagsByLowerName.set(lower, category.id);
  }

  // Total and single-valued: every category's lowered name now has exactly one tag.
  const tagForCategory = new Map<string, string>();
  for (const category of snapshot.categories) {
    const tagId = tagsByLowerName.get(category.name.toLowerCase());
    if (tagId !== undefined) tagForCategory.set(category.id, tagId);
  }

  // ── Movements ───────────────────────────────────────────────────────────────
  const migratedById = new Map(snapshot.existingMovements.map((row) => [row.id, row]));
  const movements: PlannedMovement[] = [];
  const movementTags: { movementId: string; tagId: string }[] = [];
  let orphanedPreFusion = 0;
  let divergedTagLinks = 0;
  let expectedMovements = 0;
  let expectedNetCents = 0;

  for (const row of snapshot.transactions) {
    // SIGN CONVENTION (0076 §7): a positive magnitude plus a direction becomes a
    // signed amount whose sign must match its kind. `portfolio_cash_movements_sign`
    // is the backstop — a flipped sign aborts the transaction rather than
    // committing money that does not reconcile.
    const magnitude = parseCents(row.amount);
    const signedCents = row.direction === 'income' ? magnitude : -magnitude;
    const already = migratedById.get(row.id);

    if (already !== undefined) {
      expectedMovements += 1;
      expectedNetCents += signedCents;
      const tagId = row.categoryId === null ? undefined : tagForCategory.get(row.categoryId);
      if (tagId !== undefined && !already.tagIds.includes(tagId)) {
        // Purely additive repair: an UNTAGGED fused movement whose expense row
        // gained a category after the fusion gets the label — there is nothing to
        // clobber. A movement already labelled with something else may be carrying
        // a deliberate retag, and there is no timestamp to arbitrate, so it is
        // counted for the report and left exactly as it is.
        if (already.tagIds.length === 0) movementTags.push({ movementId: row.id, tagId });
        else divergedTagLinks += 1;
      }
      continue;
    }

    if (row.createdAt.getTime() <= fusionAppliedAt.getTime()) {
      // Migrated by 0076 and since deleted — left alone on purpose.
      orphanedPreFusion += 1;
      continue;
    }

    movements.push({
      id: row.id,
      sourceId,
      kind: row.direction === 'income' ? 'deposit' : 'withdrawal',
      amountEur: centsToNumericText(signedCents),
      // `booked_on` (a date) → an instant at UTC MIDNIGHT: the only instant that
      // buckets onto the same day under both the UTC daily series and the
      // Europe/Vienna tax calendar (0076 §7).
      executedAt: new Date(`${row.bookedOn}T00:00:00.000Z`),
      note: row.description,
      source: row.source,
      dedupHash: row.dedupHash,
      // The expense area was currency-naive by design; a non-EUR magnitude is
      // carried over 1:1 (reproducing the number the user has always been shown)
      // and its currency recorded so a later FX pass can find it. No historical
      // rate is invented here.
      originalCurrency: row.currency.toUpperCase() === 'EUR' ? null : row.currency.toUpperCase(),
      createdAt: row.createdAt,
    });
    expectedMovements += 1;
    expectedNetCents += signedCents;

    const tagId = row.categoryId === null ? undefined : tagForCategory.get(row.categoryId);
    // A NULL category stays untagged — exactly the "uncategorized" state it had.
    if (tagId !== undefined) movementTags.push({ movementId: row.id, tagId });
  }

  // ── Budgets ─────────────────────────────────────────────────────────────────
  // 0076 mapped every budget to the RECURRING slot (`period_key` NULL), which is
  // exactly what `expense_budgets` was. Two case-colliding categories merging
  // into one tag collapse their budgets: the LARGEST amount wins, because a
  // budget is a ceiling and merging two labels must not tighten what was set.
  const recurringTaken = new Set(
    snapshot.existingBudgets.filter((row) => row.periodKey === null).map((row) => row.tagId),
  );
  const existingBudgetIds = new Set(snapshot.existingBudgets.map((row) => row.id));
  const budgetCandidates = [...snapshot.budgets]
    .filter((row) => !existingBudgetIds.has(row.id))
    .filter((row) => row.createdAt.getTime() > fusionAppliedAt.getTime())
    .sort(
      (left, right) =>
        parseCents(right.amount) - parseCents(left.amount) ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        (left.id < right.id ? -1 : 1),
    );

  const budgets: PlannedBudget[] = [];
  const budgetIdForCategory = new Map<string, string>();
  for (const row of budgetCandidates) {
    const tagId = tagForCategory.get(row.categoryId);
    if (tagId === undefined) continue;
    if (recurringTaken.has(tagId)) continue;
    recurringTaken.add(tagId);
    budgets.push({
      id: row.id,
      tagId,
      periodKey: null,
      amount: row.amount,
      currency: row.currency,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    budgetIdForCategory.set(row.id, row.id);
  }

  // ── Fires ───────────────────────────────────────────────────────────────────
  // Without these, re-pointing the notification path at `cash_budget_fires`
  // would re-alert every month that has already fired. A fire is carried only
  // when its budget landed (in this plan or an earlier one) under the SAME id.
  const landedBudgetIds = new Set<string>([...existingBudgetIds, ...budgetIdForCategory.keys()]);
  const firedAlready = new Set(
    snapshot.existingFires.map((row) => `${row.budgetId} ${row.periodKey}`),
  );
  const fires = snapshot.fires.filter(
    (row) =>
      landedBudgetIds.has(row.budgetId) && !firedAlready.has(`${row.budgetId} ${row.periodKey}`),
  );

  // ── Rules ───────────────────────────────────────────────────────────────────
  // User-scoped, so they carry over for an owner with no Spending portfolio too.
  // First-match-by-priority semantics are unchanged; the join table is what lets
  // a rule assign several tags from here on.
  const existingRuleIds = new Set(snapshot.existingRuleIds);
  const rules: PlannedRule[] = [];
  const ruleTags: { ruleId: string; tagId: string }[] = [];
  for (const row of snapshot.rules) {
    if (existingRuleIds.has(row.id)) continue;
    if (row.createdAt.getTime() <= fusionAppliedAt.getTime()) continue;
    rules.push({
      id: row.id,
      matchType: row.matchType,
      pattern: row.pattern,
      priority: row.priority,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    const tagId = tagForCategory.get(row.categoryId);
    if (tagId !== undefined) ruleTags.push({ ruleId: row.id, tagId });
  }

  // ── Portfolio + source ──────────────────────────────────────────────────────
  // Needed only when something has to live in it. Rules and tags are user-scoped.
  const needsPortfolio = movements.length > 0 || budgets.length > 0;
  let createPortfolio: OwnerPlan['createPortfolio'] = null;
  let blocked: string | null = null;
  if (needsPortfolio && !snapshot.spendingPortfolioExists) {
    const name = freeSpendingName(snapshot.portfolioNames);
    if (name === null) {
      blocked = `all ${SPENDING_NAME_ATTEMPTS} Spending names are taken`;
    } else {
      // Sorted last so it does not displace the owner's existing portfolios.
      createPortfolio = { id: portfolioId, name, sortOrder: snapshot.maxSortOrder + 1 };
    }
  }
  const createSource =
    needsPortfolio && !snapshot.spendingSourceExists
      ? { id: sourceId, name: MAIN_SOURCE_NAME }
      : null;

  const plan: OwnerPlan = {
    userId,
    portfolioId,
    sourceId,
    createPortfolio,
    createSource,
    tags,
    movements,
    movementTags,
    budgets,
    fires,
    rules,
    ruleTags,
    reconciliation: { expectedMovements, expectedNetCents },
    orphanedPreFusion,
    divergedTagLinks,
    blocked,
  };

  if (blocked !== null) {
    // Nothing may be written for a blocked owner — inserting the tags and rules
    // while the movements stay behind would half-apply the plan and make the next
    // run's report harder to read than a clean "this owner needs a decision".
    return {
      ...plan,
      createPortfolio: null,
      createSource: null,
      tags: [],
      movements: [],
      movementTags: [],
      budgets: [],
      fires: [],
      rules: [],
      ruleTags: [],
    };
  }
  return plan;
}

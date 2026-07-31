import { z } from 'zod';

import { currencyCodeSchema } from './market';
import { MAX_CASH_AMOUNT_EUR } from './portfolio';

/**
 * CASH FLOW — the classification layer on the portfolio cash ledger (V5 cash
 * fusion, migration 0075). It replaces the user-scoped `expense_*` island
 * (`./expenses`, still served by `/api/v1/expenses` until a later phase
 * re-points the routes) and it is deliberately NOT a rename of it:
 *
 *  - **Everything lives in a portfolio.** There is no global user-level cash.
 *    Money is `portfolio_cash_movements`; this module only labels, budgets and
 *    auto-tags those rows.
 *  - **Tags, not categories.** A movement carries MANY tags and tags do NOT
 *    nest: "Food" and "Groceries" are two flat labels on one row, and a budget
 *    on Food counts every row carrying Food whatever else it carries. That is
 *    why a movement's tags are a SET, not a `categoryId`.
 *  - **Tags are per user, budgets are per portfolio.** A tag is a reusable
 *    label, defined once per account and usable in any of that account's
 *    portfolios; a budget is money, so it belongs to the portfolio whose ledger
 *    it measures. Cross-portfolio budgets arrive later with portfolio nesting.
 *  - **System tags are app-owned**, like a movement's `source` tag: the engine
 *    assigns them from the movement's `kind`, they are addressed by a stable
 *    `systemKey` (never by name), and they cannot be deleted.
 *
 * Phase 1 ships these shapes plus the schema and the data migration; the
 * endpoints and the UI land in the phases after it.
 */

// --- Shared vocabulary -------------------------------------------------------

/**
 * How a rule matches a movement's note. Same four operators `expense_rules`
 * had — `contains` / `equals` / `starts_with` are literal and
 * case-insensitive, `regex` is a regular expression.
 */
export const CASH_RULE_MATCH_TYPES = ['contains', 'equals', 'starts_with', 'regex'] as const;
export const cashRuleMatchTypeSchema = z.enum(CASH_RULE_MATCH_TYPES);
export type CashRuleMatchType = z.infer<typeof cashRuleMatchTypeSchema>;

/**
 * The stable keys of the app-owned tags. The engine resolves a system tag by its
 * key, never by its (renameable, translatable) name.
 *
 * They cover the cash-movement kinds the ledger can post — `investment` (a
 * `buy`), `sale_proceeds` (a `sell_proceeds`), `dividend`, `tax` (both
 * `tax_withholding` and `tax_refund`), `transfer` (both legs, which cancel),
 * `fees` (a `fee`, V5 §16 2026-07-30 — the kind that made this key a real
 * mapping rather than a placeholder), and plain `deposit` / `withdrawal` for
 * external flows — plus `interest`, which no kind produces yet but every bank
 * statement does. It stays seeded so an imported bank-interest row has a home
 * from day one instead of being back-filled into history later; owner decision
 * 2026-07-30 deliberately DEFERRED reclassifying interest into its own kind.
 *
 * The kind → system-tag engine that assigns these lives in
 * `apps/api/src/services/cash/cashAutoTag.ts`, stamped from the movement INSERT
 * paths; a booked `fee` carries `fees` automatically (V5 §16 2026-07-30). The
 * user's OWN rules run from the same seam and are previewable while typing
 * (`POST /cash/rules/preview`).
 */
export const CASH_SYSTEM_TAG_KEYS = [
  'investment',
  'sale_proceeds',
  'dividend',
  'interest',
  'fees',
  'tax',
  'transfer',
  'deposit',
  'withdrawal',
] as const;
export const cashSystemTagKeySchema = z.enum(CASH_SYSTEM_TAG_KEYS);
export type CashSystemTagKey = z.infer<typeof cashSystemTagKeySchema>;

/**
 * The seed set, verbatim: key → default name + tint. Migration 0075 seeds
 * exactly these for every existing user and the tag service seeds them for every
 * new one, so this array is the single source of truth for both (a test asserts
 * the migration SQL still names every key).
 */
export const CASH_SYSTEM_TAGS: readonly {
  readonly key: CashSystemTagKey;
  readonly name: string;
  readonly color: string;
}[] = [
  { key: 'investment', name: 'Investment', color: '#6366f1' },
  { key: 'sale_proceeds', name: 'Sale proceeds', color: '#8b5cf6' },
  { key: 'dividend', name: 'Dividend income', color: '#10b981' },
  { key: 'interest', name: 'Interest', color: '#14b8a6' },
  { key: 'fees', name: 'Fees', color: '#f97316' },
  { key: 'tax', name: 'Tax', color: '#ef4444' },
  { key: 'transfer', name: 'Transfer', color: '#64748b' },
  { key: 'deposit', name: 'Deposit', color: '#22c55e' },
  { key: 'withdrawal', name: 'Withdrawal', color: '#eab308' },
];

/** Field caps (kept compact per the anti-bloat rule). */
export const CASH_TAG_NAME_MAX = 60;
export const CASH_RULE_PATTERN_MAX = 200;
/** How many tags one movement or one rule may carry — a label set, not a taxonomy. */
export const CASH_TAGS_PER_ITEM_MAX = 20;
/** Trailing-month window the trend endpoint will serve (same cap the expense trends had). */
export const CASH_TREND_MONTHS_MAX = 24;

/** A calendar month `YYYY-MM` — the budget period and the dashboard bucket. */
export const cashMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a YYYY-MM month.');

/** `#RRGGBB` hex tint used to colour a tag on the dashboards. */
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #RRGGBB hex colour.');

/** A positive, finite money magnitude within the ledger's representable range. */
const cashBudgetAmountSchema = z.number().positive().finite().max(MAX_CASH_AMOUNT_EUR);

/**
 * A set of tag ids. Bounded, and de-duplication is the server's job (the
 * `UNIQUE(movement, tag)` / `UNIQUE(rule, tag)` keys make a repeat a no-op), so
 * a client sending the same id twice is accepted, not rejected.
 */
const tagIdsSchema = z.array(z.string().uuid()).max(CASH_TAGS_PER_ITEM_MAX);

// --- Tags --------------------------------------------------------------------

/**
 * One flat tag as returned to its owner. `system` tags are app-owned: the engine
 * assigns them and delete is refused; `systemKey` is their stable identity and is
 * `null` on every user tag. Names are unique per owner CASE-INSENSITIVELY — two
 * tags a user cannot tell apart would silently split every budget counting them.
 */
export const cashTagSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    /** `#RRGGBB` tint, carried over from the categories these tags replace. */
    color: z.string(),
    system: z.boolean(),
    systemKey: cashSystemTagKeySchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CashTag = z.infer<typeof cashTagSchema>;

/** `GET /cash/tags` — the caller's tags, system tags included. */
export const cashTagListResponseSchema = z.object({ tags: z.array(cashTagSchema) }).strict();
export type CashTagListResponse = z.infer<typeof cashTagListResponseSchema>;

/** `POST /cash/tags` body. Colour optional — the server assigns one when omitted. */
export const createCashTagRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(CASH_TAG_NAME_MAX),
    color: hexColorSchema.optional(),
  })
  .strict();
export type CreateCashTagRequest = z.infer<typeof createCashTagRequestSchema>;

/**
 * `PATCH /cash/tags/:tagId` body — rename / re-tint. A system tag may be renamed
 * and re-tinted (it is addressed by `systemKey`), never deleted, and `system` /
 * `systemKey` are server-owned and not settable here.
 */
export const updateCashTagRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(CASH_TAG_NAME_MAX).optional(),
    color: hexColorSchema.optional(),
  })
  .strict();
export type UpdateCashTagRequest = z.infer<typeof updateCashTagRequestSchema>;

/** `POST` / `PATCH` tag response. */
export const cashTagResponseSchema = z.object({ tag: cashTagSchema }).strict();
export type CashTagResponse = z.infer<typeof cashTagResponseSchema>;

/** Route param for the single-tag endpoints. */
export const cashTagIdParamSchema = z.object({ tagId: z.string().uuid() }).strict();
export type CashTagIdParam = z.infer<typeof cashTagIdParamSchema>;

// --- Movement tags -----------------------------------------------------------

/**
 * `PUT /cash/movements/:movementId/tags` body — the movement's tag set, replaced
 * wholesale. An empty array clears every tag (the "uncategorized" state a
 * `NULL` category used to mean). Whole-set replacement rather than add/remove
 * deltas keeps the client's view and the stored set convergent without a
 * per-tag round trip.
 *
 * Every id must be a tag the CALLER owns and the movement must sit in a
 * portfolio the CALLER owns — no foreign key can express that (tags reach users
 * directly, movements only through portfolios), so the repository enforces both
 * sides and a mismatch is a not-found, never a partial write.
 */
export const setCashMovementTagsRequestSchema = z.object({ tagIds: tagIdsSchema }).strict();
export type SetCashMovementTagsRequest = z.infer<typeof setCashMovementTagsRequestSchema>;

/** The tag set now on a movement, after a replace. */
export const cashMovementTagsResponseSchema = z
  .object({ movementId: z.string().uuid(), tags: z.array(cashTagSchema) })
  .strict();
export type CashMovementTagsResponse = z.infer<typeof cashMovementTagsResponseSchema>;

/** Route param for the movement-tag endpoint. */
export const cashMovementIdParamSchema = z.object({ movementId: z.string().uuid() }).strict();
export type CashMovementIdParam = z.infer<typeof cashMovementIdParamSchema>;

// --- Budgets -----------------------------------------------------------------

/**
 * One budget: a spend target for one tag inside one portfolio.
 *
 * `period` is the whole design. `null` = the RECURRING monthly target, which is
 * exactly what `expense_budgets` was (no period column at all; one row per
 * category, re-evaluated every month). `'YYYY-MM'` = a single-month override.
 * That nullability is what let the migration carry the old rows over without
 * inventing a month they never had.
 */
export const cashBudgetSchema = z
  .object({
    id: z.string().uuid(),
    portfolioId: z.string().uuid(),
    tagId: z.string().uuid(),
    /** `null` = recurring every month; `YYYY-MM` = that month only. */
    period: z.string().nullable(),
    amount: z.number(),
    currency: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CashBudget = z.infer<typeof cashBudgetSchema>;

/**
 * A budget with its evaluated progress for one month — what the budgets surface
 * lists. `spent` is the OUTFLOW magnitude of the period's movements carrying the
 * tag; `exceeded` is `spent > amount`, the exact condition that claims a
 * `cash_budget_fires` row and fires the alert once per period.
 */
export const cashBudgetProgressSchema = z
  .object({
    id: z.string().uuid(),
    portfolioId: z.string().uuid(),
    tagId: z.string().uuid(),
    /** Tag snapshot for the row (a budget always targets a live tag). */
    tagName: z.string(),
    tagColor: z.string(),
    amount: z.number(),
    currency: z.string(),
    /** The month this row was evaluated for (`YYYY-MM`), never null. */
    period: z.string(),
    /** Whether the target came from a month-specific row or the recurring one. */
    recurring: z.boolean(),
    spent: z.number(),
    /** `amount - spent` (negative once over budget). */
    remaining: z.number(),
    exceeded: z.boolean(),
  })
  .strict();
export type CashBudgetProgress = z.infer<typeof cashBudgetProgressSchema>;

/** `GET /cash/budgets?portfolioId=&month=` query — omitted month ⇒ this month. */
export const cashBudgetListQuerySchema = z
  .object({
    portfolioId: z.string().uuid(),
    month: cashMonthSchema.optional(),
  })
  .strict();
export type CashBudgetListQuery = z.infer<typeof cashBudgetListQuerySchema>;

/** `GET /cash/budgets` response — the portfolio's budgets with this month's progress. */
export const cashBudgetListResponseSchema = z
  .object({ period: z.string(), budgets: z.array(cashBudgetProgressSchema) })
  .strict();
export type CashBudgetListResponse = z.infer<typeof cashBudgetListResponseSchema>;

/**
 * `POST /cash/budgets` body. One budget per (portfolio, tag, period) — a second
 * create for the same triple is a 409. `period` omitted / `null` creates the
 * recurring monthly target.
 */
export const createCashBudgetRequestSchema = z
  .object({
    portfolioId: z.string().uuid(),
    tagId: z.string().uuid(),
    period: cashMonthSchema.nullish(),
    amount: cashBudgetAmountSchema,
    currency: currencyCodeSchema.default('EUR'),
  })
  .strict();
export type CreateCashBudgetRequest = z.infer<typeof createCashBudgetRequestSchema>;

/**
 * `PATCH /cash/budgets/:budgetId` body — retarget the amount (and optionally the
 * currency). Portfolio, tag and period are fixed at creation (move = delete +
 * create), so a budget can never drift onto another ledger or another month.
 */
export const updateCashBudgetRequestSchema = z
  .object({
    amount: cashBudgetAmountSchema.optional(),
    currency: currencyCodeSchema.optional(),
  })
  .strict();
export type UpdateCashBudgetRequest = z.infer<typeof updateCashBudgetRequestSchema>;

/** `POST` / `PATCH` budget response. */
export const cashBudgetResponseSchema = z.object({ budget: cashBudgetSchema }).strict();
export type CashBudgetResponse = z.infer<typeof cashBudgetResponseSchema>;

/** Route param for the single-budget endpoints. */
export const cashBudgetIdParamSchema = z.object({ budgetId: z.string().uuid() }).strict();
export type CashBudgetIdParam = z.infer<typeof cashBudgetIdParamSchema>;

// --- Rules -------------------------------------------------------------------

/**
 * One auto-tagging rule. A rule tests a movement's note and, on a match, applies
 * ALL of `tagIds` at once ("REWE → Food + Groceries").
 *
 * FIRST MATCH WINS, unchanged from `expense_rules`: rules run in ascending
 * `priority` and the first match applies its tag set and stops. Unioning every
 * matching rule was considered and rejected — then no single rule "wins", the
 * user cannot explain or undo a result, and `priority` becomes decorative.
 * Multiple tags per rule already covers the real case.
 *
 * Rules are per user, like the tags they assign: the same merchant means the
 * same thing in every ledger the user owns.
 */
export const cashRuleSchema = z
  .object({
    id: z.string().uuid(),
    /** The tags a matching movement receives (at least one). */
    tagIds: z.array(z.string().uuid()),
    matchType: cashRuleMatchTypeSchema,
    pattern: z.string(),
    /** Evaluation order — lower runs first; the first match wins. */
    priority: z.number().int(),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CashRule = z.infer<typeof cashRuleSchema>;

/** `GET /cash/rules` response — by ascending priority then age. */
export const cashRuleListResponseSchema = z.object({ rules: z.array(cashRuleSchema) }).strict();
export type CashRuleListResponse = z.infer<typeof cashRuleListResponseSchema>;

/** `POST /cash/rules` body. A rule with no tag could never do anything, so ≥1. */
export const createCashRuleRequestSchema = z
  .object({
    tagIds: tagIdsSchema.min(1),
    matchType: cashRuleMatchTypeSchema.default('contains'),
    pattern: z.string().trim().min(1).max(CASH_RULE_PATTERN_MAX),
    priority: z.number().int().min(0).max(10_000).default(0),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateCashRuleRequest = z.infer<typeof createCashRuleRequestSchema>;

/** `PATCH /cash/rules/:ruleId` body — every field optional; `tagIds` replaces the set. */
export const updateCashRuleRequestSchema = z
  .object({
    tagIds: tagIdsSchema.min(1).optional(),
    matchType: cashRuleMatchTypeSchema.optional(),
    pattern: z.string().trim().min(1).max(CASH_RULE_PATTERN_MAX).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateCashRuleRequest = z.infer<typeof updateCashRuleRequestSchema>;

/** `POST` / `PATCH` rule response. */
export const cashRuleResponseSchema = z.object({ rule: cashRuleSchema }).strict();
export type CashRuleResponse = z.infer<typeof cashRuleResponseSchema>;

/** Route param for the single-rule endpoints. */
export const cashRuleIdParamSchema = z.object({ ruleId: z.string().uuid() }).strict();
export type CashRuleIdParam = z.infer<typeof cashRuleIdParamSchema>;

/**
 * `POST /cash/rules/apply` response — how many movements gained a tag.
 *
 * A MOVEMENT COUNT, NOT A LABEL COUNT: a movement that a three-tag rule matches
 * is one movement, not three, because "23 movements tagged" is what a person
 * pressing this means. It counts only what the run actually changed, so a
 * second press right after the first honestly reports 0 — the operation is
 * additive and idempotent, and saying "23" again would suggest work that did
 * not happen.
 */
export const cashRuleApplyResponseSchema = z
  .object({ movementsTagged: z.number().int().min(0) })
  .strict();
export type CashRuleApplyResponse = z.infer<typeof cashRuleApplyResponseSchema>;

/**
 * `POST /cash/rules/preview` — what the caller's rules WOULD tag this note as.
 *
 * Read-only, and it exists so the entry form can show the answer while you are
 * still typing. The alternative was re-implementing the matcher client-side,
 * which would have put "what a rule does" in two places — and the two would
 * disagree the first time somebody wrote a regex, since matching runs through
 * RE2 on the server precisely so a pathological pattern cannot stall anything.
 *
 * An empty note is a legal request answering `[]`, because a form with nothing
 * typed yet is the normal state, not an error.
 */
export const cashRulePreviewRequestSchema = z.object({ note: z.string().max(1000) }).strict();
export type CashRulePreviewRequest = z.infer<typeof cashRulePreviewRequestSchema>;

export const cashRulePreviewResponseSchema = z.object({ tagIds: z.array(z.string()) }).strict();
export type CashRulePreviewResponse = z.infer<typeof cashRulePreviewResponseSchema>;

// --- Summary + trends --------------------------------------------------------

/**
 * MULTI-TAG TOTALS DO NOT SUM. This is the one place where flat multi-tags change
 * a number's meaning versus the single-category world they replace, so it is
 * stated in the contract rather than left for a reader to discover.
 *
 * A movement carrying both `Food` and `Groceries` contributes its full magnitude
 * to BOTH tag rows, because "how much did I spend on Food" must not depend on
 * what else that row was labelled. So `sum(tags[].outflow)` is ≥ `totalOutflow`
 * and the two are equal only when no row carries two tags. `totalOutflow` /
 * `totalInflow` are the authoritative portfolio figures, computed once from the
 * movements themselves; the per-tag rows are a breakdown, never an addend.
 *
 * `tagId: null` is the untagged bucket — the "uncategorized" state a NULL
 * category used to mean. It is the one row that IS disjoint from every other.
 */
export const cashTagSummarySchema = z
  .object({
    /** `null` = the untagged bucket; its `name`/`color` are null and the UI labels it. */
    tagId: z.string().uuid().nullable(),
    name: z.string().nullable(),
    color: z.string().nullable(),
    /** Whether this row is an app-owned tag (false for the untagged bucket). */
    system: z.boolean(),
    /** Magnitude (positive) of the period's outflows carrying this tag. */
    outflow: z.number(),
    /** Magnitude (positive) of the period's inflows carrying this tag. */
    inflow: z.number(),
    /** How many of the period's movements carry this tag. */
    movements: z.number().int(),
  })
  .strict();
export type CashTagSummary = z.infer<typeof cashTagSummarySchema>;

/** `GET /cash/summary?portfolioId=&month=` query — omitted month ⇒ this month. */
export const cashSummaryQuerySchema = z
  .object({
    portfolioId: z.string().uuid(),
    month: cashMonthSchema.optional(),
  })
  .strict();
export type CashSummaryQuery = z.infer<typeof cashSummaryQuerySchema>;

/**
 * `GET /cash/summary` — one portfolio's month.
 *
 * `totalInflow` / `totalOutflow` are magnitudes over EVERY movement in the month
 * (tagged or not), so `net === totalInflow - totalOutflow` is the portfolio's
 * real cash delta for the month and reconciles to the ledger. See the note on
 * {@link cashTagSummarySchema} for why the `tags` rows do not add up to them.
 */
export const cashMonthlySummaryResponseSchema = z
  .object({
    portfolioId: z.string().uuid(),
    month: z.string(),
    totalInflow: z.number(),
    totalOutflow: z.number(),
    /** `totalInflow - totalOutflow`. */
    net: z.number(),
    /** Per-tag breakdown, outflow-heaviest first; the untagged bucket last. */
    tags: z.array(cashTagSummarySchema),
  })
  .strict();
export type CashMonthlySummaryResponse = z.infer<typeof cashMonthlySummaryResponseSchema>;

/** One month's inflow + outflow magnitude for the trend chart. */
export const cashTrendPointSchema = z
  .object({ month: z.string(), inflow: z.number(), outflow: z.number() })
  .strict();
export type CashTrendPoint = z.infer<typeof cashTrendPointSchema>;

/**
 * `GET /cash/trends?portfolioId=&months=` query. `portfolioId` is REQUIRED — the
 * fused ledger has a portfolio dimension, so an aggregate over "all cash" would
 * be a choice this endpoint should not make silently; a caller wanting several
 * portfolios asks for each and sums client-side (which is what the Home widget
 * does under the shared query keys).
 */
export const cashTrendQuerySchema = z
  .object({
    portfolioId: z.string().uuid(),
    months: z.coerce.number().int().positive().max(CASH_TREND_MONTHS_MAX).optional(),
  })
  .strict();
export type CashTrendQuery = z.infer<typeof cashTrendQuerySchema>;

/** `GET /cash/trends` — oldest→newest, one point per month in the window (gaps as zeros). */
export const cashTrendResponseSchema = z
  .object({ portfolioId: z.string().uuid(), points: z.array(cashTrendPointSchema) })
  .strict();
export type CashTrendResponse = z.infer<typeof cashTrendResponseSchema>;

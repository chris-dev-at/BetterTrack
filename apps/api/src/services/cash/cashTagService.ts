import {
  CASH_RULE_PATTERN_MAX,
  CASH_SYSTEM_TAGS,
  CASH_TAGS_PER_ITEM_MAX,
  CASH_TAGS_PER_USER_MAX,
  type CashMovementTagsResponse,
  type CashRule,
  type CashRuleListResponse,
  type CashRuleMatchType,
  type CashRuleApplyResponse,
  type CashRulePreviewResponse,
  type CashRuleResponse,
  type CashTag,
  type CashTagListResponse,
  type CashTagResponse,
  type CreateCashRuleRequest,
  type CreateCashTagRequest,
  type SetCashMovementTagsRequest,
  type UpdateCashRuleRequest,
  type UpdateCashTagRequest,
} from '@bettertrack/contracts';

import type {
  CashRuleRecord,
  CashRuleRepository,
} from '../../data/repositories/cashRuleRepository';
import type { CashTagRecord, CashTagRepository } from '../../data/repositories/cashTagRepository';
import { isDriverErrorCode } from '../../data/driverError';
import { badRequest, conflict, notFound } from '../../errors';
import type { CashWriteHook } from './cashBudgetService';
import { isSupportedCashRuleRegex, tagsByRules } from './cashRuleEngine';

/**
 * Cash tags and auto-tagging rules (V5 cash fusion).
 *
 * OWNERSHIP LIVES IN THE REPOSITORY (§10). Nothing in this file filters by user
 * id itself — it passes the caller's id down and reads the repository's answer.
 * A row belonging to another account comes back as `null` and becomes a 404 with
 * the same message an id that never existed produces, so existence never leaks.
 *
 * SYSTEM TAGS ARE APP-OWNED. They may be renamed and re-tinted (the engine
 * addresses them by `systemKey`, never by name) but never deleted, and neither
 * `system` nor `systemKey` is settable through any request shape.
 */

const TAG_NOT_FOUND = () => notFound('Tag not found.', 'CASH_TAG_NOT_FOUND');
const RULE_NOT_FOUND = () => notFound('Rule not found.', 'CASH_RULE_NOT_FOUND');
const TAG_NAME_TAKEN = () =>
  conflict('You already have a tag with that name.', 'CASH_TAG_NAME_TAKEN');
const TAG_SYSTEM_PROTECTED = () =>
  conflict('Built-in tags cannot be deleted.', 'CASH_TAG_SYSTEM_PROTECTED');
const TAG_REF_INVALID = () =>
  badRequest('One of those tags does not exist.', 'CASH_TAG_REF_NOT_FOUND');
const RULE_REGEX_UNSUPPORTED = () =>
  badRequest('That pattern is not a supported regular expression.', 'CASH_RULE_REGEX_UNSUPPORTED');
const RULE_LIMIT_REACHED = () =>
  conflict(
    `You already have the maximum of ${CASH_RULES_PER_USER_MAX} tagging rules. Delete one to add another.`,
    'CASH_RULE_LIMIT_REACHED',
  );
/**
 * 400, not the 409 its sibling above returns (#1954). A rule count is ACCOUNT
 * STATE — "you already have 200" is a conflict with something the user owns —
 * whereas an over-long pattern or an over-tagged rule is a MALFORMED ROW: the
 * write path refuses both with a 400 from the request schema, and the restore
 * lane's whole promise is that a document row meets the gate a written row does.
 */
const RULE_PATTERN_TOO_LONG = () =>
  badRequest(
    `A rule pattern may be at most ${CASH_RULE_PATTERN_MAX} characters.`,
    'CASH_RULE_PATTERN_TOO_LONG',
  );
const RULE_TAG_LIMIT_REACHED = () =>
  badRequest(
    `A rule may carry at most ${CASH_TAGS_PER_ITEM_MAX} tags.`,
    'CASH_RULE_TAG_LIMIT_REACHED',
  );
/**
 * 400 like its neighbours above, and for the same reason (#1963): a repeated
 * `(rule, tag)` link is a MALFORMED ROW SET, not a conflict with account state.
 * `cash_rule_tags` has a UNIQUE (rule_id, tag_id) index, so the second copy was
 * never going to be stored — before this it simply raised a driver error inside
 * the open rehydration transaction and answered 500.
 */
const RULE_TAG_DUPLICATE = () =>
  badRequest('A rule may link a tag only once.', 'CASH_RULE_TAG_DUPLICATE');
/**
 * 409 like the RULE cap, not 400: a tag count is ACCOUNT STATE — "you already
 * have a thousand" is a conflict with something the user owns, and the fix is
 * theirs to make (delete one), not a correction to the request they sent.
 */
const TAG_LIMIT_REACHED = () =>
  conflict(
    `You already have the maximum of ${CASH_TAGS_PER_USER_MAX} tags. Delete one to add another.`,
    'CASH_TAG_LIMIT_REACHED',
  );

/**
 * How many tagging rules one account may hold (#1743).
 *
 * THE RULE COUNT IS A MULTIPLIER ON EVERY CATEGORIZATION PASS: matching costs
 * `O(total note bytes × rules)`, at book time, on every staged import row and
 * on the whole ledger when "apply to existing" is pressed. Uncapped, one
 * account could make each of those passes arbitrarily expensive, and nothing
 * else in the lane bounded it.
 *
 * 200 is far past a real label set — the seeded system tags number six, and a
 * user hand-writing merchant rules stops in the dozens — so the cap is a
 * backstop rather than a limit anybody works around. It is pinned by a test, so
 * raising it is a deliberate edit and not a drive-by.
 *
 * NOT A HARD MAXIMUM UNDER CONCURRENCY: the count is read and the rule written
 * outside one transaction, so N simultaneous creates by the same account can
 * settle a few rows above it. Deliberate — this bounds a cost multiplier, not a
 * licence, and the overshoot is bounded by the caller's own concurrency. Anyone
 * needing it exact wants the check inside the insert (a conditional INSERT …
 * SELECT on the count), not a re-read.
 */
export const CASH_RULES_PER_USER_MAX = 200;

/** Postgres unique-violation, raised by the case-insensitive name index. */
function isUniqueViolation(err: unknown): boolean {
  return isDriverErrorCode(err, '23505');
}

/** The default tint a tag gets when the client sends none. */
const DEFAULT_TAG_COLOR = '#64748b';

function toTagDto(record: CashTagRecord): CashTag {
  return {
    id: record.id,
    name: record.name,
    color: record.color,
    system: record.system,
    systemKey: record.systemKey,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toRuleDto(record: CashRuleRecord): CashRule {
  return {
    id: record.id,
    tagIds: record.tagIds,
    matchType: record.matchType,
    pattern: record.pattern,
    priority: record.priority,
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * The facts this service needs from a restored rule row. The caller keeps the
 * full row shape (stable ids, timestamps) and hands it unchanged to its own
 * transaction-bound writer — the same seam `expenseService.restoreTransactions`
 * uses, so the restore lane gets the service's gate without this file learning
 * about vault contracts or opening a transaction.
 */
export interface CashRuleRestoreRow {
  matchType: CashRuleMatchType;
  pattern: string;
}

/** Caller-owned transaction seam for the bulk rule restore. */
export interface CashRuleRestoreScope<TRow extends CashRuleRestoreRow> {
  insertRules(rows: readonly TRow[]): Promise<void>;
}

/**
 * The facts this service needs from a restored `cash_rule_tags` link: which rule
 * it hangs off, and which tag — the PAIR is the row's identity in the table
 * (`cash_rule_tags_rule_tag_unique`), so a gate that could not see the tag id
 * could not tell one link from a copy of it (#1963). The caller keeps the full
 * row (its own id, the timestamp) and hands it back unchanged to its
 * transaction-bound writer, the same seam {@link CashRuleRestoreScope} uses.
 */
export interface CashRuleTagRestoreRow {
  ruleId: string;
  tagId: string;
}

/** Caller-owned transaction seam for the bulk rule→tag link restore. */
export interface CashRuleTagRestoreScope<TRow extends CashRuleTagRestoreRow> {
  insertRuleTags(rows: readonly TRow[]): Promise<void>;
}

/**
 * Caller-owned transaction seam for the bulk TAG restore. There is no
 * `CashTagRestoreRow`: the cap is a cardinality, so this gate needs no fact from
 * a row at all — every per-column bound a tag carries (name length, colour,
 * `systemKey`) is already stated by the document's row schema.
 */
export interface CashTagRestoreScope<TRow> {
  insertTags(rows: readonly TRow[]): Promise<void>;
}

export interface CashTagServiceDeps {
  tags: CashTagRepository;
  rules: CashRuleRepository;
  /**
   * THE CASH-WRITE SEAM (#1754). A retag is not a money write, but it decides
   * WHAT a movement counts against, so it can push a tag over its budget (or
   * drop it back under) exactly like recording the spend did. Non-fatal: the
   * retag itself must not fail because a budget alert could not be evaluated.
   */
  onCashWrite?: CashWriteHook;
}

export interface CashTagService {
  listTags(userId: string): Promise<CashTagListResponse>;
  createTag(userId: string, input: CreateCashTagRequest): Promise<CashTagResponse>;
  updateTag(userId: string, tagId: string, patch: UpdateCashTagRequest): Promise<CashTagResponse>;
  deleteTag(userId: string, tagId: string): Promise<void>;
  /** Seed the app-owned set for a brand-new account. */
  ensureSystemTags(userId: string): Promise<void>;
  setMovementTags(
    userId: string,
    movementId: string,
    input: SetCashMovementTagsRequest,
  ): Promise<CashMovementTagsResponse>;
  listRules(userId: string): Promise<CashRuleListResponse>;
  createRule(userId: string, input: CreateCashRuleRequest): Promise<CashRuleResponse>;
  updateRule(
    userId: string,
    ruleId: string,
    patch: UpdateCashRuleRequest,
  ): Promise<CashRuleResponse>;
  deleteRule(userId: string, ruleId: string): Promise<void>;
  /**
   * Install restored tags through the per-user cap a written one meets
   * (#1963) — `CASH_TAGS_PER_USER_MAX`, counting what the account already holds.
   */
  restoreTags<TRow>(
    userId: string,
    rows: readonly TRow[],
    scope: CashTagRestoreScope<TRow>,
  ): Promise<void>;
  /**
   * Install restored rules through the SAME gate a written one passes — the
   * regex must compile and the set must fit the per-user cap (#1743).
   */
  restoreRules<TRow extends CashRuleRestoreRow>(
    userId: string,
    rows: readonly TRow[],
    scope: CashRuleRestoreScope<TRow>,
  ): Promise<void>;
  /**
   * Install the restored rule→tag links through the cap a written rule's tag
   * set meets — `CASH_TAGS_PER_ITEM_MAX` PER RULE (#1954).
   */
  restoreRuleTags<TRow extends CashRuleTagRestoreRow>(
    userId: string,
    rows: readonly TRow[],
    scope: CashRuleTagRestoreScope<TRow>,
  ): Promise<void>;
  applyRules(userId: string): Promise<CashRuleApplyResponse>;
  previewRules(userId: string, note: string): Promise<CashRulePreviewResponse>;
}

export function createCashTagService(deps: CashTagServiceDeps): CashTagService {
  const { tags, rules, onCashWrite } = deps;

  /** The seam, swallowing: see {@link CashTagServiceDeps.onCashWrite}. */
  async function afterCashWrite(userId: string, portfolioId: string): Promise<void> {
    if (!onCashWrite) return;
    try {
      await onCashWrite(userId, portfolioId);
    } catch {
      // The evaluator is already non-throwing; this is the ordering rule made
      // explicit — the tags are written, and they stay written.
    }
  }

  /**
   * Every id must be one of the CALLER's tags. Rejecting the whole request on a
   * single foreign id is deliberate: silently dropping it would leave the client
   * believing a tag was applied, and applying it would be the IDOR.
   */
  async function assertOwnsTags(userId: string, tagIds: readonly string[]): Promise<void> {
    const requested = [...new Set(tagIds)];
    if (requested.length === 0) return;
    const owned = await tags.ownedTagsIn(userId, requested);
    if (owned.length !== requested.length) throw TAG_REF_INVALID();
  }

  return {
    async listTags(userId): Promise<CashTagListResponse> {
      const rows = await tags.listForOwner(userId);
      // A fresh account has never been seeded; do it on first read so the tag
      // picker is never empty and auto-tagging always has somewhere to land.
      if (rows.length === 0) {
        await tags.ensureSystemTags(userId);
        return { tags: (await tags.listForOwner(userId)).map(toTagDto) };
      }
      return { tags: rows.map(toTagDto) };
    },

    async createTag(userId, input): Promise<CashTagResponse> {
      // Counted BEFORE the insert, like the rule cap and for the same reason:
      // the name-clash 409 is raised by the unique index ON the insert, so a cap
      // that waited for the write would depend on the write being reached.
      //
      // NOT A HARD MAXIMUM UNDER CONCURRENCY (the rule cap's note applies
      // verbatim): the count is read and the tag written outside one
      // transaction, so simultaneous creates by one account can settle a few
      // rows above it. This bounds a cost multiplier, not a licence.
      if ((await tags.countForOwner(userId)) >= CASH_TAGS_PER_USER_MAX) throw TAG_LIMIT_REACHED();
      try {
        const created = await tags.create(userId, {
          name: input.name,
          color: input.color ?? DEFAULT_TAG_COLOR,
        });
        return { tag: toTagDto(created) };
      } catch (err) {
        // Names are unique per owner CASE-INSENSITIVELY: two tags a user cannot
        // tell apart would silently split every budget counting them.
        if (isUniqueViolation(err)) throw TAG_NAME_TAKEN();
        throw err;
      }
    },

    async updateTag(userId, tagId, patch): Promise<CashTagResponse> {
      try {
        const updated = await tags.update(userId, tagId, patch);
        if (updated === null) throw TAG_NOT_FOUND();
        return { tag: toTagDto(updated) };
      } catch (err) {
        if (isUniqueViolation(err)) throw TAG_NAME_TAKEN();
        throw err;
      }
    },

    async deleteTag(userId, tagId): Promise<void> {
      const tag = await tags.findByIdForOwner(userId, tagId);
      if (tag === null) throw TAG_NOT_FOUND();
      // App-owned: the engine assigns it, so removing it would leave every future
      // movement of that kind unlabelled with no way to get the tag back.
      if (tag.system) throw TAG_SYSTEM_PROTECTED();
      const deleted = await tags.delete(userId, tagId);
      if (!deleted) throw TAG_NOT_FOUND();
    },

    async ensureSystemTags(userId): Promise<void> {
      await tags.ensureSystemTags(userId);
    },

    async setMovementTags(userId, movementId, input): Promise<CashMovementTagsResponse> {
      // THE SECURITY BOUNDARY (§10): the repository resolves the movement through
      // `portfolios.user_id` AND every tag through `cash_tags.user_id` before it
      // writes anything, so a mismatch on either side is a not-found and never a
      // partial write. Both misses answer the same way — a caller learns nothing
      // about whether the id exists under some other account.
      const result = await tags.replaceMovementTags(userId, movementId, input.tagIds);
      if (!result.movementFound) throw notFound('Movement not found.', 'CASH_MOVEMENT_NOT_FOUND');
      if (result.unknownTagIds.length > 0) throw TAG_REF_INVALID();
      // The tag set decides which budget this movement's outflow counts
      // against, so a retag re-evaluates the ledger it belongs to (#1754).
      if (result.portfolioId !== null) await afterCashWrite(userId, result.portfolioId);
      return { movementId, tags: result.tags.map(toTagDto) };
    },

    async listRules(userId): Promise<CashRuleListResponse> {
      return { rules: (await rules.listForOwner(userId)).map(toRuleDto) };
    },

    async createRule(userId, input): Promise<CashRuleResponse> {
      await assertOwnsTags(userId, input.tagIds);
      // Validated at WRITE time so a pattern that would be inert at match time is
      // refused while the user is looking at it, not silently ignored later.
      if (input.matchType === 'regex' && !isSupportedCashRuleRegex(input.pattern)) {
        throw RULE_REGEX_UNSUPPORTED();
      }
      // Only CREATE counts: an update cannot grow the set, and refusing to edit
      // a rule because the account is already at the cap would strand a user who
      // needs to fix exactly one of them.
      if ((await rules.countForOwner(userId)) >= CASH_RULES_PER_USER_MAX) {
        throw RULE_LIMIT_REACHED();
      }
      const created = await rules.create(userId, {
        matchType: input.matchType,
        pattern: input.pattern,
        priority: input.priority,
        enabled: input.enabled,
        tagIds: input.tagIds,
      });
      return { rule: toRuleDto(created) };
    },

    async updateRule(userId, ruleId, patch): Promise<CashRuleResponse> {
      const existing = await rules.findByIdForOwner(userId, ruleId);
      if (existing === null) throw RULE_NOT_FOUND();
      if (patch.tagIds !== undefined) await assertOwnsTags(userId, patch.tagIds);

      // The effective pair after the patch — a patch changing only the type must
      // still be validated against the pattern already stored, and vice versa.
      const matchType = patch.matchType ?? existing.matchType;
      const pattern = patch.pattern ?? existing.pattern;
      if (matchType === 'regex' && !isSupportedCashRuleRegex(pattern)) {
        throw RULE_REGEX_UNSUPPORTED();
      }

      const updated = await rules.update(userId, ruleId, patch);
      if (updated === null) throw RULE_NOT_FOUND();
      return { rule: toRuleDto(updated) };
    },

    async deleteRule(userId, ruleId): Promise<void> {
      const deleted = await rules.delete(userId, ruleId);
      if (!deleted) throw RULE_NOT_FOUND();
    },

    /**
     * THE TAG TABLE'S OWN GATE (#1963).
     *
     * `restoreRules` below caps how many rules a document installs and
     * `restoreRuleTags` caps how many tags each carries — and neither bounded
     * the tags THEMSELVES. A vault document is limited only by
     * `VAULT_MAX_BYTES_DEFAULT` (16 MB), which is tens of thousands of `cashTag`
     * rows, and those rows are the supply side of the fan-out: 20 000 restorable
     * tags are what made 20 000 links to one rule reachable at all. They are
     * also each a row in an unbounded read (`GET /cash/tags` returns the whole
     * set) and a cascade target of every tag delete.
     *
     * A CARDINALITY AND NOTHING ELSE. Every per-column bound a restored tag
     * carries — name length, colour, the `systemKey` enum — is already stated by
     * the document's row schema, so this gate reads no field: one COUNT, one
     * comparison, and the caller's rows are handed on untouched.
     *
     * REFUSES THE WHOLE DOCUMENT, never a prefix, for the reason the rule cap
     * states at length — and more sharply here, because a tag is referenced:
     * dropping the tail of the tag set would take its rules, budgets and
     * movement links with it through the cascade, in the one mode where the
     * server holds no second copy.
     *
     * Counts existing rows too: the restore writes into a wiped account today,
     * but a cap that only counted the document would be one re-run away from
     * being no cap at all.
     */
    async restoreTags(userId, rows, scope): Promise<void> {
      if (rows.length === 0) return;
      if ((await tags.countForOwner(userId)) + rows.length > CASH_TAGS_PER_USER_MAX) {
        throw TAG_LIMIT_REACHED();
      }
      await scope.insertTags(rows);
    },

    /**
     * THE RESTORE LANE'S GATE (#1743). A vault document is client-held and
     * client-written, so its rule rows used to enter `cash_rules` having met no
     * check the HTTP path applies: the row schema took a bare string, and the
     * restore repository inserted it. That made a restore the one way to install
     * a pattern RE2 cannot compile (inert, and invisible — the user sees a rule
     * that never fires) or a rule set of any size at all.
     *
     * Length is bounded by the row schema itself (`vault.ts`) AND re-checked
     * here (#1954), so the docblock's claim — "the same gate a written rule
     * passes" — is literally true of this function rather than true only of the
     * one caller that happens to parse first. What is left beyond it is what
     * only the service knows: the regex must COMPILE, and the set must fit the
     * same per-user cap a written rule meets.
     *
     * ORDER IS LOAD-BEARING (#1954): the O(1) CARDINALITY CHECK RUNS FIRST.
     * Compiling is the expensive half — RE2 compiles every restored pattern,
     * ~1.2 s for 35 000 of them, inside the OPEN rehydration transaction, and it
     * evicts the shared 512-entry compile cache on the way through. Doing that
     * before asking "is this document even allowed to be this big?" made the
     * refusal cost more than the acceptance. A document past the cap is now
     * turned away by one COUNT and a comparison, having compiled nothing.
     *
     * BOTH REFUSE THE WHOLE RESTORE rather than importing a bounded prefix.
     * That is the deliberate choice, and the reasoning is this:
     *
     *  - A rehydration is one transaction and is NON-DESTRUCTIVE when it fails —
     *    the ciphertext, the client's copy and the account all survive, and the
     *    user can prune the offending rules in the client and retry. Nothing is
     *    lost by refusing.
     *  - A bounded prefix WOULD lose something, silently: rules the user still
     *    believes they own would simply not be there afterwards, in the one mode
     *    where the server holds no second copy to notice the difference. Silent
     *    partial restores are exactly what `validateGraph` refuses to do for
     *    every other malformed row in the document, and this stays in step with
     *    it.
     *  - The cap is far above any real rule set, so a legitimate document cannot
     *    meet it by accident.
     *
     * Counts existing rows too: the restore writes into a wiped account today,
     * but a cap that only counted the document would be one re-run away from
     * being no cap at all.
     */
    async restoreRules(userId, rows, scope): Promise<void> {
      if (rows.length === 0) return;
      // Cardinality first — one count, no compiles (see the order note above).
      const existing = await rules.countForOwner(userId);
      if (existing + rows.length > CASH_RULES_PER_USER_MAX) throw RULE_LIMIT_REACHED();
      for (const row of rows) {
        // Length before compile, for the same reason and one level down: a
        // pattern the write path could never have stored is refused on a string
        // length rather than handed to the regex engine to think about.
        if (row.pattern.length > CASH_RULE_PATTERN_MAX) throw RULE_PATTERN_TOO_LONG();
        if (row.matchType === 'regex' && !isSupportedCashRuleRegex(row.pattern)) {
          throw RULE_REGEX_UNSUPPORTED();
        }
      }
      await scope.insertRules(rows);
    },

    /**
     * THE OTHER HALF OF A RESTORED RULE (#1954).
     *
     * `restoreRules` above caps how many rules a document may install; this caps
     * how many TAGS each of them may carry. The two multiply — matching costs
     * `O(notes × rules)` and writing costs `O(matched movements × that rule's
     * tags)` — so capping one and not the other caps nothing: `loadRules`
     * aggregates a rule's tags with an unbounded `array_agg`, and
     * `applyCashRuleTags` then pushes one (movement, tag) pair per tag.
     *
     * WHY THE SERVICE REPEATS THE DOCUMENT SCHEMA'S CHECK. `vault.ts` refuses an
     * over-tagged rule at parse time, which is the earliest possible refusal and
     * the one that protects the HTTP rehydration route. This gate is the one
     * that protects the TABLE: it is what any future caller with its own parse
     * path — a second restore surface, a migration, a test harness — meets, and
     * §13.5's rule is that the server does not trust a vault payload, not that
     * it trusts one parser. Neither check is redundant with the other; they
     * guard different doors into the same rows.
     *
     * COUNTS ONLY THE DOCUMENT, unlike the per-user rule cap. A restore writes
     * the rules and their links in the same transaction, moments apart, so the
     * links this document carries ARE the rule's whole tag set. Adding a live
     * `SELECT count(*) … GROUP BY rule_id` would re-read rows this same
     * transaction has just written and could only ever return the same numbers.
     */
    // `_userId`: the owner is carried for seam symmetry with `restoreRules` and
    // because a caller must not be able to hand these links to the service
    // without naming whose account they are entering. The CHECK itself is
    // document-local (see above), so the id is deliberately not read here —
    // ownership of the referenced rules is proved by `validateGraph`, and the
    // write is scoped by the caller's own transaction (§10: scoping lives in the
    // repository, never in a service's argument list).
    async restoreRuleTags(_userId, rows, scope): Promise<void> {
      if (rows.length === 0) return;
      const perRule = new Map<string, number>();
      const seen = new Set<string>();
      for (const row of rows) {
        // THE PAIR IS THE ROW'S IDENTITY (#1963), and it is checked BEFORE the
        // count: a rule pushed past the fan-out cap BY repeats is a document
        // with duplicate links, and that is the honest answer to give. Without
        // this the second copy reached `INSERT` and `cash_rule_tags_rule_tag_
        // unique` raised a driver error inside the open rehydration transaction
        // — a 500 for a payload the server could have named at the door.
        // `\u0000` cannot occur in a uuid, so the joined key is unambiguous.
        const pair = `${row.ruleId}\u0000${row.tagId}`;
        if (seen.has(pair)) throw RULE_TAG_DUPLICATE();
        seen.add(pair);
        const count = (perRule.get(row.ruleId) ?? 0) + 1;
        if (count > CASH_TAGS_PER_ITEM_MAX) throw RULE_TAG_LIMIT_REACHED();
        perRule.set(row.ruleId, count);
      }
      await scope.insertRuleTags(rows);
    },

    /**
     * Apply the caller's rules to the movements they already have.
     *
     * Unlike the book-time path this one is ALLOWED TO FAIL LOUDLY: there, the
     * user came to record money and a labelling fault must not cost them the
     * transaction; here the labelling IS the request, so swallowing an error
     * would report "0 movements tagged" for a run that never happened.
     *
     * The scan is paged and bounded (#1743); `complete` is passed through
     * untouched so the caller can tell a whole-ledger pass from one that
     * stopped at the bound, instead of reading a count that looks the same
     * either way.
     */
    async applyRules(userId): Promise<CashRuleApplyResponse> {
      const outcome = await rules.applyToExistingMovements(userId);
      return { movementsTagged: outcome.movementsTagged, complete: outcome.complete };
    },

    /**
     * What the caller's rules WOULD assign to `note` — the entry form asks this
     * while you type, so the tag appears before you commit rather than after.
     *
     * Writes nothing. It runs the SAME engine over the SAME evaluation order the
     * booking path uses (`listForOwner` returns rules ordered; the engine walks
     * that order and stops at the first match), so the preview cannot promise a
     * tag the booking would not apply.
     */
    async previewRules(userId, note): Promise<CashRulePreviewResponse> {
      const trimmed = note.trim();
      if (trimmed === '') return { tagIds: [] };
      return { tagIds: tagsByRules(trimmed, await rules.listForOwner(userId)) };
    },
  };
}

/** The seeded set, re-exported so a caller can name the app-owned tags. */
export { CASH_SYSTEM_TAGS };

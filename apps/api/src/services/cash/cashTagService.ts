import {
  CASH_SYSTEM_TAGS,
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
   * Install restored rules through the SAME gate a written one passes — the
   * regex must compile and the set must fit the per-user cap (#1743).
   */
  restoreRules<TRow extends CashRuleRestoreRow>(
    userId: string,
    rows: readonly TRow[],
    scope: CashRuleRestoreScope<TRow>,
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
     * THE RESTORE LANE'S GATE (#1743). A vault document is client-held and
     * client-written, so its rule rows used to enter `cash_rules` having met no
     * check the HTTP path applies: the row schema took a bare string, and the
     * restore repository inserted it. That made a restore the one way to install
     * a pattern RE2 cannot compile (inert, and invisible — the user sees a rule
     * that never fires) or a rule set of any size at all.
     *
     * Length is now bounded by the row schema itself (`vault.ts`), so what is
     * left for the service is what only the service knows: the regex must
     * COMPILE, and the set must fit the same per-user cap a written rule meets.
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
      for (const row of rows) {
        if (row.matchType === 'regex' && !isSupportedCashRuleRegex(row.pattern)) {
          throw RULE_REGEX_UNSUPPORTED();
        }
      }
      const existing = await rules.countForOwner(userId);
      if (existing + rows.length > CASH_RULES_PER_USER_MAX) throw RULE_LIMIT_REACHED();
      await scope.insertRules(rows);
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

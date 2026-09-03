import {
  CASH_SYSTEM_TAGS,
  type CashMovementTagsResponse,
  type CashRule,
  type CashRuleListResponse,
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

export interface CashTagServiceDeps {
  tags: CashTagRepository;
  rules: CashRuleRepository;
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
  applyRules(userId: string): Promise<CashRuleApplyResponse>;
  previewRules(userId: string, note: string): Promise<CashRulePreviewResponse>;
}

export function createCashTagService(deps: CashTagServiceDeps): CashTagService {
  const { tags, rules } = deps;

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
     * Apply the caller's rules to the movements they already have.
     *
     * Unlike the book-time path this one is ALLOWED TO FAIL LOUDLY: there, the
     * user came to record money and a labelling fault must not cost them the
     * transaction; here the labelling IS the request, so swallowing an error
     * would report "0 movements tagged" for a run that never happened.
     */
    async applyRules(userId): Promise<CashRuleApplyResponse> {
      return { movementsTagged: await rules.applyToExistingMovements(userId) };
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CASH_RULE_PATTERN_MAX, CASH_TAGS_PER_ITEM_MAX } from '@bettertrack/contracts';

import type { CashRuleRepository } from '../../../data/repositories/cashRuleRepository';
import type { CashTagRepository } from '../../../data/repositories/cashTagRepository';
import { ApiError } from '../../../errors';
import { isSupportedCashRuleRegex } from '../cashRuleEngine';
import { CASH_RULES_PER_USER_MAX, createCashTagService } from '../cashTagService';

/**
 * The compile step is SPIED, not stubbed: the real RE2 check still runs, and the
 * spy exists only so a test can assert that the cap refused a document WITHOUT
 * the patterns ever reaching it (#1954).
 */
vi.mock('../cashRuleEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cashRuleEngine')>();
  return { ...actual, isSupportedCashRuleRegex: vi.fn(actual.isSupportedCashRuleRegex) };
});

beforeEach(() => {
  vi.mocked(isSupportedCashRuleRegex).mockClear();
});

/**
 * THE BOUNDS ON THE CASH RULE LANE (#1743).
 *
 * `cashTagService` said of itself that a pattern is "validated at WRITE time so
 * a pattern that would be inert at match time is refused while the user is
 * looking at it" — and the restore lane walked straight past that claim,
 * inserting document rows into `cash_rules` unchecked. Nothing counted rules
 * either, although the rule count multiplies every categorization pass.
 *
 * These tests pin both bounds and, deliberately, the CAP CONSTANT itself: a
 * limit that can drift silently is not a limit.
 */

const USER = '018f0000-0000-7000-8000-0000000000aa';

function stubRules(overrides: Partial<CashRuleRepository> = {}): CashRuleRepository {
  return {
    countForOwner: vi.fn(async () => 0),
    create: vi.fn(async () => {
      throw new Error('create not stubbed');
    }),
    ...overrides,
  } as unknown as CashRuleRepository;
}

const NO_TAGS = { ownedTagsIn: vi.fn(async (_u: string, ids: readonly string[]) => [...ids]) };

function service(rules: CashRuleRepository) {
  return createCashTagService({ tags: NO_TAGS as unknown as CashTagRepository, rules });
}

const restoredRule = (pattern: string, matchType: 'contains' | 'regex' = 'contains') => ({
  matchType,
  pattern,
});

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected a refusal');
}

describe('per-user rule cap', () => {
  it('pins the cap, so raising it is a deliberate edit', () => {
    expect(CASH_RULES_PER_USER_MAX).toBe(200);
  });

  it('refuses a create once the account already holds the maximum', async () => {
    const create = vi.fn();
    const rules = stubRules({
      countForOwner: vi.fn(async () => CASH_RULES_PER_USER_MAX),
      create: create as unknown as CashRuleRepository['create'],
    });

    const err = await refusal(() =>
      service(rules).createRule(USER, {
        tagIds: ['018f0000-0000-7000-8000-0000000000b1'],
        matchType: 'contains',
        pattern: 'SPAR',
        priority: 0,
        enabled: true,
      }),
    );

    expect(err.code).toBe('CASH_RULE_LIMIT_REACHED');
    expect(err.statusCode).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });

  it('still allows the rule that lands exactly ON the cap', async () => {
    const created = {
      id: '018f0000-0000-7000-8000-0000000000c1',
      userId: USER,
      matchType: 'contains' as const,
      pattern: 'SPAR',
      priority: 0,
      enabled: true,
      tagIds: [],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const rules = stubRules({
      countForOwner: vi.fn(async () => CASH_RULES_PER_USER_MAX - 1),
      create: vi.fn(async () => created) as unknown as CashRuleRepository['create'],
    });

    const res = await service(rules).createRule(USER, {
      tagIds: [],
      matchType: 'contains',
      pattern: 'SPAR',
      priority: 0,
      enabled: true,
    });

    expect(res.rule.id).toBe(created.id);
  });
});

describe('restored rules go through the write path’s gate', () => {
  it('refuses a regex RE2 cannot compile, with the error the HTTP path returns', async () => {
    const insertRules = vi.fn(async () => {});
    const rules = stubRules();

    const err = await refusal(() =>
      // A backreference: RE2 refuses it, so the rule would sit in the table
      // matching nothing at all — invisible to the user who restored it.
      service(rules).restoreRules(USER, [restoredRule('(a)\\1', 'regex')], { insertRules }),
    );

    expect(err.code).toBe('CASH_RULE_REGEX_UNSUPPORTED');
    expect(err.statusCode).toBe(400);
    expect(insertRules).not.toHaveBeenCalled();
  });

  it('refuses the WHOLE document when its rules exceed the cap — never a silent prefix', async () => {
    const insertRules = vi.fn(async () => {});
    const rules = stubRules({ countForOwner: vi.fn(async () => 0) });
    const document = Array.from({ length: CASH_RULES_PER_USER_MAX + 1 }, (_, i) =>
      restoredRule(`merchant-${i}`),
    );

    const err = await refusal(() => service(rules).restoreRules(USER, document, { insertRules }));

    expect(err.code).toBe('CASH_RULE_LIMIT_REACHED');
    // Nothing partial: a prefix would delete rules the user still believes they
    // own, in the one mode where the server holds no second copy.
    expect(insertRules).not.toHaveBeenCalled();
  });

  it('counts rules the account ALREADY has, so a re-run cannot walk past the cap', async () => {
    const insertRules = vi.fn(async () => {});
    const rules = stubRules({ countForOwner: vi.fn(async () => CASH_RULES_PER_USER_MAX - 1) });

    const err = await refusal(() =>
      service(rules).restoreRules(USER, [restoredRule('a'), restoredRule('b')], { insertRules }),
    );

    expect(err.code).toBe('CASH_RULE_LIMIT_REACHED');
    expect(insertRules).not.toHaveBeenCalled();
  });

  it('hands a legal document straight to the caller’s writer, rows unchanged', async () => {
    const rules = stubRules();
    const document = [restoredRule('SPAR'), restoredRule('^billa', 'regex')];
    const insertRules = vi.fn(async (_rows: readonly (typeof document)[number][]) => {});

    await service(rules).restoreRules(USER, document, { insertRules });

    expect(insertRules).toHaveBeenCalledTimes(1);
    expect(insertRules.mock.calls[0]![0]).toBe(document);
  });

  it('does not query or write for an empty document', async () => {
    const insertRules = vi.fn(async () => {});
    const countForOwner = vi.fn(async () => 0);
    const rules = stubRules({ countForOwner });

    await service(rules).restoreRules(USER, [], { insertRules });

    expect(countForOwner).not.toHaveBeenCalled();
    expect(insertRules).not.toHaveBeenCalled();
  });
});

describe('the cap is checked BEFORE any pattern is compiled (#1954)', () => {
  /**
   * Compiling is the expensive half and it happens inside the OPEN rehydration
   * transaction: RE2 compiles every restored pattern (~1.2 s for 35 000) and
   * evicts the shared 512-entry compile cache on the way through. Checking the
   * cardinality afterwards meant a document that was never going to be accepted
   * could buy all of that with one refusal.
   */
  it('refuses an over-cap document by CARDINALITY, having compiled nothing', async () => {
    const insertRules = vi.fn(async () => {});
    const rules = stubRules({ countForOwner: vi.fn(async () => 0) });
    // Every row is also an uncompilable regex, so the ONLY thing that can
    // decide which error comes back is which check ran first.
    const document = Array.from({ length: CASH_RULES_PER_USER_MAX + 1 }, () =>
      restoredRule('(a)\\1', 'regex'),
    );

    const err = await refusal(() => service(rules).restoreRules(USER, document, { insertRules }));

    expect(err.code).toBe('CASH_RULE_LIMIT_REACHED');
    expect(isSupportedCashRuleRegex).not.toHaveBeenCalled();
    expect(insertRules).not.toHaveBeenCalled();
  });

  it('still compiles — and still refuses — a document that fits the cap', async () => {
    const insertRules = vi.fn(async () => {});

    const err = await refusal(() =>
      service(stubRules()).restoreRules(USER, [restoredRule('(a)\\1', 'regex')], { insertRules }),
    );

    expect(err.code).toBe('CASH_RULE_REGEX_UNSUPPORTED');
    expect(isSupportedCashRuleRegex).toHaveBeenCalledTimes(1);
  });
});

describe('a restored pattern meets the write path’s LENGTH bound too (#1954)', () => {
  /**
   * The vault row schema bounds it, and this bounds it again — so the service's
   * own docblock ("the same gate a written rule passes") is true of the FUNCTION
   * rather than true only of the one caller that happens to parse first. §13.5:
   * the server does not trust a vault payload, and it does not trust one parser
   * either.
   */
  it('lands exactly ON the ceiling and is accepted', async () => {
    const insertRules = vi.fn(async () => {});
    const document = [restoredRule('a'.repeat(CASH_RULE_PATTERN_MAX))];

    await service(stubRules()).restoreRules(USER, document, { insertRules });

    expect(insertRules).toHaveBeenCalledTimes(1);
  });

  it('refuses one character past it, before the regex engine is asked', async () => {
    const insertRules = vi.fn(async () => {});

    const err = await refusal(() =>
      service(stubRules()).restoreRules(
        USER,
        [restoredRule('a'.repeat(CASH_RULE_PATTERN_MAX + 1), 'regex')],
        { insertRules },
      ),
    );

    expect(err.code).toBe('CASH_RULE_PATTERN_TOO_LONG');
    expect(err.statusCode).toBe(400);
    expect(isSupportedCashRuleRegex).not.toHaveBeenCalled();
    expect(insertRules).not.toHaveBeenCalled();
  });
});

describe('a restored rule’s TAG FAN-OUT meets the same cap a written one does (#1954)', () => {
  /**
   * `CASH_TAGS_PER_ITEM_MAX` is free on the HTTP path because a written rule
   * carries its tags as one array. A restore carries the same set as N
   * independent link rows, and before this the restore capped nothing at all:
   * `loadRules` aggregates them with an unbounded `array_agg` and
   * `applyCashRuleTags` pushes one (movement, tag) pair PER TAG for every
   * movement a rule matches. It is the other factor of the product #1743 capped
   * the rule COUNT of.
   */
  const RULE_A = '018f0000-0000-7000-8000-0000000000e1';
  const RULE_B = '018f0000-0000-7000-8000-0000000000e2';
  /**
   * A DISTINCT tag per link. `(ruleId, tagId)` is unique in `cash_rule_tags` and
   * the gate says so too (#1963), so a fan-out fixture repeating one tag id
   * would be refused as a duplicate and would stop proving anything about the
   * fan-out cap.
   */
  const links = (ruleId: string, count: number, offset = 0) =>
    Array.from({ length: count }, (_unused, i) => ({
      ruleId,
      tagId: `018f0000-0000-7000-8000-1${(offset + i).toString(16).padStart(11, '0')}`,
    }));

  it('accepts a rule landing exactly ON the cap', async () => {
    const document = links(RULE_A, CASH_TAGS_PER_ITEM_MAX);
    const insertRuleTags = vi.fn(async (_rows: readonly { ruleId: string }[]) => {});

    await service(stubRules()).restoreRuleTags(USER, document, { insertRuleTags });

    expect(insertRuleTags).toHaveBeenCalledTimes(1);
    // Rows unchanged, handed straight to the caller's transaction-bound writer.
    expect(insertRuleTags.mock.calls[0]![0]).toBe(document);
  });

  it('refuses the WHOLE document one link past the cap — never a bounded prefix', async () => {
    const insertRuleTags = vi.fn(async () => {});

    const err = await refusal(() =>
      service(stubRules()).restoreRuleTags(USER, links(RULE_A, CASH_TAGS_PER_ITEM_MAX + 1), {
        insertRuleTags,
      }),
    );

    expect(err.code).toBe('CASH_RULE_TAG_LIMIT_REACHED');
    expect(err.statusCode).toBe(400);
    // A prefix would leave the user with a rule that quietly means something
    // else — the same reasoning `restoreRules` states for the rule cap.
    expect(insertRuleTags).not.toHaveBeenCalled();
  });

  it('counts PER RULE, so many fully-tagged rules restore fine', async () => {
    const insertRuleTags = vi.fn(async () => {});

    await service(stubRules()).restoreRuleTags(
      USER,
      [...links(RULE_A, CASH_TAGS_PER_ITEM_MAX), ...links(RULE_B, CASH_TAGS_PER_ITEM_MAX)],
      { insertRuleTags },
    );

    expect(insertRuleTags).toHaveBeenCalledTimes(1);

    // …and one offender still condemns the document, wherever it sits.
    const second = vi.fn(async () => {});
    const err = await refusal(() =>
      service(stubRules()).restoreRuleTags(
        USER,
        [...links(RULE_A, CASH_TAGS_PER_ITEM_MAX), ...links(RULE_B, CASH_TAGS_PER_ITEM_MAX + 1)],
        { insertRuleTags: second },
      ),
    );
    expect(err.code).toBe('CASH_RULE_TAG_LIMIT_REACHED');
    expect(second).not.toHaveBeenCalled();
  });

  it('refuses the 16 MB shape the bound exists for', async () => {
    const insertRuleTags = vi.fn(async () => {});

    const err = await refusal(() =>
      service(stubRules()).restoreRuleTags(USER, links(RULE_A, 5_000), { insertRuleTags }),
    );

    expect(err.code).toBe('CASH_RULE_TAG_LIMIT_REACHED');
    expect(insertRuleTags).not.toHaveBeenCalled();
  });

  it('does not write for an empty document', async () => {
    const insertRuleTags = vi.fn(async () => {});

    await service(stubRules()).restoreRuleTags(USER, [], { insertRuleTags });

    expect(insertRuleTags).not.toHaveBeenCalled();
  });
});

describe('a restored rule→tag link is UNIQUE per pair (#1963)', () => {
  /**
   * `cash_rule_tags` carries `uniqueIndex('cash_rule_tags_rule_tag_unique')` and
   * `restoreCashRuleTags` inserts with no conflict handling ON PURPOSE — a
   * duplicate means a malformed vault and must fail loudly. Loudly meant a
   * driver error inside the OPEN rehydration transaction: a 500 raised after the
   * document had been proved and the write had begun. The document schema
   * refuses the shape at parse time; this is the gate on the TABLE, for any
   * caller that did not come through that parse (§13.5: the server does not
   * trust a vault payload, and does not trust one parser either).
   */
  const RULE_A = '018f0000-0000-7000-8000-0000000000e1';
  const RULE_B = '018f0000-0000-7000-8000-0000000000e2';
  const TAG = '018f0000-0000-7000-8000-0000000000f1';
  const OTHER_TAG = '018f0000-0000-7000-8000-0000000000f2';

  it('refuses the same (rule, tag) pair twice, rather than leaving it to the unique index', async () => {
    const insertRuleTags = vi.fn(async () => {});

    const err = await refusal(() =>
      service(stubRules()).restoreRuleTags(
        USER,
        [
          { ruleId: RULE_A, tagId: TAG },
          { ruleId: RULE_A, tagId: TAG },
        ],
        { insertRuleTags },
      ),
    );

    expect(err.code).toBe('CASH_RULE_TAG_DUPLICATE');
    // 400, not the cap's 409: a repeated link is a MALFORMED ROW SET, which is
    // what the write path refuses with a 400 from its request schema.
    expect(err.statusCode).toBe(400);
    expect(insertRuleTags).not.toHaveBeenCalled();
  });

  it('is a PAIR, not an id: one tag on two rules and two tags on one rule are legal', async () => {
    const insertRuleTags = vi.fn(async () => {});

    await service(stubRules()).restoreRuleTags(
      USER,
      [
        { ruleId: RULE_A, tagId: TAG },
        { ruleId: RULE_B, tagId: TAG },
        { ruleId: RULE_A, tagId: OTHER_TAG },
      ],
      { insertRuleTags },
    );

    expect(insertRuleTags).toHaveBeenCalledTimes(1);
  });

  it('names the DUPLICATE, not the cap, when duplicates are what push a rule over it', async () => {
    // CASH_TAGS_PER_ITEM_MAX distinct links plus one repeat is one row past the
    // fan-out cap as well. Only the ORDER of the two checks can decide the
    // answer, and the accurate one is the duplicate.
    const insertRuleTags = vi.fn(async () => {});
    const distinct = Array.from({ length: CASH_TAGS_PER_ITEM_MAX }, (_unused, i) => ({
      ruleId: RULE_A,
      tagId: `018f0000-0000-7000-8000-2${i.toString(16).padStart(11, '0')}`,
    }));

    const err = await refusal(() =>
      service(stubRules()).restoreRuleTags(USER, [...distinct, distinct[0]!], { insertRuleTags }),
    );

    expect(err.code).toBe('CASH_RULE_TAG_DUPLICATE');
    expect(insertRuleTags).not.toHaveBeenCalled();
  });
});

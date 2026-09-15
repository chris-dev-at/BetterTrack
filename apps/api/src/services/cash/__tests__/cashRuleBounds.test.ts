import { describe, expect, it, vi } from 'vitest';

import type { CashRuleRepository } from '../../../data/repositories/cashRuleRepository';
import type { CashTagRepository } from '../../../data/repositories/cashTagRepository';
import { ApiError } from '../../../errors';
import { CASH_RULES_PER_USER_MAX, createCashTagService } from '../cashTagService';

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

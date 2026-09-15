import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EXPENSE_RULE_PATTERN_MAX } from '@bettertrack/contracts';

import type {
  ExpenseCategoryRepository,
  ExpenseRuleRepository,
  ExpenseTransactionRepository,
} from '../../../data/repositories/expenseRepository';
import { ApiError } from '../../../errors';
import { CASH_RULES_PER_USER_MAX } from '../../cash/cashTagService';
import { isSupportedExpenseRuleRegex } from '../ruleEngine';
import { EXPENSE_RULES_PER_USER_MAX, createExpenseService } from '../expenseService';

/** Spied, not stubbed — the real check still runs (see the cash twin, #1954). */
vi.mock('../ruleEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ruleEngine')>();
  return { ...actual, isSupportedExpenseRuleRegex: vi.fn(actual.isSupportedExpenseRuleRegex) };
});

beforeEach(() => {
  vi.mocked(isSupportedExpenseRuleRegex).mockClear();
});

/**
 * THE SAME BOUNDS, ON THE EXPENSE ENGINE (#1743).
 *
 * The `/expenses` write routes are retired behind `410 EXPENSE_AREA_RETIRED`,
 * but the RESTORE lane still reaches `expenseService`, and `expense_rules` rows
 * are still evaluated by `ruleEngine`. Mirroring the cash lane's gate keeps this
 * side from being the cheap way round the other.
 */

const USER = '018f0000-0000-7000-8000-0000000000aa';
const CATEGORY = '018f0000-0000-7000-8000-0000000000b1';

function stubRules(overrides: Partial<ExpenseRuleRepository> = {}): ExpenseRuleRepository {
  return {
    countForOwner: vi.fn(async () => 0),
    create: vi.fn(async () => {
      throw new Error('create not stubbed');
    }),
    ...overrides,
  } as unknown as ExpenseRuleRepository;
}

function service(rules: ExpenseRuleRepository) {
  return createExpenseService({
    categories: {
      ownsCategory: vi.fn(async () => true),
    } as unknown as ExpenseCategoryRepository,
    transactions: {} as unknown as ExpenseTransactionRepository,
    rules,
  });
}

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected a refusal');
}

it('pins the cap, and keeps it in step with the cash engine', () => {
  expect(EXPENSE_RULES_PER_USER_MAX).toBe(200);
  expect(EXPENSE_RULES_PER_USER_MAX).toBe(CASH_RULES_PER_USER_MAX);
});

it('refuses a create once the account already holds the maximum', async () => {
  const create = vi.fn();
  const rules = stubRules({
    countForOwner: vi.fn(async () => EXPENSE_RULES_PER_USER_MAX),
    create: create as unknown as ExpenseRuleRepository['create'],
  });

  const err = await refusal(() =>
    service(rules).createRule(USER, {
      categoryId: CATEGORY,
      matchType: 'contains',
      pattern: 'REWE',
      priority: 0,
      enabled: true,
    }),
  );

  expect(err.code).toBe('EXPENSE_RULE_LIMIT_REACHED');
  expect(err.statusCode).toBe(409);
  expect(create).not.toHaveBeenCalled();
});

describe('restored rules go through the write path’s gate', () => {
  it('refuses a regex RE2 cannot compile, with the error the HTTP path returns', async () => {
    const insertRules = vi.fn(async () => {});

    const err = await refusal(() =>
      service(stubRules()).restoreRules(USER, [{ matchType: 'regex', pattern: '(a)\\1' }], {
        insertRules,
      }),
    );

    expect(err.code).toBe('EXPENSE_RULE_REGEX_UNSUPPORTED');
    expect(err.statusCode).toBe(400);
    expect(insertRules).not.toHaveBeenCalled();
  });

  it('refuses the whole document past the cap, existing rows counted', async () => {
    const insertRules = vi.fn(async () => {});
    const rules = stubRules({ countForOwner: vi.fn(async () => 1) });
    const document = Array.from({ length: EXPENSE_RULES_PER_USER_MAX }, (_, i) => ({
      matchType: 'contains' as const,
      pattern: `merchant-${i}`,
    }));

    const err = await refusal(() => service(rules).restoreRules(USER, document, { insertRules }));

    expect(err.code).toBe('EXPENSE_RULE_LIMIT_REACHED');
    expect(insertRules).not.toHaveBeenCalled();
  });

  it('hands a legal document straight to the caller’s writer', async () => {
    const document = [{ matchType: 'contains' as const, pattern: 'REWE' }];
    const insertRules = vi.fn(async (_rows: readonly (typeof document)[number][]) => {});

    await service(stubRules()).restoreRules(USER, document, { insertRules });

    expect(insertRules).toHaveBeenCalledTimes(1);
    expect(insertRules.mock.calls[0]![0]).toBe(document);
  });
});

it('still allows the rule that lands exactly ON the cap', async () => {
  // The cash lane has had this since #1743 and this side did not, so nothing
  // proved the expense cap was a CEILING rather than an off-by-one that refused
  // the last rule a user is entitled to (#1954).
  const record = {
    id: '018f0000-0000-7000-8000-0000000000c1',
    userId: USER,
    categoryId: CATEGORY,
    matchType: 'contains' as const,
    pattern: 'REWE',
    priority: 0,
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const rules = stubRules({
    countForOwner: vi.fn(async () => EXPENSE_RULES_PER_USER_MAX - 1),
    create: vi.fn(async () => record) as unknown as ExpenseRuleRepository['create'],
  });

  const res = await service(rules).createRule(USER, {
    categoryId: CATEGORY,
    matchType: 'contains',
    pattern: 'REWE',
    priority: 0,
    enabled: true,
  });

  expect(res.rule.id).toBe(record.id);
});

describe('the cap is checked BEFORE any pattern is compiled (#1954)', () => {
  it('refuses an over-cap document by CARDINALITY, having compiled nothing', async () => {
    const insertRules = vi.fn(async () => {});
    const document = Array.from({ length: EXPENSE_RULES_PER_USER_MAX + 1 }, () => ({
      matchType: 'regex' as const,
      pattern: '(a)\\1',
    }));

    const err = await refusal(() =>
      service(stubRules()).restoreRules(USER, document, { insertRules }),
    );

    expect(err.code).toBe('EXPENSE_RULE_LIMIT_REACHED');
    expect(isSupportedExpenseRuleRegex).not.toHaveBeenCalled();
    expect(insertRules).not.toHaveBeenCalled();
  });

  it('refuses an over-long pattern before the regex engine is asked', async () => {
    const insertRules = vi.fn(async () => {});

    const err = await refusal(() =>
      service(stubRules()).restoreRules(
        USER,
        [{ matchType: 'regex' as const, pattern: 'a'.repeat(EXPENSE_RULE_PATTERN_MAX + 1) }],
        { insertRules },
      ),
    );

    expect(err.code).toBe('EXPENSE_RULE_PATTERN_TOO_LONG');
    expect(err.statusCode).toBe(400);
    expect(isSupportedExpenseRuleRegex).not.toHaveBeenCalled();
    expect(insertRules).not.toHaveBeenCalled();
  });

  it('accepts a pattern landing exactly ON the ceiling', async () => {
    const insertRules = vi.fn(async () => {});

    await service(stubRules()).restoreRules(
      USER,
      [{ matchType: 'contains' as const, pattern: 'a'.repeat(EXPENSE_RULE_PATTERN_MAX) }],
      { insertRules },
    );

    expect(insertRules).toHaveBeenCalledTimes(1);
  });
});

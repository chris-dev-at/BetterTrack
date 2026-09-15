import { describe, expect, it, vi } from 'vitest';

import type {
  ExpenseCategoryRepository,
  ExpenseRuleRepository,
  ExpenseTransactionRepository,
} from '../../../data/repositories/expenseRepository';
import { ApiError } from '../../../errors';
import { CASH_RULES_PER_USER_MAX } from '../../cash/cashTagService';
import { EXPENSE_RULES_PER_USER_MAX, createExpenseService } from '../expenseService';

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

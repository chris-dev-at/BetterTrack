import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { CASH_SYSTEM_TAGS } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import {
  CASH_FUSION_MIGRATION_WHEN,
  CASH_FUSION_TAG,
  createCashFusionCatchUpRepository,
} from '../data/repositories/cashFusionCatchUpRepository';
import { createCashSourceRepository } from '../data/repositories/cashSourceRepository';
import { catchUpCashFusion, parseCatchUpArgs } from '../scripts/catchUpCashFusion';
import {
  MICROS_PER_CENT,
  centsToNumericText,
  freeSpendingName,
  fusionUuid,
  parseCents,
  parseMicros,
  planIsEmpty,
  planOwnerCatchUp,
  spendingPortfolioId,
  spendingSourceId,
  systemTagId,
  type OwnerSnapshot,
} from '../scripts/cashFusionCatchUpCore';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * V5 cash fusion, phase 2 — the catch-up sync (`scripts/catchUpCashFusion.ts`).
 *
 * Migration 0076 moved every `expense_*` row onto the portfolio cash ledger and
 * then left `/api/v1/expenses` writable, so rows written after that deploy are a
 * fused-table gap. These tests pin the three properties the script has to have:
 * it reproduces 0076's rules EXACTLY (same derived ids, same sign, same
 * case-collapse, same budget merge), it reconciles to the cent or writes nothing,
 * and it is idempotent.
 */

/** A stand-in "0076 ran here" instant, well before anything a test creates. */
const FUSION_AT = new Date('2026-01-15T10:00:00.000Z');
/** Before {@link FUSION_AT} — a row 0076 would have migrated. */
const PRE_FUSION = new Date('2026-01-10T09:00:00.000Z');
/** After {@link FUSION_AT} — a row written through the old routes since. */
const POST_FUSION = new Date('2026-02-02T09:00:00.000Z');

const USER_A = '2b1f0c9e-1111-4222-8333-444455556666';

// ── Pure core ────────────────────────────────────────────────────────────────

/** A snapshot with nothing in it, to be spread over per-test. */
function emptySnapshot(userId = USER_A): OwnerSnapshot {
  return {
    userId,
    portfolioNames: [],
    maxSortOrder: 0,
    spendingPortfolioExists: false,
    spendingSourceExists: false,
    categories: [],
    transactions: [],
    budgets: [],
    fires: [],
    rules: [],
    existingTags: [],
    existingMovements: [],
    existingBudgets: [],
    existingFires: [],
    existingRuleIds: [],
  };
}

function category(id: string, name: string, createdAt = POST_FUSION) {
  return { id, name, color: '#112233', createdAt, updatedAt: createdAt };
}

function transaction(
  id: string,
  overrides: Partial<OwnerSnapshot['transactions'][number]> = {},
): OwnerSnapshot['transactions'][number] {
  return {
    id,
    categoryId: null,
    direction: 'expense',
    amount: '10.00',
    currency: 'EUR',
    bookedOn: '2026-02-01',
    description: 'REWE Wien',
    source: 'manual',
    dedupHash: null,
    createdAt: POST_FUSION,
    ...overrides,
  };
}

describe('cash-fusion catch-up: exact money', () => {
  it('parses and re-renders numeric(20,2) as integer cents', () => {
    expect(parseCents('10.00')).toBe(1000);
    expect(parseCents('0.01')).toBe(1);
    expect(parseCents('-12.34')).toBe(-1234);
    expect(parseCents('7')).toBe(700);
    expect(parseCents('7.5')).toBe(750);
    expect(centsToNumericText(-1234)).toBe('-12.34');
    expect(centsToNumericText(1)).toBe('0.01');
    expect(centsToNumericText(0)).toBe('0.00');
    expect(centsToNumericText(-5)).toBe('-0.05');
  });

  it('refuses anything that is not an exact 2dp decimal', () => {
    expect(() => parseCents('10.001')).toThrow();
    expect(() => parseCents('abc')).toThrow();
    expect(() => parseCents('')).toThrow();
  });

  it('never routes a cent total through a float', () => {
    // 0.1 + 0.2 in cents is exactly 30; as floats it is 0.30000000000000004.
    expect(parseCents('0.10') + parseCents('0.20')).toBe(30);
    expect(centsToNumericText(parseCents('0.10') + parseCents('0.20'))).toBe('0.30');
  });
});

describe('cash-fusion catch-up: 0076 rules, reproduced', () => {
  it('maps direction to kind and sign the way 0076 did', () => {
    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        transactions: [
          transaction('11111111-1111-4111-8111-111111111111', {
            direction: 'expense',
            amount: '12.34',
          }),
          transaction('22222222-2222-4222-8222-222222222222', {
            direction: 'income',
            amount: '2500.00',
          }),
        ],
      },
      FUSION_AT,
    );

    const [spend, salary] = plan.movements;
    expect(spend).toMatchObject({ kind: 'withdrawal', amountEur: '-12.34' });
    expect(salary).toMatchObject({ kind: 'deposit', amountEur: '2500.00' });
    // The signed sum is what the reconciliation proves against the source rows.
    expect(plan.reconciliation).toEqual({ expectedMovements: 2, expectedNetCents: 250_000 - 1234 });
  });

  it('books booked_on at UTC midnight', () => {
    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        transactions: [
          transaction('11111111-1111-4111-8111-111111111111', { bookedOn: '2026-03-09' }),
        ],
      },
      FUSION_AT,
    );
    expect(plan.movements[0]!.executedAt.toISOString()).toBe('2026-03-09T00:00:00.000Z');
  });

  it('carries a non-EUR magnitude 1:1 and records its currency', () => {
    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        transactions: [
          transaction('11111111-1111-4111-8111-111111111111', {
            amount: '80.00',
            currency: 'chf',
          }),
          transaction('22222222-2222-4222-8222-222222222222', { amount: '80.00', currency: 'EUR' }),
        ],
      },
      FUSION_AT,
    );
    // No historical rate is invented: the magnitude is exactly what the user was
    // always shown, and `original_currency` is the marker a later FX pass finds.
    expect(plan.movements[0]).toMatchObject({ amountEur: '-80.00', originalCurrency: 'CHF' });
    expect(plan.movements[1]!.originalCurrency).toBeNull();
  });

  it('borrows every primary key from its source row', () => {
    const txId = '11111111-1111-4111-8111-111111111111';
    const catId = '33333333-3333-4333-8333-333333333333';
    const budgetId = '44444444-4444-4444-8444-444444444444';
    const ruleId = '55555555-5555-4555-8555-555555555555';
    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        categories: [category(catId, 'Food')],
        transactions: [transaction(txId, { categoryId: catId })],
        budgets: [
          {
            id: budgetId,
            categoryId: catId,
            amount: '400.00',
            currency: 'EUR',
            createdAt: POST_FUSION,
            updatedAt: POST_FUSION,
          },
        ],
        rules: [
          {
            id: ruleId,
            categoryId: catId,
            matchType: 'contains',
            pattern: 'REWE',
            priority: 0,
            enabled: true,
            createdAt: POST_FUSION,
            updatedAt: POST_FUSION,
          },
        ],
      },
      FUSION_AT,
    );

    expect(plan.movements[0]!.id).toBe(txId);
    expect(plan.tags.find((tag) => !tag.system)!.id).toBe(catId);
    expect(plan.budgets[0]!.id).toBe(budgetId);
    expect(plan.rules[0]!.id).toBe(ruleId);
    expect(plan.movementTags).toEqual([{ movementId: txId, tagId: catId }]);
    expect(plan.ruleTags).toEqual([{ ruleId, tagId: catId }]);
    // The Spending portfolio and its Main source are derived, not random.
    expect(plan.portfolioId).toBe(spendingPortfolioId(USER_A));
    expect(plan.sourceId).toBe(spendingSourceId(USER_A));
  });

  it('collapses case-colliding categories onto one tag, oldest first', () => {
    const older = '33333333-3333-4333-8333-333333333333';
    const newer = '44444444-4444-4444-8444-444444444444';
    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        categories: [
          category(newer, 'food', new Date('2026-03-01T00:00:00.000Z')),
          category(older, 'Food', new Date('2026-02-01T00:00:00.000Z')),
        ],
        transactions: [
          transaction('11111111-1111-4111-8111-111111111111', { categoryId: older }),
          transaction('22222222-2222-4222-8222-222222222222', { categoryId: newer }),
        ],
      },
      FUSION_AT,
    );

    const userTags = plan.tags.filter((tag) => !tag.system);
    expect(userTags).toHaveLength(1);
    expect(userTags[0]).toMatchObject({ id: older, name: 'Food' });
    // Both movements resolve onto the surviving tag — no row loses its label.
    expect(plan.movementTags.map((link) => link.tagId)).toEqual([older, older]);
  });

  it('maps a category named like a system tag onto that system tag', () => {
    const catId = '33333333-3333-4333-8333-333333333333';
    const plan = planOwnerCatchUp(
      { ...emptySnapshot(), categories: [category(catId, 'dividend income')] },
      FUSION_AT,
    );
    // The system seed owns the name, so the category gets no tag of its own.
    expect(plan.tags.filter((tag) => !tag.system)).toHaveLength(0);
    const dividend = plan.tags.find((tag) => tag.systemKey === 'dividend')!;
    expect(dividend.id).toBe(systemTagId('dividend', USER_A));
  });

  it('seeds every system tag once and never twice', () => {
    const fresh = planOwnerCatchUp(emptySnapshot(), FUSION_AT);
    expect(fresh.tags.filter((tag) => tag.system)).toHaveLength(CASH_SYSTEM_TAGS.length);

    const seeded = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        existingTags: CASH_SYSTEM_TAGS.map((seed) => ({
          id: systemTagId(seed.key, USER_A),
          name: seed.name,
          system: true,
          systemKey: seed.key,
        })),
      },
      FUSION_AT,
    );
    expect(seeded.tags).toHaveLength(0);
  });

  it('keeps the larger ceiling when two budgets merge onto one tag', () => {
    const older = '33333333-3333-4333-8333-333333333333';
    const newer = '44444444-4444-4444-8444-444444444444';
    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        categories: [
          category(older, 'Food', new Date('2026-02-01T00:00:00.000Z')),
          category(newer, 'food', new Date('2026-03-01T00:00:00.000Z')),
        ],
        budgets: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            categoryId: older,
            amount: '200.00',
            currency: 'EUR',
            createdAt: POST_FUSION,
            updatedAt: POST_FUSION,
          },
          {
            id: '66666666-6666-4666-8666-666666666666',
            categoryId: newer,
            amount: '500.00',
            currency: 'EUR',
            createdAt: POST_FUSION,
            updatedAt: POST_FUSION,
          },
        ],
      },
      FUSION_AT,
    );
    // A budget is a ceiling; merging two labels must not silently tighten it.
    expect(plan.budgets).toHaveLength(1);
    expect(plan.budgets[0]).toMatchObject({ amount: '500.00', periodKey: null, tagId: older });
  });

  it('carries a fire only when its budget landed under the same id', () => {
    const catId = '33333333-3333-4333-8333-333333333333';
    const budgetId = '55555555-5555-4555-8555-555555555555';
    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        categories: [category(catId, 'Food')],
        budgets: [
          {
            id: budgetId,
            categoryId: catId,
            amount: '400.00',
            currency: 'EUR',
            createdAt: POST_FUSION,
            updatedAt: POST_FUSION,
          },
        ],
        fires: [
          {
            id: 'aaaaaaaa-1111-4111-8111-111111111111',
            budgetId,
            periodKey: '2026-02',
            firedAt: POST_FUSION,
          },
          {
            id: 'bbbbbbbb-2222-4222-8222-222222222222',
            budgetId: '99999999-9999-4999-8999-999999999999',
            periodKey: '2026-02',
            firedAt: POST_FUSION,
          },
        ],
      },
      FUSION_AT,
    );
    // Without the marker, re-pointing notifications at cash_budget_fires would
    // re-alert a month that has already fired.
    expect(plan.fires.map((fire) => fire.budgetId)).toEqual([budgetId]);
  });

  it('skips a fire whose period is already marked on the fused side', () => {
    const catId = '33333333-3333-4333-8333-333333333333';
    const budgetId = '55555555-5555-4555-8555-555555555555';
    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        categories: [category(catId, 'Food')],
        existingBudgets: [{ id: budgetId, tagId: catId, periodKey: null }],
        existingFires: [{ budgetId, periodKey: '2026-02' }],
        budgets: [
          {
            id: budgetId,
            categoryId: catId,
            amount: '400.00',
            currency: 'EUR',
            createdAt: POST_FUSION,
            updatedAt: POST_FUSION,
          },
        ],
        fires: [
          {
            id: 'aaaaaaaa-1111-4111-8111-111111111111',
            budgetId,
            periodKey: '2026-02',
            firedAt: POST_FUSION,
          },
        ],
      },
      FUSION_AT,
    );
    expect(plan.fires).toHaveLength(0);
    expect(plan.budgets).toHaveLength(0);
  });
});

describe('cash-fusion catch-up: what it refuses to do', () => {
  it('reports a pre-fusion row with no counterpart instead of resurrecting it', () => {
    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        transactions: [
          transaction('11111111-1111-4111-8111-111111111111', { createdAt: PRE_FUSION }),
          transaction('22222222-2222-4222-8222-222222222222', { createdAt: POST_FUSION }),
        ],
      },
      FUSION_AT,
    );
    // 0076 already migrated the pre-fusion row; its absence means the user
    // deleted the fused copy, and re-inserting it would resurrect that.
    expect(plan.movements.map((movement) => movement.id)).toEqual([
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(plan.orphanedPreFusion).toBe(1);
    // The excluded row is excluded from the proof too, or it could never pass.
    expect(plan.reconciliation.expectedMovements).toBe(1);
  });

  it('labels an untagged fused movement but never rewrites a tagged one', () => {
    const catId = '33333333-3333-4333-8333-333333333333';
    const untagged = '11111111-1111-4111-8111-111111111111';
    const tagged = '22222222-2222-4222-8222-222222222222';
    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        categories: [category(catId, 'Food', PRE_FUSION)],
        existingTags: [{ id: catId, name: 'Food', system: false, systemKey: null }],
        transactions: [
          transaction(untagged, { categoryId: catId, createdAt: PRE_FUSION, amount: '5.00' }),
          transaction(tagged, { categoryId: catId, createdAt: PRE_FUSION, amount: '6.00' }),
        ],
        existingMovements: [
          { id: untagged, amountEur: '-5.00', tagIds: [] },
          // Deliberately labelled with something else after the fusion.
          { id: tagged, amountEur: '-6.00', tagIds: ['77777777-7777-4777-8777-777777777777'] },
        ],
      },
      FUSION_AT,
    );

    // Purely additive: nothing to clobber on the untagged one.
    expect(plan.movements).toHaveLength(0);
    expect(plan.movementTags).toEqual([{ movementId: untagged, tagId: catId }]);
    // The tagged one may carry a deliberate retag; there is no timestamp to
    // arbitrate, so it is reported rather than overwritten.
    expect(plan.divergedTagLinks).toBe(1);
  });

  it('creates the Spending portfolio only when something must live in it', () => {
    const catId = '33333333-3333-4333-8333-333333333333';
    // Rules and tags are user-scoped: they need no portfolio at all.
    const rulesOnly = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        categories: [category(catId, 'Food')],
        rules: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            categoryId: catId,
            matchType: 'contains',
            pattern: 'REWE',
            priority: 0,
            enabled: true,
            createdAt: POST_FUSION,
            updatedAt: POST_FUSION,
          },
        ],
      },
      FUSION_AT,
    );
    expect(rulesOnly.createPortfolio).toBeNull();
    expect(rulesOnly.rules).toHaveLength(1);

    const withMoney = planOwnerCatchUp(
      { ...emptySnapshot(), transactions: [transaction('11111111-1111-4111-8111-111111111111')] },
      FUSION_AT,
    );
    expect(withMoney.createPortfolio).toMatchObject({
      id: spendingPortfolioId(USER_A),
      name: 'Spending',
      sortOrder: 1,
    });
    expect(withMoney.createSource).toMatchObject({ id: spendingSourceId(USER_A), name: 'Main' });
  });

  it('takes the first free Spending name and blocks rather than guessing', () => {
    expect(freeSpendingName([])).toBe('Spending');
    expect(freeSpendingName(['Spending'])).toBe('Spending 2');
    expect(freeSpendingName(['Spending', 'Spending 2'])).toBe('Spending 3');
    const allTaken = ['Spending', ...Array.from({ length: 63 }, (_, i) => `Spending ${i + 2}`)];
    expect(freeSpendingName(allTaken)).toBeNull();

    const plan = planOwnerCatchUp(
      {
        ...emptySnapshot(),
        portfolioNames: allTaken,
        transactions: [transaction('11111111-1111-4111-8111-111111111111')],
      },
      FUSION_AT,
    );
    expect(plan.blocked).toContain('Spending names are taken');
    // A blocked owner writes NOTHING — not even the tags that would be legal.
    expect(planIsEmpty(plan)).toBe(true);
  });

  it('plans nothing on a second pass over its own output (idempotent)', () => {
    const catId = '33333333-3333-4333-8333-333333333333';
    const txId = '11111111-1111-4111-8111-111111111111';
    const budgetId = '55555555-5555-4555-8555-555555555555';
    const ruleId = '66666666-6666-4666-8666-666666666666';
    const source: OwnerSnapshot = {
      ...emptySnapshot(),
      categories: [category(catId, 'Food')],
      transactions: [transaction(txId, { categoryId: catId, amount: '9.99' })],
      budgets: [
        {
          id: budgetId,
          categoryId: catId,
          amount: '400.00',
          currency: 'EUR',
          createdAt: POST_FUSION,
          updatedAt: POST_FUSION,
        },
      ],
      rules: [
        {
          id: ruleId,
          categoryId: catId,
          matchType: 'contains',
          pattern: 'REWE',
          priority: 0,
          enabled: true,
          createdAt: POST_FUSION,
          updatedAt: POST_FUSION,
        },
      ],
    };

    const first = planOwnerCatchUp(source, FUSION_AT);
    expect(planIsEmpty(first)).toBe(false);

    // Feed the first plan's output back in as the fused state.
    const second = planOwnerCatchUp(
      {
        ...source,
        spendingPortfolioExists: true,
        spendingSourceExists: true,
        portfolioNames: ['Spending'],
        existingTags: first.tags.map((tag) => ({
          id: tag.id,
          name: tag.name,
          system: tag.system,
          systemKey: tag.systemKey,
        })),
        existingMovements: first.movements.map((movement) => ({
          id: movement.id,
          amountEur: movement.amountEur,
          tagIds: first.movementTags
            .filter((link) => link.movementId === movement.id)
            .map((link) => link.tagId),
        })),
        existingBudgets: first.budgets.map((budget) => ({
          id: budget.id,
          tagId: budget.tagId,
          periodKey: budget.periodKey,
        })),
        existingRuleIds: first.rules.map((rule) => rule.id),
      },
      FUSION_AT,
    );
    expect(planIsEmpty(second)).toBe(true);
    expect(second.divergedTagLinks).toBe(0);
    // The proof still holds on the second pass: the row is fused and counted.
    expect(second.reconciliation).toEqual({ expectedMovements: 1, expectedNetCents: -999 });
  });
});

describe('cash-fusion catch-up: preconditions', () => {
  it('refuses to run at all when the fusion migration is not applied', async () => {
    // Catching up to a migration that never ran would mean inventing the state it
    // was supposed to establish, so this is a hard stop rather than a warning.
    const repository = {
      fusionAppliedAt: async () => null,
      listOwners: async () => {
        throw new Error('must not be reached');
      },
      loadOwner: async () => {
        throw new Error('must not be reached');
      },
      applyOwnerPlan: async () => {
        throw new Error('must not be reached');
      },
    };
    await expect(catchUpCashFusion({ dryRun: true, repository })).rejects.toThrow(
      /has not been applied/,
    );
  });
});

describe('cash-fusion catch-up: CLI', () => {
  it('demands exactly one of --dry-run / --apply', () => {
    expect(parseCatchUpArgs(['node', 'x', '--dry-run'])).toEqual({ dryRun: true });
    expect(parseCatchUpArgs(['node', 'x', '--apply'])).toEqual({ dryRun: false });
    expect(() => parseCatchUpArgs(['node', 'x'])).toThrow();
    expect(() => parseCatchUpArgs(['node', 'x', '--dry-run', '--apply'])).toThrow();
    expect(() => parseCatchUpArgs(['node', 'x', '--apply', '--force'])).toThrow();
  });
});

// ── Against a real database ──────────────────────────────────────────────────

describe('cash-fusion catch-up: against the database', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestApp();
  });

  /**
   * One owner's worth of expense rows dated AFTER the fusion — the divergence the
   * catch-up exists to close. Seeded directly because `/api/v1/expenses` writes
   * are retired (410) as of this phase, so the API can no longer produce them.
   */
  async function seedPostFusionExpenseRows(
    userId: string,
  ): Promise<{ categoryId: string; budgetId: string; ruleId: string }> {
    const [category] = await h.db
      .insert(schema.expenseCategories)
      .values({
        userId,
        name: 'Groceries',
        direction: 'expense',
        color: '#aabbcc',
        createdAt: POST_FUSION,
        updatedAt: POST_FUSION,
      })
      .returning({ id: schema.expenseCategories.id });
    const categoryId = category!.id;

    await h.db.insert(schema.expenseTransactions).values([
      {
        userId,
        categoryId,
        direction: 'expense',
        amount: '12.34',
        currency: 'EUR',
        bookedOn: '2026-02-03',
        description: 'REWE Wien',
        source: 'manual',
        createdAt: POST_FUSION,
        updatedAt: POST_FUSION,
      },
      {
        userId,
        categoryId,
        direction: 'expense',
        amount: '7.50',
        currency: 'EUR',
        bookedOn: '2026-02-04',
        description: 'BILLA',
        source: 'manual',
        createdAt: POST_FUSION,
        updatedAt: POST_FUSION,
      },
      {
        userId,
        categoryId: null,
        direction: 'income',
        amount: '2500.00',
        currency: 'EUR',
        bookedOn: '2026-02-01',
        description: 'Salary',
        source: 'manual',
        createdAt: POST_FUSION,
        updatedAt: POST_FUSION,
      },
    ]);

    const [budget] = await h.db
      .insert(schema.expenseBudgets)
      .values({
        userId,
        categoryId,
        amount: '400.00',
        currency: 'EUR',
        createdAt: POST_FUSION,
        updatedAt: POST_FUSION,
      })
      .returning({ id: schema.expenseBudgets.id });

    const [rule] = await h.db
      .insert(schema.expenseRules)
      .values({
        userId,
        categoryId,
        matchType: 'contains',
        pattern: 'REWE',
        priority: 0,
        enabled: true,
        createdAt: POST_FUSION,
        updatedAt: POST_FUSION,
      })
      .returning({ id: schema.expenseRules.id });

    return { categoryId, budgetId: budget!.id, ruleId: rule!.id };
  }

  /** Pretend 0076 ran at {@link FUSION_AT} by dating the system tags it seeded. */
  async function simulateFusionRan(userId: string): Promise<void> {
    await h.db.insert(schema.cashTags).values(
      CASH_SYSTEM_TAGS.map((seed) => ({
        id: systemTagId(seed.key, userId),
        userId,
        name: seed.name,
        color: seed.color,
        system: true,
        systemKey: seed.key,
        createdAt: FUSION_AT,
        updatedAt: FUSION_AT,
      })),
    );
  }

  it('ports bt_cash_fusion_uuid exactly', async () => {
    // The SQL function 0076 used, verbatim from the migration. If the TypeScript
    // twin ever disagrees the catch-up would mint a SECOND Spending portfolio
    // beside the one 0076 created, so this is pinned rather than trusted.
    await h.db.execute(sql`
      CREATE FUNCTION "bt_probe_fusion_uuid"(seed text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
        SELECT (
          overlay(
            overlay(md5(seed) placing '5' from 13 for 1)
            placing substr('89ab', (('x' || substr(md5(seed), 17, 1))::bit(4)::int % 4) + 1, 1) from 17 for 1
          )
        )::uuid
      $$
    `);
    const seeds = [
      `bettertrack:v5-cash-fusion:spending-portfolio:${USER_A}`,
      `bettertrack:v5-cash-fusion:spending-main-source:${USER_A}`,
      ...CASH_SYSTEM_TAGS.map(
        (seed) => `bettertrack:v5-cash-fusion:system-tag:${seed.key}:${USER_A}`,
      ),
      'a',
      '',
    ];
    for (const seed of seeds) {
      const out = (await h.db.execute(
        sql`SELECT "bt_probe_fusion_uuid"(${seed}) AS id`,
      )) as unknown as { rows: { id: string }[] };
      expect(fusionUuid(seed)).toBe(out.rows[0]!.id);
    }
  });

  it('pins the fusion migration constant to the journal', () => {
    const journalPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../drizzle/meta/_journal.json',
    );
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    const entry = journal.entries.find((row) => row.tag === CASH_FUSION_TAG);
    expect(entry).toBeDefined();
    // Drift here would make the "has the fusion been applied" guard answer about
    // the wrong migration.
    expect(entry!.when).toBe(CASH_FUSION_MIGRATION_WHEN);
  });

  it('reports the real migration as applied', async () => {
    // The guard reads `drizzle.__drizzle_migrations`, which `createTestApp` does
    // NOT truncate (only `public` tables), so this asserts against the live table
    // rather than mutating it — a DELETE here would poison every later test in
    // the worker, since the PGlite instance is a per-worker singleton.
    const repository = createCashFusionCatchUpRepository(h.db);
    await expect(repository.fusionAppliedAt()).resolves.toBeInstanceOf(Date);
  });

  it('reads the fusion instant off the system tags 0076 seeded', async () => {
    const user = await h.seedUser();
    await simulateFusionRan(user.id);
    const repository = createCashFusionCatchUpRepository(h.db);
    expect((await repository.fusionAppliedAt())?.toISOString()).toBe(FUSION_AT.toISOString());
  });

  it('migrates rows written through /expenses after the fusion, and reconciles', async () => {
    const user = await h.seedUser();
    await simulateFusionRan(user.id);

    // Rows as the OLD routes left them: written after the fusion, before those
    // routes were retired. Seeded straight into the tables because `/expenses`
    // writes are now 410 — which is exactly the state the catch-up runs in.
    const { categoryId, budgetId, ruleId } = await seedPostFusionExpenseRows(user.id);

    const repository = createCashFusionCatchUpRepository(h.db);

    // ── dry run writes nothing ────────────────────────────────────────────────
    const dry = await catchUpCashFusion({ dryRun: true, repository });
    expect(dry.mode).toBe('dry-run');
    expect(dry.applied).toBe(0);
    expect(dry.totals.movements).toBe(3);
    expect(dry.totals.budgets).toBe(1);
    expect(dry.totals.rules).toBe(1);
    // 2500.00 in − 12.34 − 7.50 out.
    expect(dry.netEur).toBe('2480.16');
    const afterDry = await h.db
      .select({ id: schema.portfolioCashMovements.id })
      .from(schema.portfolioCashMovements);
    expect(afterDry).toHaveLength(0);

    // ── apply ─────────────────────────────────────────────────────────────────
    const applied = await catchUpCashFusion({ dryRun: false, repository });
    expect(applied.ownerReports.filter((entry) => entry.error !== null)).toEqual([]);
    expect(applied.failed).toBe(0);
    expect(applied.blocked).toBe(0);
    expect(applied.applied).toBe(1);

    const portfolioId = spendingPortfolioId(user.id);
    const spending = await h.db
      .select({ id: schema.portfolios.id, name: schema.portfolios.name })
      .from(schema.portfolios)
      .where(and(eq(schema.portfolios.id, portfolioId), eq(schema.portfolios.userId, user.id)));
    expect(spending).toHaveLength(1);
    expect(spending[0]!.name).toBe('Spending');

    const movements = await h.db
      .select({
        id: schema.portfolioCashMovements.id,
        kind: schema.portfolioCashMovements.kind,
        amountEur: schema.portfolioCashMovements.amountEur,
        executedAt: schema.portfolioCashMovements.executedAt,
        note: schema.portfolioCashMovements.note,
        sourceId: schema.portfolioCashMovements.sourceId,
      })
      .from(schema.portfolioCashMovements)
      .where(eq(schema.portfolioCashMovements.portfolioId, portfolioId));
    expect(movements).toHaveLength(3);
    expect(movements.every((row) => row.sourceId === spendingSourceId(user.id))).toBe(true);

    // The money reconciles to the cent against the source rows.
    const sourceRows = await h.db
      .select({
        id: schema.expenseTransactions.id,
        amount: schema.expenseTransactions.amount,
        direction: schema.expenseTransactions.direction,
      })
      .from(schema.expenseTransactions)
      .where(eq(schema.expenseTransactions.userId, user.id));
    const expectedMicros =
      sourceRows.reduce(
        (net, row) =>
          net + (row.direction === 'income' ? parseCents(row.amount) : -parseCents(row.amount)),
        0,
      ) * MICROS_PER_CENT;
    // The ledger column is numeric(20,6), so it reads back as micros; scaling the
    // 2dp source side up is what makes the comparison exact in both directions.
    const fusedMicros = movements.reduce((net, row) => net + parseMicros(row.amountEur), 0);
    expect(fusedMicros).toBe(expectedMicros);
    expect(fusedMicros).toBe(2_480_160_000);
    // Ids are borrowed, so the two sides are the same rows and not merely equal sums.
    expect(new Set(movements.map((row) => row.id))).toEqual(
      new Set(sourceRows.map((row) => row.id)),
    );

    const spend = movements.find((row) => row.note === 'REWE Wien')!;
    expect(spend.kind).toBe('withdrawal');
    expect(parseMicros(spend.amountEur)).toBe(-12_340_000);
    expect(spend.executedAt.toISOString()).toBe('2026-02-03T00:00:00.000Z');

    // Tags, budget and rule came across; the income row stays untagged.
    const links = await h.db
      .select({
        movementId: schema.cashMovementTags.movementId,
        tagId: schema.cashMovementTags.tagId,
      })
      .from(schema.cashMovementTags);
    expect(links).toHaveLength(2);
    expect(new Set(links.map((row) => row.tagId))).toEqual(new Set([categoryId]));

    const budgets = await h.db
      .select({
        id: schema.cashBudgets.id,
        tagId: schema.cashBudgets.tagId,
        periodKey: schema.cashBudgets.periodKey,
        amount: schema.cashBudgets.amount,
      })
      .from(schema.cashBudgets)
      .where(eq(schema.cashBudgets.portfolioId, portfolioId));
    // `period_key` NULL is the RECURRING target expense_budgets always was.
    expect(budgets).toEqual([
      { id: budgetId, tagId: categoryId, periodKey: null, amount: '400.00' },
    ]);

    const ruleTags = await h.db
      .select({ ruleId: schema.cashRuleTags.ruleId, tagId: schema.cashRuleTags.tagId })
      .from(schema.cashRuleTags);
    expect(ruleTags).toEqual([{ ruleId, tagId: categoryId }]);

    // ── re-run changes nothing ────────────────────────────────────────────────
    const again = await catchUpCashFusion({ dryRun: false, repository });
    expect(again.applied).toBe(0);
    expect(again.totals.movements).toBe(0);
    expect(again.totals.tags).toBe(0);
    expect(again.failed).toBe(0);
    const afterRerun = await h.db
      .select({ id: schema.portfolioCashMovements.id })
      .from(schema.portfolioCashMovements);
    expect(afterRerun).toHaveLength(3);
    const portfolios = await h.db
      .select({ id: schema.portfolios.id })
      .from(schema.portfolios)
      .where(eq(schema.portfolios.userId, user.id));
    // Critically: no SECOND Spending portfolio.
    expect(portfolios.filter((row) => row.id === portfolioId)).toHaveLength(1);
  });

  it('rolls an owner back when the fused rows do not reconcile', async () => {
    const owner = await h.seedUser({ email: 'owner@bettertrack.test', username: 'owner' });
    const stranger = await h.seedUser({
      email: 'stranger@bettertrack.test',
      username: 'stranger',
    });
    await simulateFusionRan(owner.id);

    const [row] = await h.db
      .insert(schema.expenseTransactions)
      .values({
        userId: owner.id,
        direction: 'expense',
        amount: '25.00',
        currency: 'EUR',
        bookedOn: '2026-02-05',
        description: 'Rent',
        source: 'manual',
        createdAt: POST_FUSION,
        updatedAt: POST_FUSION,
      })
      .returning({ id: schema.expenseTransactions.id });
    const transactionId = row!.id;

    // Plant the movement in the STRANGER's portfolio under the borrowed id. The
    // reconciliation joins `portfolios.user_id`, so this row can never pass as a
    // successful migration — it must fail the owner rather than count.
    const [strangerPortfolio] = await h.db
      .insert(schema.portfolios)
      .values({ userId: stranger.id, name: 'Stranger book', sortOrder: 1 })
      .returning({ id: schema.portfolios.id });
    const strangerSource = await createCashSourceRepository(h.db).getOrCreateMain(
      strangerPortfolio!.id,
    );
    await h.db.insert(schema.portfolioCashMovements).values({
      id: transactionId,
      portfolioId: strangerPortfolio!.id,
      sourceId: strangerSource.id,
      kind: 'withdrawal',
      amountEur: '-25.00',
      executedAt: new Date('2026-02-05T00:00:00.000Z'),
      note: 'Rent',
      source: 'manual',
    });

    const repository = createCashFusionCatchUpRepository(h.db);
    const report = await catchUpCashFusion({ dryRun: false, repository });
    expect(report.failed).toBe(1);
    const failure = report.ownerReports.find((entry) => entry.userId === owner.id)!;
    expect(failure.applied).toBe(false);
    expect(failure.error).toMatch(/does not reconcile/);

    // Nothing landed for the owner — not the portfolio, not the tags.
    const ownerPortfolio = await h.db
      .select({ id: schema.portfolios.id })
      .from(schema.portfolios)
      .where(eq(schema.portfolios.id, spendingPortfolioId(owner.id)));
    expect(ownerPortfolio).toHaveLength(0);
  });
});

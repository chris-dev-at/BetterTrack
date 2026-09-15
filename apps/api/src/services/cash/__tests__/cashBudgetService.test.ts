import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CashBudgetRepository,
  CashBudgetWithTag,
} from '../../../data/repositories/cashBudgetRepository';
import type { CashSummaryRepository } from '../../../data/repositories/cashSummaryRepository';
import type { CashTagRepository } from '../../../data/repositories/cashTagRepository';
import type { PortfolioRepository } from '../../../data/repositories/portfolioRepository';
import type { NotificationCenter } from '../../notifications/notificationCenter';
import { createCashBudgetService, type CashBudgetService } from '../cashBudgetService';

/**
 * The evaluator's claim lifecycle, in isolation (#1754).
 *
 * The API-level guarantees — that a money write triggers evaluation at all, and
 * that it survives a failing notifier — are pinned end to end in
 * `__tests__/cashTagging.test.ts`. What is cheaper and sharper to pin here is
 * the state machine around `cash_budget_fires`, because each case needs a
 * different failure out of the notification centre:
 *
 *  - exactly once while the budget stays over,
 *  - RE-ARM ON FALLING UNDER: the claim is released when the overrun ends, so
 *    the next one in the same month alerts again,
 *  - a `false` AND a THROW out of `emit` both give the claim back,
 *  - every alert carries its claim's id, which is what lets the dispatcher
 *    dedupe per fire rather than per (budget, period).
 */

const PERIOD = '2026-07';
const NOW = new Date('2026-07-15T12:00:00.000Z');
const PORTFOLIO_ID = '11111111-1111-4111-8111-111111111111';
const TAG_ID = '22222222-2222-4222-8222-222222222222';
const BUDGET_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

function target(amount: string): CashBudgetWithTag {
  return {
    id: BUDGET_ID,
    portfolioId: PORTFOLIO_ID,
    tagId: TAG_ID,
    periodKey: null,
    amount,
    currency: 'EUR',
    createdAt: NOW,
    updatedAt: NOW,
    tagName: 'Food',
    tagColor: '#112233',
  };
}

interface Fixture {
  service: CashBudgetService;
  /** The in-memory `cash_budget_fires` table, keyed `budgetId:period`. */
  claims: Map<string, string>;
  /** The month's outflow for the budgeted tag — moved between evaluations. */
  spend: { eur: number };
  /** The target itself, so a test can raise it under the evaluator's feet. */
  budget: { amount: string };
  emit: ReturnType<typeof vi.fn>;
}

function makeFixture(options?: { emit?: NotificationCenter['emit'] }): Fixture {
  const claims = new Map<string, string>();
  const spend = { eur: 0 };
  const budget = { amount: '100.00' };
  let nextClaim = 0;

  const budgets = {
    effectiveTargets: async () => [target(budget.amount)],
    outflowByTag: async () => new Map([[TAG_ID, spend.eur]]),
    firedPeriods: async () =>
      new Set([...claims.keys()].map((key) => key.split(':')[0]!).filter(Boolean)),
    claimFire: async (budgetId: string, periodKey: string) => {
      const key = `${budgetId}:${periodKey}`;
      if (claims.has(key)) return null;
      nextClaim += 1;
      const id = `fire-${nextClaim}`;
      claims.set(key, id);
      return id;
    },
    releaseFire: async (budgetId: string, periodKey: string) => {
      claims.delete(`${budgetId}:${periodKey}`);
    },
  } as unknown as CashBudgetRepository;

  const emit = vi.fn(options?.emit ?? (async () => true));
  const service = createCashBudgetService({
    budgets,
    summaries: {} as unknown as CashSummaryRepository,
    tags: {} as unknown as Pick<CashTagRepository, 'findByIdForOwner'>,
    portfolios: {} as unknown as Pick<PortfolioRepository, 'findByIdForUser'>,
    notify: { emit } as unknown as NotificationCenter,
    now: () => NOW,
  });
  return { service, claims, spend, budget, emit };
}

let fx: Fixture;

beforeEach(() => {
  fx = makeFixture();
});

describe('cash budget evaluation: the fire claim', () => {
  it('alerts once however often the write path evaluates while it stays over', async () => {
    fx.spend.eur = 300;
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    fx.spend.eur = 900;
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);

    expect(fx.emit).toHaveBeenCalledTimes(1);
    expect(fx.claims.size).toBe(1);
  });

  it('does not alert a target that is only exactly met', async () => {
    fx.spend.eur = 100;
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    expect(fx.emit).not.toHaveBeenCalled();
    expect(fx.claims.size).toBe(0);
  });

  it('RE-ARMS on falling under: dropping back below the target alerts again later', async () => {
    fx.spend.eur = 250;
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    expect(fx.emit).toHaveBeenCalledTimes(1);

    // A mis-tagged €150 row is untagged: the month is back under its target, so
    // the claim no longer describes anything and is given back.
    fx.spend.eur = 100;
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    expect(fx.emit).toHaveBeenCalledTimes(1);
    expect(fx.claims.size).toBe(0);

    // …and the genuine overrun later in the SAME month alerts.
    fx.spend.eur = 600;
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    expect(fx.emit).toHaveBeenCalledTimes(2);

    // Each alert carries its own claim, which is what keeps the dispatcher from
    // deduping the second one against the first.
    const fireIds = fx.emit.mock.calls.map(([event]) => (event as { fireId?: string }).fireId);
    expect(new Set(fireIds).size).toBe(2);
    expect(fireIds.every((id) => typeof id === 'string')).toBe(true);
  });

  it('re-arms when the TARGET rises above the spend, not only when the spend drops', async () => {
    fx.spend.eur = 250;
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    expect(fx.emit).toHaveBeenCalledTimes(1);

    fx.budget.amount = '700.00';
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    expect(fx.claims.size).toBe(0);

    fx.spend.eur = 800;
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    expect(fx.emit).toHaveBeenCalledTimes(2);
  });

  it('gives the claim back when nothing durable accepted the alert', async () => {
    const nonDurable = makeFixture({ emit: async () => false });
    nonDurable.spend.eur = 300;
    await nonDurable.service.onCashWrite(USER_ID, PORTFOLIO_ID);

    expect(nonDurable.emit).toHaveBeenCalledTimes(1);
    // Otherwise a transport outage would silently consume the month's alert.
    expect(nonDurable.claims.size).toBe(0);
    await nonDurable.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    expect(nonDurable.emit).toHaveBeenCalledTimes(2);
  });

  it('gives the claim back when the notifier THROWS, exactly like a false return', async () => {
    const throwing = makeFixture({
      emit: async () => {
        throw new Error('transport exploded');
      },
    });
    throwing.spend.eur = 300;

    // The write path must not see it (a money write already committed).
    await expect(throwing.service.onCashWrite(USER_ID, PORTFOLIO_ID)).resolves.toBeUndefined();
    expect(throwing.claims.size).toBe(0);
  });

  it('keeps evaluate non-throwing when the repository itself fails', async () => {
    const broken = {
      effectiveTargets: async () => {
        throw new Error('db down');
      },
      outflowByTag: async () => new Map<string, number>(),
      firedPeriods: async () => new Set<string>(),
      claimFire: async () => null,
      releaseFire: async () => undefined,
    } as unknown as CashBudgetRepository;
    const service = createCashBudgetService({
      budgets: broken,
      summaries: {} as unknown as CashSummaryRepository,
      tags: {} as unknown as Pick<CashTagRepository, 'findByIdForOwner'>,
      portfolios: {} as unknown as Pick<PortfolioRepository, 'findByIdForUser'>,
      notify: { emit: async () => true } as unknown as NotificationCenter,
      now: () => NOW,
    });

    await expect(service.onCashWrite(USER_ID, PORTFOLIO_ID)).resolves.toBeUndefined();
    // The finalizer's entry point is the one that must stay durable.
    await expect(service.evaluateRequired(USER_ID, PORTFOLIO_ID)).rejects.toThrow('db down');
  });

  it('emits the period, the target and the spend the alert renders', async () => {
    fx.spend.eur = 300;
    await fx.service.onCashWrite(USER_ID, PORTFOLIO_ID);
    expect(fx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'budget.exceeded',
        userId: USER_ID,
        budgetId: BUDGET_ID,
        categoryId: TAG_ID,
        categoryName: 'Food',
        portfolioId: PORTFOLIO_ID,
        period: PERIOD,
        amount: 100,
        spent: 300,
        // One denomination: `spent` comes off `amount_eur`, and the contract
        // admits no other budget currency.
        currency: 'EUR',
      }),
    );
  });
});

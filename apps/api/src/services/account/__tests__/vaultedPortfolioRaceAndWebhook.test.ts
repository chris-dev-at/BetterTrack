import { describe, expect, it, vi } from 'vitest';

import type { DomainEvent } from '../../../events';
import { runIfParanoidOwnedSubjectAllowed, type ParanoidModeGuard } from '../paranoidEnforcement';
import {
  isVaultedPortfolioContentEventAllowed,
  type VaultedPortfolioSubject,
  type VaultedPortfolioWebhookSubjects,
} from '../vaultedPortfolioEnforcement';

// Deterministic TEST VECTOR identities. They are public fixture UUIDs, never
// credentials or encrypted-content material.
const VECTOR = {
  userId: '019c81a0-0000-7000-8000-000000000001',
  portfolioId: '019c81a0-0000-7000-8000-000000000002',
  vaultId: '019c81a0-0000-7000-8000-000000000003',
  assetId: '019c81a0-0000-7000-8000-000000000004',
  standingOrderId: '019c81a0-0000-7000-8000-000000000005',
  cashBudgetId: '019c81a0-0000-7000-8000-000000000006',
  legacyBudgetId: '019c81a0-0000-7000-8000-000000000007',
} as const;

const PLAIN: VaultedPortfolioSubject = {
  exists: true,
  userId: VECTOR.userId,
  vaultId: null,
};
const VAULTED: VaultedPortfolioSubject = {
  exists: true,
  userId: VECTOR.userId,
  vaultId: VECTOR.vaultId,
};

const passThroughGuard: Pick<ParanoidModeGuard, 'runAllowed'> = {
  runAllowed: async (_userId, _capability, action) => action(),
};

describe('portfolio subject transition serialization', () => {
  it('re-resolves after the account lock and skips a subject vaulted while waiting', async () => {
    const resolveSubject = vi
      .fn<() => Promise<VaultedPortfolioSubject>>()
      .mockResolvedValueOnce(PLAIN)
      .mockResolvedValueOnce(VAULTED);
    const action = vi.fn(async () => undefined);

    await expect(
      runIfParanoidOwnedSubjectAllowed(resolveSubject, passThroughGuard, 'portfolioJobs', action),
    ).resolves.toBe(false);
    expect(resolveSubject).toHaveBeenCalledTimes(2);
    expect(action).not.toHaveBeenCalled();
  });

  it('runs a stable plain sibling exactly once', async () => {
    const resolveSubject = vi.fn<() => Promise<VaultedPortfolioSubject>>().mockResolvedValue(PLAIN);
    const action = vi.fn(async () => undefined);

    await expect(
      runIfParanoidOwnedSubjectAllowed(resolveSubject, passThroughGuard, 'portfolioJobs', action),
    ).resolves.toBe(true);
    expect(resolveSubject).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledOnce();
  });
});

describe('stale subscribable webhook portfolio attribution', () => {
  const dividendEvent = {
    type: 'dividend.event',
    userId: VECTOR.userId,
    assetId: VECTOR.assetId,
    symbol: 'TVEC',
    exDate: '2026-09-01',
    payDate: null,
    amount: 1,
    currency: 'EUR',
    occurredAt: '2026-08-21T10:00:00.000Z',
  } satisfies DomainEvent;
  const standingEvent = {
    type: 'standing_order.skipped',
    userId: VECTOR.userId,
    standingOrderId: VECTOR.standingOrderId,
    periodKey: '2026-08-21',
    outcome: 'deferred',
    orderLabel: 'TEST VECTOR order',
    occurredAt: '2026-08-21T10:00:00.000Z',
  } satisfies DomainEvent;
  const budgetEvent = {
    type: 'budget.exceeded',
    userId: VECTOR.userId,
    budgetId: VECTOR.cashBudgetId,
    categoryId: '019c81a0-0000-7000-8000-000000000008',
    categoryName: 'TEST VECTOR category',
    period: '2026-08',
    amount: 100,
    spent: 101,
    currency: 'EUR',
    occurredAt: '2026-08-21T10:00:00.000Z',
  } satisfies DomainEvent;

  function subjects(overrides: Partial<VaultedPortfolioWebhookSubjects> = {}) {
    return {
      portfolioSubject: async () => PLAIN,
      standingOrderPortfolio: async () => PLAIN,
      cashBudgetPortfolio: async () => PLAIN,
      legacyExpenseBudgetExists: async () => false,
      userHasPlainHolding: async () => true,
      ...overrides,
    } satisfies VaultedPortfolioWebhookSubjects;
  }

  it('drops a dividend event with no plain holding and preserves a plain sibling holding', async () => {
    await expect(
      isVaultedPortfolioContentEventAllowed(
        dividendEvent,
        subjects({ userHasPlainHolding: async () => false }),
      ),
    ).resolves.toBe(false);
    await expect(isVaultedPortfolioContentEventAllowed(dividendEvent, subjects())).resolves.toBe(
      true,
    );
  });

  it('drops a standing-order event after its source becomes vaulted or disappears', async () => {
    await expect(
      isVaultedPortfolioContentEventAllowed(
        standingEvent,
        subjects({ standingOrderPortfolio: async () => VAULTED }),
      ),
    ).resolves.toBe(false);
    await expect(
      isVaultedPortfolioContentEventAllowed(
        standingEvent,
        subjects({
          standingOrderPortfolio: async () => ({
            exists: false,
            userId: null,
            vaultId: null,
          }),
        }),
      ),
    ).resolves.toBe(false);
    await expect(isVaultedPortfolioContentEventAllowed(standingEvent, subjects())).resolves.toBe(
      true,
    );
  });

  it('resolves a legacy budget id only through the account-common fallback', async () => {
    await expect(
      isVaultedPortfolioContentEventAllowed(
        budgetEvent,
        subjects({
          cashBudgetPortfolio: async () => ({ exists: false, userId: null, vaultId: null }),
          legacyExpenseBudgetExists: async (_userId, budgetId) =>
            budgetId === VECTOR.legacyBudgetId,
        }),
      ),
    ).resolves.toBe(false);

    await expect(
      isVaultedPortfolioContentEventAllowed(
        { ...budgetEvent, budgetId: VECTOR.legacyBudgetId },
        subjects({
          cashBudgetPortfolio: async () => ({ exists: false, userId: null, vaultId: null }),
          legacyExpenseBudgetExists: async (_userId, budgetId) =>
            budgetId === VECTOR.legacyBudgetId,
        }),
      ),
    ).resolves.toBe(true);
  });
});

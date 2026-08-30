import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';

import { cashBudgetsQueryKey } from './cashApi';

/**
 * #1370. `cashBudgetsQueryKey(portfolioId)` is the INVALIDATION PREFIX for every
 * month of one portfolio's budgets — budgets are read a month at a time, so a
 * create/edit/delete has to reach whichever month key the page is holding. The
 * key used to carry a trailing `undefined`, which prefix-matches nothing, and a
 * created budget therefore stayed behind `No budgets yet` until a reload.
 */
describe('cashBudgetsQueryKey', () => {
  test('the month-less form is a true prefix of a month key', () => {
    expect(cashBudgetsQueryKey('p1')).toEqual(['cash', 'budgets', 'p1']);
    expect(cashBudgetsQueryKey('p1', '2026-07')).toEqual(['cash', 'budgets', 'p1', '2026-07']);
  });

  test('invalidating it reaches every month of that portfolio and nothing else', async () => {
    const client = new QueryClient();
    const empty = { period: '2026-07', budgets: [] };
    client.setQueryData(cashBudgetsQueryKey('p1', '2026-07'), empty);
    client.setQueryData(cashBudgetsQueryKey('p1', '2026-08'), empty);
    client.setQueryData(cashBudgetsQueryKey('p2', '2026-07'), empty);

    await client.invalidateQueries({ queryKey: cashBudgetsQueryKey('p1') });

    const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    expect(invalidated(cashBudgetsQueryKey('p1', '2026-07'))).toBe(true);
    expect(invalidated(cashBudgetsQueryKey('p1', '2026-08'))).toBe(true);
    // A second portfolio's budgets are a different ledger — untouched.
    expect(invalidated(cashBudgetsQueryKey('p2', '2026-07'))).toBe(false);
  });
});

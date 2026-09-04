import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { CashBudgetProgress, CashTag } from '@bettertrack/contracts';

vi.mock('../../../lib/cashApi', async (importActual) => {
  const actual = await importActual<typeof import('../../../lib/cashApi')>();
  return {
    cashBudgetsQueryKey: actual.cashBudgetsQueryKey,
    createCashBudget: vi.fn(),
    updateCashBudget: vi.fn(),
  };
});

import { createCashBudget } from '../../../lib/cashApi';

import { CashBudgetDialog } from './CashBudgetDialog';

/**
 * The create dialog's TAG PICKER (#1754).
 *
 * `options` is recomputed per period mode — the recurring-taken and
 * this-month-taken tag sets are different — so the tag held in state can drop
 * out of the list when the mode is toggled. This is exercised straight against
 * the dialog rather than through `CashBudgetsPage`, whose coarse "any tag still
 * unbudgeted" gate would not even open it for the tag set that reproduces it.
 */

const FOOD: CashTag = {
  id: 't-food',
  name: 'Food',
  color: '#22c55e',
  system: false,
  systemKey: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const RENT: CashTag = { ...FOOD, id: 't-rent', name: 'Rent', color: '#3987e5' };

function budget(over: Partial<CashBudgetProgress> = {}): CashBudgetProgress {
  return {
    id: 'b1',
    portfolioId: 'p1',
    tagId: FOOD.id,
    tagName: FOOD.name,
    tagColor: FOOD.color,
    amount: 100,
    currency: 'EUR',
    period: '2026-07',
    recurring: true,
    spent: 60,
    remaining: 40,
    exceeded: false,
    ...over,
  };
}

/** Food holds the RECURRING target, Rent a THIS-MONTH one — each mode offers the other tag. */
const PARTIALLY_BUDGETED: CashBudgetProgress[] = [
  budget({ id: 'b-food', tagId: FOOD.id, tagName: FOOD.name, recurring: true }),
  budget({ id: 'b-rent', tagId: RENT.id, tagName: RENT.name, recurring: false }),
];

function renderDialog(budgets: CashBudgetProgress[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CashBudgetDialog
          budgets={budgets}
          month="2026-07"
          onClose={() => {}}
          portfolioId="p1"
          tags={[FOOD, RENT]}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function tagSelect(): HTMLSelectElement {
  return screen.getByLabelText<HTMLSelectElement>('Tag');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CashBudgetDialog', () => {
  test('keeps the selected tag inside the options when the period mode is toggled', async () => {
    const user = userEvent.setup();
    renderDialog(PARTIALLY_BUDGETED);

    // Recurring mode offers Rent only — Food's recurring target is taken.
    expect([...tagSelect().options].map((option) => option.value)).toEqual([RENT.id]);
    expect(tagSelect().value).toBe(RENT.id);

    await user.click(screen.getByRole('button', { name: 'This month only' }));

    // The option set flips to Food. The select must SHOW Food rather than
    // rendering blank while still holding Rent underneath.
    expect([...tagSelect().options].map((option) => option.value)).toEqual([FOOD.id]);
    expect(tagSelect().value).toBe(FOOD.id);
  });

  test('saves the tag the picker is showing, not the one the previous mode left behind', async () => {
    vi.mocked(createCashBudget).mockResolvedValue({
      budget: { ...budget(), id: 'b-new', period: '2026-07' } as never,
    });
    const user = userEvent.setup();
    renderDialog(PARTIALLY_BUDGETED);

    await user.click(screen.getByRole('button', { name: 'This month only' }));
    await user.type(screen.getByLabelText('Monthly target'), '150');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Posting Rent here would have been refused as "already budgeted" for a tag
    // the user was never shown.
    expect(createCashBudget).toHaveBeenCalledWith({
      portfolioId: 'p1',
      tagId: FOOD.id,
      period: '2026-07',
      amount: 150,
      currency: 'EUR',
    });
  });

  test('still refuses to save when the mode leaves no tag to pick', async () => {
    const user = userEvent.setup();
    // Both tags hold a recurring target, so recurring mode offers nothing.
    renderDialog([
      budget({ id: 'b-food', tagId: FOOD.id, tagName: FOOD.name, recurring: true }),
      budget({ id: 'b-rent', tagId: RENT.id, tagName: RENT.name, recurring: true }),
    ]);

    expect(tagSelect().value).toBe('');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    // …and the other mode is offerable again, with a real tag selected.
    await user.click(screen.getByRole('button', { name: 'This month only' }));
    expect(tagSelect().value).toBe(FOOD.id);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

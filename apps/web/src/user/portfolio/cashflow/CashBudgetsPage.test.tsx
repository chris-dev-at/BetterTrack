import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  CashBudgetListResponse,
  CashBudgetProgress,
  CashTag,
  PortfolioListResponse,
} from '@bettertrack/contracts';

vi.mock('../../../lib/portfolioApi');
// Only the REQUESTS are doubled. The query keys come from the real module on
// purpose: whether a create reaches the month query the page is holding is
// decided by that key builder, so a hand-written stand-in would prove the
// stand-in and hide #1370.
vi.mock('../../../lib/cashApi', async (importActual) => {
  const actual = await importActual<typeof import('../../../lib/cashApi')>();
  return {
    CASH_TAGS_QUERY_KEY: actual.CASH_TAGS_QUERY_KEY,
    cashBudgetsQueryKey: actual.cashBudgetsQueryKey,
    listCashTags: vi.fn(),
    listCashBudgets: vi.fn(),
    createCashBudget: vi.fn(),
    updateCashBudget: vi.fn(),
    deleteCashBudget: vi.fn(),
  };
});

import { listPortfolios } from '../../../lib/portfolioApi';
import {
  CASH_TAGS_QUERY_KEY,
  createCashBudget,
  deleteCashBudget,
  listCashBudgets,
  listCashTags,
  updateCashBudget,
} from '../../../lib/cashApi';
import { ApiError } from '../../../lib/apiClient';

import { CashBudgetsPage } from './CashBudgetsPage';
import { setViewportWidth } from '../../../test/viewport';

const PORTFOLIOS: PortfolioListResponse = {
  portfolios: [
    {
      id: 'p1',
      name: 'Main',
      visibility: 'private',
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

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

const EMPTY_BUDGETS: CashBudgetListResponse = { period: '2026-07', budgets: [] };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CashBudgetsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue(PORTFOLIOS);
  vi.mocked(listCashTags).mockResolvedValue({ tags: [FOOD, RENT] });
  vi.mocked(listCashBudgets).mockResolvedValue(EMPTY_BUDGETS);
});

describe('CashBudgetsPage', () => {
  test('390px keeps the month, budget actions and edit sheet inside the money surface', async () => {
    setViewportWidth(390);
    vi.mocked(listCashBudgets).mockResolvedValue({
      period: '2026-07',
      budgets: [budget()],
    });
    const user = userEvent.setup();
    renderPage();

    const food = await screen.findByText('Food');
    const surface = food.closest<HTMLElement>('.bt-money-surface');
    expect(surface).not.toBeNull();
    expect(within(surface!).getByLabelText('Month')).toBeInTheDocument();

    await user.click(within(surface!).getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Edit budget' })).toHaveClass(
      'bt-dialog__panel--phone-sheet',
    );
  });

  test('does not present a missing-tags prerequisite while tag data is unavailable', async () => {
    vi.mocked(listCashTags).mockRejectedValue(new Error('tags unavailable'));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Budgets' })).toBeInTheDocument();

    const newBudget = screen.getByRole('button', { name: 'New budget' });
    const addBudget = screen.getByRole('button', { name: 'Add a budget' });
    expect(newBudget).toBeDisabled();
    expect(addBudget).toBeDisabled();
    expect(newBudget.closest('[aria-describedby]')).toBeNull();
    expect(addBudget.closest('[aria-describedby]')).toBeNull();

    await user.hover(newBudget);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "You don't have any tags yet — create one on the “Labels & rules” page first.",
      ),
    ).not.toBeInTheDocument();
  });

  test('renders the exceeded state distinctly from an on-track budget', async () => {
    vi.mocked(listCashBudgets).mockResolvedValue({
      period: '2026-07',
      budgets: [
        budget({
          id: 'b-ok',
          tagName: 'Food',
          spent: 60,
          amount: 100,
          remaining: 40,
          exceeded: false,
        }),
        budget({
          id: 'b-over',
          tagId: RENT.id,
          tagName: 'Rent',
          spent: 120,
          amount: 100,
          remaining: -20,
          exceeded: true,
        }),
      ],
    });
    renderPage();

    await screen.findByText('Food');
    expect(screen.getByText('Over budget')).toBeInTheDocument();
    expect(screen.getByText('20,00 € over')).toBeInTheDocument();
    expect(screen.getByText('40,00 € left')).toBeInTheDocument();
  });

  test('distinguishes a recurring target from a this-month-only override', async () => {
    vi.mocked(listCashBudgets).mockResolvedValue({
      period: '2026-07',
      budgets: [
        budget({ id: 'b-rec', recurring: true, period: '2026-07' }),
        budget({
          id: 'b-once',
          tagId: RENT.id,
          tagName: 'Rent',
          recurring: false,
          period: '2026-07',
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText('Recurring')).toBeInTheDocument();
    expect(screen.getByText('2026-07 only')).toBeInTheDocument();
  });

  test('creates a recurring budget for an unbudgeted tag', async () => {
    vi.mocked(createCashBudget).mockResolvedValue({
      budget: { ...budget(), id: 'b-new' } as never,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New budget' }));
    const dialog = screen.getByRole('dialog', { name: 'New budget' });
    await user.selectOptions(within(dialog).getByLabelText('Tag'), FOOD.id);
    await user.type(within(dialog).getByLabelText('Monthly target'), '150');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(createCashBudget).toHaveBeenCalledWith({
      portfolioId: 'p1',
      tagId: FOOD.id,
      period: null,
      amount: 150,
      currency: 'EUR',
    });
  });

  test('a created budget replaces the empty state without a reload (#1370)', async () => {
    vi.mocked(createCashBudget).mockResolvedValue({
      budget: { ...budget(), id: 'b-new' } as never,
    });
    vi.mocked(listCashBudgets)
      .mockResolvedValueOnce(EMPTY_BUDGETS)
      .mockResolvedValue({ period: '2026-07', budgets: [budget({ id: 'b-new' })] });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('No budgets yet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New budget' }));
    const dialog = screen.getByRole('dialog', { name: 'New budget' });
    await user.selectOptions(within(dialog).getByLabelText('Tag'), FOOD.id);
    await user.type(within(dialog).getByLabelText('Monthly target'), '150');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    // The month query the page is holding refetched on its own: no navigation,
    // no month change, no reload.
    expect(await screen.findByText('Food')).toBeInTheDocument();
    expect(screen.queryByText('No budgets yet')).not.toBeInTheDocument();
  });

  test('edit and delete refresh the month the page is standing on (#1370)', async () => {
    vi.mocked(listCashBudgets)
      .mockResolvedValueOnce({ period: '2026-07', budgets: [budget()] })
      .mockResolvedValueOnce({ period: '2026-07', budgets: [budget({ amount: 200 })] })
      .mockResolvedValue(EMPTY_BUDGETS);
    vi.mocked(updateCashBudget).mockResolvedValue({
      budget: {
        id: 'b1',
        portfolioId: 'p1',
        tagId: FOOD.id,
        period: '2026-07',
        amount: 200,
        currency: 'EUR',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit budget' });
    const amountInput = within(dialog).getByLabelText('Monthly target');
    await user.clear(amountInput);
    await user.type(amountInput, '200');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(listCashBudgets).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('No budgets yet')).toBeInTheDocument();
  });

  test('edit retargets the amount only — tag and period are read-only', async () => {
    vi.mocked(listCashBudgets).mockResolvedValue({ period: '2026-07', budgets: [budget()] });
    vi.mocked(updateCashBudget).mockResolvedValue({
      budget: {
        id: 'b1',
        portfolioId: 'p1',
        tagId: FOOD.id,
        period: '2026-07',
        amount: 200,
        currency: 'EUR',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit budget' });
    expect(within(dialog).queryByLabelText('Tag')).not.toBeInTheDocument();
    const amountInput = within(dialog).getByLabelText('Monthly target');
    await user.clear(amountInput);
    await user.type(amountInput, '200');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(updateCashBudget).toHaveBeenCalledWith('b1', { amount: 200 });
  });

  test('surfaces the 409 duplicate-budget error inline', async () => {
    vi.mocked(createCashBudget).mockRejectedValue(
      new ApiError(409, 'CASH_BUDGET_EXISTS', 'exists'),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New budget' }));
    const dialog = screen.getByRole('dialog', { name: 'New budget' });
    await user.type(within(dialog).getByLabelText('Monthly target'), '50');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('That tag already has a budget for this period.'),
    ).toBeInTheDocument();
  });

  test('deletes a budget after confirmation', async () => {
    vi.mocked(listCashBudgets).mockResolvedValue({ period: '2026-07', budgets: [budget()] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(deleteCashBudget).toHaveBeenCalledWith('b1');
  });

  test('explains the budgeted-tag prerequisite on hover and focus, then enables creation when a tag is available', async () => {
    vi.mocked(listCashTags).mockResolvedValue({ tags: [FOOD] });
    vi.mocked(listCashBudgets).mockResolvedValue({
      period: '2026-07',
      // The progress endpoint returns the one effective target for this tag
      // and month, including when it is a month-only override.
      budgets: [budget({ id: 'b-month', recurring: false })],
    });
    const client = renderPage();
    const user = userEvent.setup();

    const newBudget = await screen.findByRole('button', { name: 'New budget' });
    expect(newBudget).toBeDisabled();

    await user.hover(newBudget);
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Every tag already has a budget for this period.',
    );

    await user.unhover(newBudget);
    const hint = screen.getByRole('group');
    hint.focus();
    expect(hint).toHaveFocus();
    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toHaveTextContent('Every tag already has a budget for this period.');
      expect(hint).toHaveAttribute('aria-describedby', tooltip.id);
    });

    client.setQueryData(CASH_TAGS_QUERY_KEY, { tags: [FOOD, RENT] });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New budget' })).toBeEnabled();
    });
  });

  test('does not present a missing-tags prerequisite while tags are loading', async () => {
    let resolveTags: (value: { tags: CashTag[] }) => void = () => undefined;
    const tagsPromise = new Promise<{ tags: CashTag[] }>((resolve) => {
      resolveTags = resolve;
    });
    vi.mocked(listCashTags).mockReturnValue(tagsPromise);
    const user = userEvent.setup();
    renderPage();

    const newBudget = await screen.findByRole('button', { name: 'New budget' });
    const addBudget = screen.getByRole('button', { name: 'Add a budget' });
    expect(newBudget).toBeDisabled();
    expect(addBudget).toBeDisabled();
    expect(newBudget.closest('[aria-describedby]')).toBeNull();
    expect(addBudget.closest('[aria-describedby]')).toBeNull();

    await user.hover(newBudget);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    resolveTags({ tags: [FOOD] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'New budget' })).toBeEnabled());
  });

  test('renders the empty state with a create CTA when nothing is budgeted', async () => {
    renderPage();

    expect(await screen.findByText('No budgets yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a budget' })).toBeInTheDocument();
  });

  test('names missing tags when empty-state budget actions are disabled', async () => {
    vi.mocked(listCashTags).mockResolvedValue({ tags: [] });
    const user = userEvent.setup();
    renderPage();

    const newBudget = await screen.findByRole('button', { name: 'New budget' });
    const addBudget = screen.getByRole('button', { name: 'Add a budget' });
    expect(newBudget).toBeDisabled();
    expect(addBudget).toBeDisabled();

    await user.hover(newBudget);
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      "You don't have any tags yet — create one on the “Labels & rules” page first.",
    );

    await user.unhover(newBudget);
    await user.hover(addBudget);
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      "You don't have any tags yet — create one on the “Labels & rules” page first.",
    );
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { CashTag } from '@bettertrack/contracts';

vi.mock('../../../lib/cashApi', () => ({
  CASH_TAGS_QUERY_KEY: ['cash', 'tags'],
  listCashTags: vi.fn(),
  createCashTag: vi.fn(),
  updateCashTag: vi.fn(),
  deleteCashTag: vi.fn(),
}));

import { createCashTag, deleteCashTag, listCashTags, updateCashTag } from '../../../lib/cashApi';
import { ApiError } from '../../../lib/apiClient';

import { CashTagsPage } from './CashTagsPage';

const INVESTMENT: CashTag = {
  id: 'sys-investment',
  name: 'Investment',
  color: '#6366f1',
  system: true,
  systemKey: 'investment',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const FOOD: CashTag = {
  id: 'usr-food',
  name: 'Food',
  color: '#22c55e',
  system: false,
  systemKey: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CashTagsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listCashTags).mockResolvedValue({ tags: [INVESTMENT, FOOD] });
});

describe('CashTagsPage', () => {
  test('never offers delete for a system tag, only rename/re-tint', async () => {
    renderPage();

    const systemRow = (await screen.findByText('Investment')).closest('li')!;
    expect(within(systemRow).getByText('App-owned')).toBeInTheDocument();
    expect(within(systemRow).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(systemRow).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  test('offers edit and delete for a user tag', async () => {
    renderPage();

    const userRow = (await screen.findByText('Food')).closest('li')!;
    expect(within(userRow).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(userRow).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  test('the delete confirmation states that budgets and rule links cascade away', async () => {
    const user = userEvent.setup();
    renderPage();

    const userRow = (await screen.findByText('Food')).closest('li')!;
    await user.click(within(userRow).getByRole('button', { name: 'Delete' }));

    expect(
      within(userRow).getByText('Delete “Food”? Its budgets and rule links go with it.'),
    ).toBeInTheDocument();
    await user.click(within(userRow).getByRole('button', { name: 'Confirm' }));
    expect(deleteCashTag).toHaveBeenCalledWith(FOOD.id);
  });

  test('creates a tag with a name and colour', async () => {
    vi.mocked(createCashTag).mockResolvedValue({
      tag: { ...FOOD, id: 'usr-new', name: 'Transport' },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New tag' }));
    const dialog = screen.getByRole('dialog', { name: 'New tag' });
    await user.type(within(dialog).getByLabelText('Name'), 'Transport');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(createCashTag).toHaveBeenCalledWith(expect.objectContaining({ name: 'Transport' }));
  });

  test('surfaces a taken-name 409 inline rather than a generic error', async () => {
    vi.mocked(updateCashTag).mockRejectedValue(new ApiError(409, 'CASH_TAG_NAME_TAKEN', 'taken'));
    const user = userEvent.setup();
    renderPage();

    const userRow = (await screen.findByText('Food')).closest('li')!;
    await user.click(within(userRow).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit tag' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('You already have a tag with that name.')).toBeInTheDocument();
  });

  test('renders a load error when tags fail to load', async () => {
    vi.mocked(listCashTags).mockRejectedValue(new Error('offline'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your tags.");
  });
});
